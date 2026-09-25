import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PoolClient, QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import { ReservationExpirationService } from '../inventory/reservation-expiration.service';
import { CreatePaymentAttemptDto } from './dto/create-payment-attempt.dto';
import {
  PAYMENT_GATEWAY,
  PaymentGateway,
  ProviderTransaction,
  ProviderTransactionStatus,
  VerifiedProviderEvent,
} from './payment-gateway.contract';
import {
  PaymentGatewayConfigurationError,
  PaymentGatewayRejectedError,
  PaymentGatewayUnavailableError,
} from './payment-gateway.errors';
import { PaymentAttemptView } from './payment-attempt.view';
import { ProviderEventEnvelope, verifyProviderEvent } from './payment-signatures';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const PAYMENT_RETRY_WINDOW_SECONDS = 600;
const RECONCILIATION_INTERVAL_MS = 30_000;
const RECONCILIATION_LEASE_SECONDS = 25;
const RECONCILIATION_BATCH_SIZE = 5;
const DISPATCH_STALE_SECONDS = 20;
const EVENT_MAX_AGE_SECONDS = 48 * 60 * 60;
const PAYMENT_RELEVANT_STATES = ['DISPATCHING', 'PENDING', 'UNKNOWN_OUTCOME', 'APPROVED', 'DECLINED', 'ERROR', 'VOIDED'];

interface CheckoutPaymentData extends QueryResultRow {
  id: string;
  state: string;
  total_minor: string;
  currency: string;
  customer_email: string | null;
}

interface CheckoutForPayment extends CheckoutPaymentData {
  reservation_state: 'HELD' | 'RELEASED' | 'COMMITTED';
  reservation_expires_at: Date;
}

interface AttemptRow extends QueryResultRow {
  id: string;
  checkout_id: string;
  attempt_number: number;
  state: PaymentAttemptView['state'];
  idempotency_key_hash: string;
  request_fingerprint_hash: string | null;
  provider_reference: string;
  provider_transaction_id: string | null;
  amount_cop: string;
  currency: string;
  provider_status: ProviderTransactionStatus | null;
  provider_status_updated_at: Date | null;
  last_reconciled_at: Date | null;
  reconciliation_lease_until: Date | null;
  manual_review_required_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface AttemptPaymentData extends QueryResultRow {
  id: string;
  checkout_id: string;
  attempt_number: number;
  state: PaymentAttemptView['state'];
  provider_reference: string;
  provider_transaction_id: string | null;
  amount_cop: string;
  currency: string;
  provider_status: ProviderTransactionStatus | null;
  provider_status_updated_at: Date | null;
  request_fingerprint_hash: string | null;
}

interface AttemptContext extends AttemptPaymentData {
  reservation_id: string;
  reservation_state: 'HELD' | 'RELEASED' | 'COMMITTED';
  reservation_expires_at: Date;
  reservation_expired: boolean;
  reservation_product_id: string;
  reservation_quantity: number;
  checkout_state: string;
}

interface ReconciliationCandidate extends QueryResultRow {
  id: string;
  provider_transaction_id: string | null;
  state: PaymentAttemptView['state'];
  created_at: Date;
  dispatch_started_at: Date | null;
}

interface AttemptResult {
  attempt: PaymentAttemptView;
  replayed: boolean;
}

type EventDisposition =
  | 'APPLIED'
  | 'DUPLICATE'
  | 'UNMATCHED'
  | 'MISMATCH'
  | 'STALE'
  | 'CONTRADICTORY'
  | 'IGNORED';

@Injectable()
export class PaymentsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentsService.name);
  private timer?: NodeJS.Timeout;
  private activeReconciliation?: Promise<void>;

  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService,
    private readonly reservationExpiration: ReservationExpirationService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => this.scheduleReconciliation(), RECONCILIATION_INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.activeReconciliation;
  }

  async createAttempt(
    sessionId: string,
    checkoutId: string,
    rawIdempotencyKey: string | undefined,
    dto: CreatePaymentAttemptDto,
  ): Promise<AttemptResult> {
    if (!rawIdempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(rawIdempotencyKey)) {
      throw new BadRequestException(
        'Idempotency-Key must contain 16 to 128 permitted characters.',
      );
    }

    const idempotencyKeyHash = this.hash(rawIdempotencyKey);
    const requestFingerprintHash = this.hash(
      JSON.stringify([
        dto.paymentToken,
        dto.acceptanceToken,
        dto.personalDataAuthorizationToken,
        dto.installments ?? 1,
      ]),
    );

    const prepared = await this.database.transaction(async (client) => {
      await this.reservationExpiration.releaseExpired(client);
      const checkout = await this.lockCheckout(client, sessionId, checkoutId);
      if (!checkout) throw new NotFoundException('Checkout not found.');

      const replay = await client.query<AttemptRow>(
        `
          SELECT *
          FROM payment_attempts
          WHERE checkout_id = $1 AND idempotency_key_hash = $2
          FOR UPDATE
        `,
        [checkoutId, idempotencyKeyHash],
      );
      const prior = replay.rows[0];
      if (prior) {
        if (prior.request_fingerprint_hash === null) {
          throw new GoneException('This payment replay window has expired.');
        }
        if (prior.request_fingerprint_hash !== requestFingerprintHash) {
          throw new ConflictException(
            'Idempotency-Key was already used with a different payment request.',
          );
        }
        return { attempt: this.toView(prior), replayed: true, context: null };
      }

      if (!['RESERVED', 'PAYMENT_FAILED'].includes(checkout.state)) {
        throw new ConflictException('Checkout is not eligible for a payment attempt.');
      }
      if (checkout.reservation_state !== 'HELD' || checkout.reservation_expires_at <= new Date()) {
        throw new ConflictException('The inventory reservation has expired.');
      }
      if (!checkout.customer_email) {
        throw new GoneException('The checkout payment data is no longer available.');
      }

      const history = await client.query<{
        attempt_number: number;
        state: PaymentAttemptView['state'];
      }>(
        `
          SELECT attempt_number, state
          FROM payment_attempts
          WHERE checkout_id = $1
          ORDER BY attempt_number
          FOR UPDATE
        `,
        [checkoutId],
      );
      if (history.rows.some(({ state }) => ['CREATED', 'DISPATCHING', 'PENDING', 'UNKNOWN_OUTCOME'].includes(state))) {
        throw new ConflictException('An existing payment attempt must be reconciled first.');
      }

      const chargeAttempts = history.rows.filter(({ state }) =>
        PAYMENT_RELEVANT_STATES.includes(state),
      );
      const confirmedFailures = history.rows.filter(({ state }) =>
        state === 'DECLINED' || state === 'ERROR',
      ).length;
      if (confirmedFailures >= 2 || chargeAttempts.length >= 2) {
        throw new ConflictException('The permitted payment retry has already been used.');
      }
      if (
        history.rows.some(({ state }) => ['APPROVED', 'VOIDED'].includes(state)) ||
        checkout.state === 'PAID' ||
        checkout.state === 'CANCELLED'
      ) {
        throw new ConflictException('Checkout is already closed for payment.');
      }

      const attemptNumber = (history.rows.at(-1)?.attempt_number ?? 0) + 1;
      if (attemptNumber > 10) {
        throw new ConflictException('No further payment attempts are permitted.');
      }
      const reference = `pfl_${randomUUID()}`;
      const inserted = await client.query<AttemptRow>(
        `
          INSERT INTO payment_attempts (
            checkout_id, attempt_number, state, idempotency_key_hash,
            request_fingerprint_hash, provider_reference, amount_cop, currency,
            dispatch_started_at
          )
          VALUES ($1, $2, 'DISPATCHING', $3, $4, $5, $6, $7, now())
          RETURNING *
        `,
        [
          checkoutId,
          attemptNumber,
          idempotencyKeyHash,
          requestFingerprintHash,
          reference,
          checkout.total_minor,
          checkout.currency.trim(),
        ],
      );
      const attempt = inserted.rows[0];
      if (!attempt) throw new Error('Payment attempt was not persisted.');

      await client.query(
        `
          UPDATE checkouts
          SET state = 'PAYMENT_PENDING', updated_at = now()
          WHERE id = $1 AND state IN ('RESERVED', 'PAYMENT_FAILED')
        `,
        [checkoutId],
      );

      return {
        attempt: this.toView(attempt),
        replayed: false,
        context: {
          attemptId: attempt.id,
          reference,
          amountCop: Number(checkout.total_minor),
          currency: checkout.currency.trim() as 'COP',
          customerEmail: checkout.customer_email,
        },
      };
    });

    if (prepared.replayed || !prepared.context) {
      return { attempt: prepared.attempt, replayed: true };
    }

    let transaction: ProviderTransaction;
    try {
      transaction = await this.gateway.createTransaction({
        acceptanceToken: dto.acceptanceToken,
        personalDataAuthorizationToken: dto.personalDataAuthorizationToken,
        amountCop: prepared.context.amountCop,
        currency: prepared.context.currency,
        customerEmail: prepared.context.customerEmail,
        installments: dto.installments ?? 1,
        paymentToken: dto.paymentToken,
        reference: prepared.context.reference,
      });
    } catch (error) {
      if (error instanceof PaymentGatewayConfigurationError) {
        await this.markLocalFailure(prepared.context.attemptId);
      } else if (error instanceof PaymentGatewayRejectedError) {
        await this.markRejected(prepared.context.attemptId, error.httpStatus);
      } else {
        await this.markUnknown(prepared.context.attemptId);
      }
      return {
        attempt: await this.readAttempt(sessionId, checkoutId, prepared.context.attemptId),
        replayed: false,
      };
    }

    const disposition = await this.applyTransactionResult(
      transaction,
      new Date(),
      prepared.context.attemptId,
    );
    if (disposition === 'MISMATCH') {
      await this.markManualReview(prepared.context.attemptId);
    }
    return {
      attempt: await this.readAttempt(sessionId, checkoutId, prepared.context.attemptId),
      replayed: false,
    };
  }

  async getAttempt(
    sessionId: string,
    checkoutId: string,
    attemptId: string,
  ): Promise<PaymentAttemptView> {
    const initial = await this.readAttempt(sessionId, checkoutId, attemptId);
    const context = await this.database.query<{
      provider_transaction_id: string | null;
      last_reconciled_at: Date | null;
      created_at: Date;
      state: PaymentAttemptView['state'];
    }>(
      `
        SELECT provider_transaction_id, last_reconciled_at, created_at, state
        FROM payment_attempts
        WHERE id = $1 AND checkout_id = $2
      `,
      [attemptId, checkoutId],
    );
    const row = context.rows[0];
    if (!row) throw new NotFoundException('Payment attempt not found.');

    if (
      row.provider_transaction_id &&
      ['DISPATCHING', 'PENDING', 'UNKNOWN_OUTCOME'].includes(row.state) &&
      this.shouldReconcile(row.last_reconciled_at)
    ) {
      await this.reconcileById(attemptId, row.provider_transaction_id);
      if (this.reviewIsDue(row.created_at)) {
        await this.markManualReview(attemptId);
      }
      return this.readAttempt(sessionId, checkoutId, attemptId);
    }

    if (
      ['DISPATCHING', 'PENDING', 'UNKNOWN_OUTCOME'].includes(row.state) &&
      this.reviewIsDue(row.created_at)
    ) {
      await this.markManualReview(attemptId);
      return this.readAttempt(sessionId, checkoutId, attemptId);
    }
    return initial;
  }

  async getLatestAttempt(
    sessionId: string,
    checkoutId: string,
  ): Promise<PaymentAttemptView> {
    const latest = await this.database.query<{ id: string }>(
      `
        SELECT attempt.id
        FROM payment_attempts AS attempt
        JOIN checkouts AS checkout ON checkout.id = attempt.checkout_id
        WHERE checkout.id = $1 AND checkout.guest_session_id = $2
        ORDER BY attempt.attempt_number DESC
        LIMIT 1
      `,
      [checkoutId, sessionId],
    );
    const attemptId = latest.rows[0]?.id;
    if (!attemptId) throw new NotFoundException('No payment attempt exists for this checkout.');
    return this.getAttempt(sessionId, checkoutId, attemptId);
  }

  async receiveEvent(
    envelope: unknown,
    headerChecksum?: string,
  ): Promise<void> {
    const environment = this.config.getOrThrow<'test' | 'prod'>(
      'PAYMENT_GATEWAY_ENVIRONMENT',
    );
    if (environment !== 'test') {
      throw new ServiceUnavailableException(
        'Only sandbox payment events are accepted by this application.',
      );
    }
    const eventSecret = this.config.get<string>('PAYMENT_GATEWAY_EVENTS_SECRET')?.trim();
    if (!eventSecret) {
      throw new ServiceUnavailableException('Payment event verification is not configured.');
    }

    let event: VerifiedProviderEvent;
    try {
      event = verifyProviderEvent(
        asEventEnvelope(envelope),
        eventSecret,
        environment,
        headerChecksum,
      );
    } catch {
      throw new BadRequestException('Payment event signature or shape is invalid.');
    }

    const ageSeconds = (Date.now() - event.occurredAt.getTime()) / 1000;
    if (ageSeconds > EVENT_MAX_AGE_SECONDS || ageSeconds < -60) {
      throw new BadRequestException('Payment event timestamp is outside the accepted window.');
    }

    await this.database.transaction(async (client) => {
      const receipt = await client.query<{ id: string }>(
        `
          INSERT INTO payment_event_receipts (
            event_fingerprint, provider_transaction_id, provider_reference,
            provider_status, amount_in_cents, currency, event_occurred_at,
            disposition
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'IGNORED')
          ON CONFLICT (event_fingerprint) DO NOTHING
          RETURNING id
        `,
        [
          event.fingerprint,
          event.transactionId,
          event.reference,
          event.status,
          event.amountInCents,
          event.currency,
          event.occurredAt,
        ],
      );
      const receiptId = receipt.rows[0]?.id;
      if (!receiptId) return;

      const attempt = await client.query<{ id: string }>(
        'SELECT id FROM payment_attempts WHERE provider_reference = $1',
        [event.reference],
      );
      const attemptId = attempt.rows[0]?.id;
      if (!attemptId) {
        await this.setReceiptDisposition(client, receiptId, null, 'UNMATCHED');
        return;
      }

      const disposition = await this.applyTransactionInTransaction(
        client,
        this.toProviderTransaction(event),
        event.occurredAt,
        attemptId,
      );
      await this.setReceiptDisposition(client, receiptId, attemptId, disposition);
    });
  }

  private async lockCheckout(
    client: PoolClient,
    sessionId: string,
    checkoutId: string,
  ): Promise<CheckoutForPayment | null> {
    const checkout = await client.query<CheckoutPaymentData>(
      `
        SELECT c.id, c.state, c.total_minor, c.currency,
               customer.email AS customer_email
        FROM checkouts AS c
        JOIN customers AS customer ON customer.id = c.customer_id
        WHERE c.id = $1 AND c.guest_session_id = $2
        FOR UPDATE OF c
      `,
      [checkoutId, sessionId],
    );
    const lockedCheckout = checkout.rows[0];
    if (!lockedCheckout) return null;

    const reservation = await client.query<{
      state: CheckoutForPayment['reservation_state'];
      expires_at: Date;
    }>(
      `SELECT state, expires_at
       FROM reservations
       WHERE checkout_id = $1
       FOR UPDATE`,
      [checkoutId],
    );
    const lockedReservation = reservation.rows[0];
    if (!lockedReservation) return null;

    return {
      ...lockedCheckout,
      reservation_state: lockedReservation.state,
      reservation_expires_at: lockedReservation.expires_at,
    };
  }

  private async markLocalFailure(attemptId: string): Promise<void> {
    await this.database.transaction(async (client) => {
      const row = await this.lockAttemptContext(client, attemptId);
      if (!row || row.state !== 'DISPATCHING') return;
      await client.query(
        `
          UPDATE payment_attempts
          SET state = 'FAILED_LOCAL', reconciliation_lease_until = NULL,
              updated_at = now()
          WHERE id = $1
        `,
        [attemptId],
      );
      await client.query(
        `UPDATE checkouts SET state = 'RESERVED', updated_at = now()
         WHERE id = $1 AND state = 'PAYMENT_PENDING'`,
        [row.checkout_id],
      );
    });
  }

  private async markRejected(attemptId: string, httpStatus: number): Promise<void> {
    await this.database.transaction(async (client) => {
      const row = await this.lockAttemptContext(client, attemptId);
      if (!row || row.state !== 'DISPATCHING') return;
      await client.query(
        `
          UPDATE payment_attempts
          SET state = 'REJECTED_NO_TRANSACTION',
              provider_http_status = $2,
              reconciliation_lease_until = NULL,
              updated_at = now()
          WHERE id = $1
        `,
        [attemptId, httpStatus],
      );
      await client.query(
        `UPDATE checkouts SET state = 'RESERVED', updated_at = now()
         WHERE id = $1 AND state = 'PAYMENT_PENDING'`,
        [row.checkout_id],
      );
    });
  }

  private async markUnknown(attemptId: string): Promise<void> {
    await this.database.transaction(async (client) => {
      const row = await this.lockAttemptContext(client, attemptId);
      if (!row || row.state !== 'DISPATCHING') return;
      await client.query(
        `
          UPDATE payment_attempts
          SET state = 'UNKNOWN_OUTCOME', unknown_outcome_at = now(),
              reconciliation_lease_until = NULL,
              updated_at = now()
          WHERE id = $1
        `,
        [attemptId],
      );
      await client.query(
        `UPDATE checkouts SET state = 'UNKNOWN_OUTCOME', updated_at = now()
         WHERE id = $1 AND state = 'PAYMENT_PENDING'`,
        [row.checkout_id],
      );
    });
  }

  private async applyTransactionResult(
    transaction: ProviderTransaction,
    occurredAt: Date,
    attemptId: string,
  ): Promise<EventDisposition> {
    return this.database.transaction((client) =>
      this.applyTransactionInTransaction(client, transaction, occurredAt, attemptId),
    );
  }

  private async applyTransactionInTransaction(
    client: PoolClient,
    transaction: ProviderTransaction,
    occurredAt: Date,
    attemptId: string,
  ): Promise<EventDisposition> {
    const attempt = await this.lockAttemptContext(client, attemptId);
    if (!attempt) return 'UNMATCHED';

    const expectedAmountInCents = BigInt(attempt.amount_cop) * 100n;
    if (
      transaction.reference !== attempt.provider_reference ||
      BigInt(transaction.amountInCents) !== expectedAmountInCents ||
      transaction.currency !== attempt.currency.trim() ||
      (attempt.provider_transaction_id &&
        attempt.provider_transaction_id !== transaction.id)
    ) {
      await client.query(
        `UPDATE payment_attempts
         SET state = CASE WHEN state = 'DISPATCHING' THEN 'UNKNOWN_OUTCOME' ELSE state END,
             unknown_outcome_at = CASE WHEN state = 'DISPATCHING' THEN now() ELSE unknown_outcome_at END,
             manual_review_required_at = COALESCE(manual_review_required_at, now()),
             reconciliation_lease_until = NULL, last_reconciled_at = now(),
             updated_at = now() WHERE id = $1`,
        [attemptId],
      );
      if (attempt.state === 'DISPATCHING') {
        await client.query(
          `UPDATE checkouts SET state = 'UNKNOWN_OUTCOME', updated_at = now()
           WHERE id = $1 AND state = 'PAYMENT_PENDING'`,
          [attempt.checkout_id],
        );
      }
      return 'MISMATCH';
    }

    if (
      attempt.provider_status_updated_at &&
      occurredAt < attempt.provider_status_updated_at
    ) {
      await client.query(
        `UPDATE payment_attempts
         SET manual_review_required_at = CASE
               WHEN state IN ('APPROVED', 'DECLINED', 'ERROR', 'VOIDED')
                 AND provider_status IS DISTINCT FROM $2
               THEN COALESCE(manual_review_required_at, now())
               ELSE manual_review_required_at
             END,
             reconciliation_lease_until = NULL, last_reconciled_at = now(),
             updated_at = now() WHERE id = $1`,
        [attemptId, transaction.status],
      );
      return 'STALE';
    }

    if (attempt.state === 'APPROVED') {
      if (transaction.status === 'APPROVED') {
        await client.query(
          `UPDATE payment_attempts SET reconciliation_lease_until = NULL, updated_at = now() WHERE id = $1`,
          [attemptId],
        );
        return 'DUPLICATE';
      }
      await client.query(
        `UPDATE payment_attempts
         SET manual_review_required_at = COALESCE(manual_review_required_at, now()),
             reconciliation_lease_until = NULL, last_reconciled_at = now(), updated_at = now()
         WHERE id = $1`,
        [attemptId],
      );
      return 'CONTRADICTORY';
    }
    if (
      ['DECLINED', 'ERROR', 'VOIDED'].includes(attempt.state) &&
      attempt.provider_status === transaction.status
    ) {
      await client.query(
        `UPDATE payment_attempts SET reconciliation_lease_until = NULL, updated_at = now() WHERE id = $1`,
        [attemptId],
      );
      return 'DUPLICATE';
    }
    if (
      ['DECLINED', 'ERROR', 'VOIDED'].includes(attempt.state) &&
      transaction.status !== 'APPROVED' &&
      transaction.status !== 'VOIDED'
    ) {
      await client.query(
        `UPDATE payment_attempts
         SET manual_review_required_at = COALESCE(manual_review_required_at, now()),
             reconciliation_lease_until = NULL, last_reconciled_at = now(), updated_at = now()
         WHERE id = $1`,
        [attemptId],
      );
      return 'STALE';
    }

    const nextState = transaction.status;
    await client.query(
      `
        UPDATE payment_attempts
        SET state = $2, provider_status = $2,
            provider_transaction_id = COALESCE(provider_transaction_id, $3),
            provider_status_updated_at = $4,
            last_reconciled_at = now(),
            unknown_outcome_at = NULL,
            reconciliation_lease_until = NULL,
            updated_at = now()
        WHERE id = $1
      `,
      [attemptId, nextState, transaction.id, occurredAt],
    );

    if (nextState === 'PENDING') {
      if (!['EXPIRED', 'CANCELLED', 'PAID', 'FULFILLMENT_EXCEPTION'].includes(attempt.checkout_state)) {
        await client.query(
          `UPDATE checkouts SET state = 'PAYMENT_PENDING', updated_at = now() WHERE id = $1`,
          [attempt.checkout_id],
        );
      }
      return 'APPLIED';
    }

    if (nextState === 'APPROVED') {
      const retryWindowExpired =
        attempt.checkout_state === 'PAYMENT_FAILED' && attempt.reservation_expired;
      if (
        attempt.reservation_state === 'HELD' &&
        !['EXPIRED', 'CANCELLED'].includes(attempt.checkout_state) &&
        !retryWindowExpired
      ) {
        const inventory = await client.query(
          `
            UPDATE products
            SET physical_quantity = physical_quantity - $2,
                reserved_quantity = reserved_quantity - $2,
                updated_at = now()
            WHERE id = $1 AND physical_quantity >= $2 AND reserved_quantity >= $2
            RETURNING id
          `,
          [attempt.reservation_product_id, attempt.reservation_quantity],
        );
        if (inventory.rowCount !== 1) {
          throw new Error('Reserved inventory counters are inconsistent.');
        }
        const committed = await client.query(
          `UPDATE reservations SET state = 'COMMITTED', committed_at = now()
           WHERE id = $1 AND state = 'HELD' RETURNING id`,
          [attempt.reservation_id],
        );
        if (committed.rowCount !== 1) {
          throw new Error('Inventory reservation could not be committed.');
        }
        await client.query(
          `UPDATE checkouts SET state = 'PAID', updated_at = now() WHERE id = $1`,
          [attempt.checkout_id],
        );
        await client.query(
          `
            INSERT INTO fulfillments (checkout_id, state)
            VALUES ($1, 'READY')
            ON CONFLICT (checkout_id) DO NOTHING
          `,
          [attempt.checkout_id],
        );
      } else {
        if (attempt.reservation_state === 'HELD') {
          await this.releaseReservation(client, attempt.reservation_id);
        }
        await client.query(
          `UPDATE checkouts SET state = 'FULFILLMENT_EXCEPTION', updated_at = now() WHERE id = $1`,
          [attempt.checkout_id],
        );
        await client.query(
          `
            INSERT INTO fulfillments (checkout_id, state)
            VALUES ($1, 'FULFILLMENT_EXCEPTION')
            ON CONFLICT (checkout_id) DO UPDATE
              SET state = 'FULFILLMENT_EXCEPTION', updated_at = now()
          `,
          [attempt.checkout_id],
        );
      }
      return 'APPLIED';
    }

    if (nextState === 'DECLINED' || nextState === 'ERROR') {
      if (attempt.reservation_state === 'HELD' && !['PAID', 'CANCELLED'].includes(attempt.checkout_state)) {
        await this.handleConfirmedFailure(client, attempt.checkout_id, attempt.reservation_id);
      }
      return 'APPLIED';
    }

    if (nextState === 'VOIDED') {
      if (attempt.reservation_state === 'HELD') {
        await this.releaseReservation(client, attempt.reservation_id);
      }
      if (!['PAID', 'FULFILLMENT_EXCEPTION'].includes(attempt.checkout_state)) {
        await client.query(
          `UPDATE checkouts SET state = 'CANCELLED', reservation_expires_at = now(), updated_at = now() WHERE id = $1`,
          [attempt.checkout_id],
        );
      }
      return 'APPLIED';
    }

    return 'IGNORED';
  }

  private async lockAttemptContext(
    client: PoolClient,
    attemptId: string,
  ): Promise<AttemptContext | null> {
    const owner = await client.query<{ checkout_id: string }>(
      'SELECT checkout_id FROM payment_attempts WHERE id = $1',
      [attemptId],
    );
    const checkoutId = owner.rows[0]?.checkout_id;
    if (!checkoutId) return null;

    const checkout = await client.query<{ state: string }>(
      'SELECT state FROM checkouts WHERE id = $1 FOR UPDATE',
      [checkoutId],
    );
    const checkoutState = checkout.rows[0]?.state;
    if (!checkoutState) return null;

    const reservation = await client.query<{
      id: string;
      state: AttemptContext['reservation_state'];
      expires_at: Date;
      is_expired: boolean;
      product_id: string;
      quantity: number;
    }>(
      `SELECT id, state, expires_at, expires_at <= clock_timestamp() AS is_expired,
              product_id, quantity
       FROM reservations
       WHERE checkout_id = $1
       FOR UPDATE`,
      [checkoutId],
    );
    const lockedReservation = reservation.rows[0];
    if (!lockedReservation) return null;

    const attempt = await client.query<AttemptPaymentData>(
      `
        SELECT attempt.id, attempt.checkout_id, attempt.attempt_number,
               attempt.state, attempt.provider_reference,
               attempt.provider_transaction_id, attempt.amount_cop,
               attempt.currency, attempt.provider_status,
               attempt.provider_status_updated_at, attempt.request_fingerprint_hash
        FROM payment_attempts AS attempt
        WHERE attempt.id = $1 AND attempt.checkout_id = $2
        FOR UPDATE
      `,
      [attemptId, checkoutId],
    );
    const lockedAttempt = attempt.rows[0];
    if (!lockedAttempt) return null;

    return {
      ...lockedAttempt,
      reservation_id: lockedReservation.id,
      reservation_state: lockedReservation.state,
      reservation_expires_at: lockedReservation.expires_at,
      reservation_expired: lockedReservation.is_expired,
      reservation_product_id: lockedReservation.product_id,
      reservation_quantity: lockedReservation.quantity,
      checkout_state: checkoutState,
    };
  }

  private async extendRetryWindow(
    client: PoolClient,
    checkoutId: string,
    reservationId: string,
  ): Promise<void> {
    const reservation = await client.query(
      `
        UPDATE reservations
        SET expires_at = now() + ($2 * interval '1 second')
        WHERE id = $1 AND state = 'HELD'
      `,
      [reservationId, PAYMENT_RETRY_WINDOW_SECONDS],
    );
    if (reservation.rowCount === 1) {
      await client.query(
        `UPDATE checkouts SET reservation_expires_at = now() + ($2 * interval '1 second')
         WHERE id = $1`,
        [checkoutId, PAYMENT_RETRY_WINDOW_SECONDS],
      );
    }
  }

  private async handleConfirmedFailure(
    client: PoolClient,
    checkoutId: string,
    reservationId: string,
  ): Promise<void> {
    const dispatched = await client.query<{ attempt_count: number }>(
      `
        SELECT count(*)::int AS attempt_count
        FROM payment_attempts
        WHERE checkout_id = $1
          AND state IN (
            'DISPATCHING', 'PENDING', 'UNKNOWN_OUTCOME',
            'APPROVED', 'DECLINED', 'ERROR', 'VOIDED'
          )
      `,
      [checkoutId],
    );
    if ((dispatched.rows[0]?.attempt_count ?? 0) >= 2) {
      await this.releaseReservation(client, reservationId);
      await client.query(
        `UPDATE checkouts
         SET state = 'PAYMENT_FAILED', reservation_expires_at = now(), updated_at = now()
         WHERE id = $1`,
        [checkoutId],
      );
      return;
    }

    await this.extendRetryWindow(client, checkoutId, reservationId);
    await client.query(
      `UPDATE checkouts SET state = 'PAYMENT_FAILED', updated_at = now() WHERE id = $1`,
      [checkoutId],
    );
  }

  private async releaseReservation(client: PoolClient, reservationId: string): Promise<void> {
    const released = await client.query<{ product_id: string; quantity: number }>(
      `UPDATE reservations SET state = 'RELEASED', released_at = now()
       WHERE id = $1 AND state = 'HELD' RETURNING product_id, quantity`,
      [reservationId],
    );
    const reservation = released.rows[0];
    if (!reservation) return;
    const inventory = await client.query(
      `UPDATE products SET reserved_quantity = reserved_quantity - $2, updated_at = now()
       WHERE id = $1 AND reserved_quantity >= $2 RETURNING id`,
      [reservation.product_id, reservation.quantity],
    );
    if (inventory.rowCount !== 1) {
      throw new Error('Reserved inventory counters are inconsistent.');
    }
  }

  private async setReceiptDisposition(
    client: PoolClient,
    receiptId: string,
    attemptId: string | null,
    disposition: EventDisposition,
  ): Promise<void> {
    await client.query(
      `UPDATE payment_event_receipts
       SET payment_attempt_id = $2, disposition = $3 WHERE id = $1`,
      [receiptId, attemptId, disposition],
    );
  }

  private toProviderTransaction(event: VerifiedProviderEvent): ProviderTransaction {
    return {
      id: event.transactionId,
      reference: event.reference,
      amountInCents: event.amountInCents,
      currency: event.currency,
      status: event.status,
    };
  }

  private async readAttempt(
    sessionId: string,
    checkoutId: string,
    attemptId: string,
  ): Promise<PaymentAttemptView> {
    const result = await this.database.query<AttemptRow>(
      `
        SELECT attempt.*
        FROM payment_attempts AS attempt
        JOIN checkouts AS checkout ON checkout.id = attempt.checkout_id
        WHERE attempt.id = $1 AND attempt.checkout_id = $2
          AND checkout.guest_session_id = $3
      `,
      [attemptId, checkoutId, sessionId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Payment attempt not found.');
    return this.toView(row);
  }

  private toView(row: AttemptRow): PaymentAttemptView {
    return {
      attemptId: row.id,
      checkoutId: row.checkout_id,
      attemptNumber: row.attempt_number,
      state: row.state,
      amountCop: Number(row.amount_cop),
      currency: row.currency.trim(),
      manualReviewRequired: row.manual_review_required_at !== null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private async markManualReview(attemptId: string): Promise<void> {
    await this.database.query(
      `UPDATE payment_attempts
       SET manual_review_required_at = COALESCE(manual_review_required_at, now()), updated_at = now()
       WHERE id = $1 AND state IN ('DISPATCHING', 'PENDING', 'UNKNOWN_OUTCOME')`,
      [attemptId],
    );
  }

  private async reconcileById(attemptId: string, providerTransactionId: string): Promise<void> {
    try {
      const transaction = await this.gateway.getTransaction(providerTransactionId);
      await this.applyTransactionResult(transaction, new Date(), attemptId);
    } catch (error) {
      if (!(error instanceof PaymentGatewayUnavailableError)) {
        const kind = error instanceof Error ? error.name : 'UnknownError';
        this.logger.warn(`Payment reconciliation deferred (${kind}).`);
      }
      await this.database.query(
        `UPDATE payment_attempts SET last_reconciled_at = now(), reconciliation_lease_until = NULL
         WHERE id = $1 AND state IN ('DISPATCHING', 'PENDING', 'UNKNOWN_OUTCOME')`,
        [attemptId],
      );
    }
  }

  private scheduleReconciliation(): void {
    if (this.activeReconciliation) return;
    this.activeReconciliation = this.reconcileDueAttempts()
      .catch((error: unknown) => {
        const kind = error instanceof Error ? error.name : 'UnknownError';
        this.logger.error(`Payment reconciliation batch failed (${kind}).`);
      })
      .finally(() => {
        this.activeReconciliation = undefined;
      });
  }

  private async reconcileDueAttempts(): Promise<void> {
    await this.purgeExpiredEventReceipts();
    const candidates = await this.database.transaction(async (client) => {
      const result = await client.query<ReconciliationCandidate>(
        `
          SELECT id, provider_transaction_id, state, created_at, dispatch_started_at
          FROM payment_attempts
          WHERE state IN ('DISPATCHING', 'PENDING', 'UNKNOWN_OUTCOME')
            AND (reconciliation_lease_until IS NULL OR reconciliation_lease_until <= now())
            AND (last_reconciled_at IS NULL OR last_reconciled_at <= now() - interval '30 seconds')
          ORDER BY COALESCE(last_reconciled_at, created_at), id
          LIMIT ${RECONCILIATION_BATCH_SIZE}
          FOR UPDATE SKIP LOCKED
        `,
      );
      for (const candidate of result.rows) {
        await client.query(
          `UPDATE payment_attempts SET reconciliation_lease_until = now() + ($2 * interval '1 second')
           WHERE id = $1`,
          [candidate.id, RECONCILIATION_LEASE_SECONDS],
        );
      }
      return result.rows;
    });

    const outcomes = await Promise.allSettled(candidates.map(async (candidate) => {
      if (candidate.provider_transaction_id) {
        await this.reconcileById(candidate.id, candidate.provider_transaction_id);
        if (this.reviewIsDue(candidate.created_at)) {
          await this.markManualReview(candidate.id);
        }
        return;
      }
      if (
        candidate.state === 'DISPATCHING' &&
        candidate.dispatch_started_at &&
        Date.now() - candidate.dispatch_started_at.getTime() >= DISPATCH_STALE_SECONDS * 1000
      ) {
        await this.markUnknown(candidate.id);
      }
      if (this.reviewIsDue(candidate.created_at)) {
        await this.markManualReview(candidate.id);
      }
      await this.database.query(
        `UPDATE payment_attempts SET last_reconciled_at = now(), reconciliation_lease_until = NULL
         WHERE id = $1`,
        [candidate.id],
      );
    }));
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        const kind = outcome.reason instanceof Error ? outcome.reason.name : 'UnknownError';
        this.logger.warn(`Payment reconciliation candidate deferred (${kind}).`);
      }
    }
  }

  async purgeExpiredEventReceipts(): Promise<number> {
    const retentionDays = this.config.get<number>('PAYMENT_EVENT_RECEIPT_RETENTION_DAYS') ?? 365;
    const result = await this.database.query<{ id: string }>(
      `
        WITH expired AS MATERIALIZED (
          SELECT id
          FROM payment_event_receipts
          WHERE received_at < now() - ($1 * interval '1 day')
          ORDER BY received_at, id
          LIMIT 500
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM payment_event_receipts AS receipt
        USING expired
        WHERE receipt.id = expired.id
        RETURNING receipt.id
      `,
      [retentionDays],
    );
    return result.rowCount ?? 0;
  }

  private shouldReconcile(lastReconciledAt: Date | null): boolean {
    return !lastReconciledAt || Date.now() - lastReconciledAt.getTime() >= 15_000;
  }

  private reviewThresholdSeconds(): number {
    return this.config.get<number>('PAYMENT_UNRESOLVED_REVIEW_THRESHOLD_SECONDS') ?? 1_800;
  }

  private reviewIsDue(createdAt: Date): boolean {
    const thresholdSeconds = this.reviewThresholdSeconds();
    return thresholdSeconds > 0 && Date.now() - createdAt.getTime() >= thresholdSeconds * 1000;
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}

function asEventEnvelope(value: unknown): ProviderEventEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a payment event object.');
  }
  return value as ProviderEventEnvelope;
}
