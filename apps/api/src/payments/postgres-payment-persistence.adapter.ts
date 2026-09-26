import { Injectable } from '@nestjs/common';
import { PoolClient, QueryResultRow } from 'pg';
import { Result } from '../core/result';
import { DatabaseService } from '../database/database.service';
import { PostgresReservationExpirationAdapter } from '../inventory/postgres-reservation-expiration.adapter';
import { PaymentAttemptView } from './payment-attempt.view';
import {
  PaymentAttemptContext,
  PaymentAttemptHistoryItem,
  PaymentAttemptInsert,
  PaymentCheckoutForAttempt,
  PaymentEventDisposition,
  PaymentEventReceipt,
  PaymentPersistencePort,
  PaymentReconciliationCandidate,
  PaymentTransactionPort,
  StoredPaymentAttempt,
} from './payment-persistence.port';
import { ProviderTransaction } from './payment-gateway.contract';

interface AttemptRow extends QueryResultRow {
  id: string; checkout_id: string; attempt_number: number; state: PaymentAttemptView['state'];
  request_fingerprint_hash: string | null; provider_reference: string;
  provider_transaction_id: string | null; amount_cop: string; currency: string;
  provider_response_received_at: Date | null; manual_review_required_at: Date | null;
  created_at: Date; updated_at: Date;
}

@Injectable()
export class PostgresPaymentPersistenceAdapter implements PaymentPersistencePort {
  constructor(
    private readonly database: DatabaseService,
    private readonly reservationExpiration: PostgresReservationExpirationAdapter,
  ) {}

  transaction<T>(work: (unitOfWork: PaymentTransactionPort) => Promise<T>): Promise<T> {
    return this.database.transaction((client) =>
      work(new PostgresPaymentUnitOfWork(client, this.reservationExpiration)),
    );
  }

  transactionResult<T, F>(work: (unitOfWork: PaymentTransactionPort) => Promise<Result<T, F>>): Promise<Result<T, F>> {
    return this.database.transactionResult((client) =>
      work(new PostgresPaymentUnitOfWork(client, this.reservationExpiration)),
    );
  }

  async findAttempt(sessionId: string, checkoutId: string, attemptId: string): Promise<PaymentAttemptView | null> {
    const result = await this.database.query<AttemptRow>(
      `SELECT attempt.* FROM payment_attempts AS attempt
       JOIN checkouts AS checkout ON checkout.id = attempt.checkout_id
       WHERE attempt.id = $1 AND attempt.checkout_id = $2 AND checkout.guest_session_id = $3`,
      [attemptId, checkoutId, sessionId],
    );
    return result.rows[0] ? this.toView(result.rows[0]) : null;
  }

  async findLatestAttemptId(sessionId: string, checkoutId: string): Promise<string | null> {
    const result = await this.database.query<{ id: string }>(
      `SELECT attempt.id FROM payment_attempts AS attempt
       JOIN checkouts AS checkout ON checkout.id = attempt.checkout_id
       WHERE checkout.id = $1 AND checkout.guest_session_id = $2
       ORDER BY attempt.attempt_number DESC LIMIT 1`,
      [checkoutId, sessionId],
    );
    return result.rows[0]?.id ?? null;
  }

  async findReconciliationState(checkoutId: string, attemptId: string) {
    const result = await this.database.query<{
      provider_transaction_id: string | null; last_reconciled_at: Date | null;
      created_at: Date; state: PaymentAttemptView['state'];
    }>(`SELECT provider_transaction_id, last_reconciled_at, created_at, state
        FROM payment_attempts WHERE id = $1 AND checkout_id = $2`, [attemptId, checkoutId]);
    const row = result.rows[0];
    return row ? {
      providerTransactionId: row.provider_transaction_id,
      lastReconciledAt: row.last_reconciled_at,
      createdAt: row.created_at,
      state: row.state,
    } : null;
  }

  async markManualReview(attemptId: string): Promise<void> {
    await this.database.query(
      `UPDATE payment_attempts SET manual_review_required_at = COALESCE(manual_review_required_at, now()), updated_at = now()
       WHERE id = $1 AND state IN ('DISPATCHING', 'PENDING', 'UNKNOWN_OUTCOME')`, [attemptId]);
  }

  async clearReconciliationAfterFailure(attemptId: string): Promise<void> {
    await this.database.query(
      `UPDATE payment_attempts SET last_reconciled_at = now(), reconciliation_lease_until = NULL
       WHERE id = $1 AND state IN ('DISPATCHING', 'PENDING', 'UNKNOWN_OUTCOME')`, [attemptId]);
  }

  async claimReconciliationCandidates(): Promise<PaymentReconciliationCandidate[]> {
    return this.database.transaction(async (client) => {
      const result = await client.query<{
        id: string; provider_transaction_id: string | null; state: PaymentAttemptView['state'];
        created_at: Date; dispatch_started_at: Date | null; provider_response_received_at: Date | null;
      }>(`
        SELECT id, provider_transaction_id, state, created_at, dispatch_started_at, provider_response_received_at
        FROM payment_attempts
        WHERE state IN ('DISPATCHING', 'PENDING', 'UNKNOWN_OUTCOME')
          AND (reconciliation_lease_until IS NULL OR reconciliation_lease_until <= now())
          AND (last_reconciled_at IS NULL OR last_reconciled_at <= now() - interval '30 seconds')
        ORDER BY COALESCE(last_reconciled_at, created_at), id
        LIMIT 5 FOR UPDATE SKIP LOCKED
      `);
      for (const candidate of result.rows) {
        await client.query(
          `UPDATE payment_attempts SET reconciliation_lease_until = now() + (25 * interval '1 second') WHERE id = $1`,
          [candidate.id],
        );
      }
      return result.rows.map((row) => ({
        id: row.id, providerTransactionId: row.provider_transaction_id, state: row.state,
        createdAt: row.created_at, dispatchStartedAt: row.dispatch_started_at,
        providerResponseReceivedAt: row.provider_response_received_at,
      }));
    });
  }

  async clearCandidateLease(candidateId: string): Promise<void> {
    await this.database.query(
      `UPDATE payment_attempts SET last_reconciled_at = now(), reconciliation_lease_until = NULL WHERE id = $1`,
      [candidateId],
    );
  }

  async purgeExpiredEventReceipts(retentionDays: number): Promise<number> {
    const result = await this.database.query<{ id: string }>(`
      WITH expired AS MATERIALIZED (
        SELECT id FROM payment_event_receipts
        WHERE received_at < now() - ($1 * interval '1 day')
        ORDER BY received_at, id LIMIT 500 FOR UPDATE SKIP LOCKED
      )
      DELETE FROM payment_event_receipts AS receipt USING expired
      WHERE receipt.id = expired.id RETURNING receipt.id
    `, [retentionDays]);
    return result.rowCount ?? 0;
  }

  private toView(row: AttemptRow): PaymentAttemptView {
    return {
      attemptId: row.id, checkoutId: row.checkout_id, attemptNumber: row.attempt_number,
      state: row.state,
      dispatching: (row.state === 'DISPATCHING' || row.state === 'PENDING') && row.provider_response_received_at === null,
      amountCop: Number(row.amount_cop), currency: row.currency.trim(),
      manualReviewRequired: row.manual_review_required_at !== null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }
}

class PostgresPaymentUnitOfWork implements PaymentTransactionPort {
  constructor(private readonly client: PoolClient, private readonly expiration: PostgresReservationExpirationAdapter) {}

  releaseExpiredReservations(): Promise<number> { return this.expiration.releaseExpired(this.client); }

  async lockCheckoutForAttempt(sessionId: string, checkoutId: string): Promise<PaymentCheckoutForAttempt | null> {
    const checkout = await this.client.query<{
      id: string; state: string; total_minor: string; currency: string; customer_email: string | null;
    }>(`SELECT c.id, c.state, c.total_minor, c.currency, customer.email AS customer_email
        FROM checkouts AS c JOIN customers AS customer ON customer.id = c.customer_id
        WHERE c.id = $1 AND c.guest_session_id = $2 FOR UPDATE OF c`, [checkoutId, sessionId]);
    const row = checkout.rows[0];
    if (!row) return null;
    const reservation = await this.client.query<{ state: PaymentCheckoutForAttempt['reservationState']; expires_at: Date }>(
      `SELECT state, expires_at FROM reservations WHERE checkout_id = $1 FOR UPDATE`, [checkoutId]);
    const reserved = reservation.rows[0];
    return reserved ? {
      id: row.id, state: row.state, totalMinor: row.total_minor, currency: row.currency,
      customerEmail: row.customer_email, reservationState: reserved.state,
      reservationExpiresAt: reserved.expires_at,
    } : null;
  }

  async findAttemptByIdempotencyKey(checkoutId: string, keyHash: string): Promise<StoredPaymentAttempt | null> {
    const result = await this.client.query<AttemptRow>(
      `SELECT * FROM payment_attempts WHERE checkout_id = $1 AND idempotency_key_hash = $2 FOR UPDATE`,
      [checkoutId, keyHash]);
    const row = result.rows[0];
    return row ? { view: this.toView(row), fingerprintHash: row.request_fingerprint_hash } : null;
  }

  listAttemptHistory(checkoutId: string): Promise<PaymentAttemptHistoryItem[]> {
    return this.client.query<PaymentAttemptHistoryItem>(
      `SELECT attempt_number AS "attemptNumber", state FROM payment_attempts
       WHERE checkout_id = $1 ORDER BY attempt_number FOR UPDATE`, [checkoutId],
    ).then((result) => result.rows);
  }

  async insertAttempt(input: PaymentAttemptInsert): Promise<PaymentAttemptView> {
    const result = await this.client.query<AttemptRow>(
      `INSERT INTO payment_attempts (
         checkout_id, attempt_number, state, idempotency_key_hash, request_fingerprint_hash,
         provider_reference, amount_cop, currency, dispatch_started_at
       ) VALUES ($1, $2, 'PENDING', $3, $4, $5, $6, $7, now()) RETURNING *`,
      [input.checkoutId, input.attemptNumber, input.idempotencyKeyHash, input.fingerprintHash,
       input.reference, input.amountCop, input.currency]);
    const row = result.rows[0];
    if (!row) throw new Error('Payment attempt was not persisted.');
    return this.toView(row);
  }

  async setCheckoutPaymentPending(checkoutId: string): Promise<void> {
    await this.client.query(
      `UPDATE checkouts SET state = 'PAYMENT_PENDING', updated_at = now()
       WHERE id = $1 AND state IN ('RESERVED', 'PAYMENT_FAILED')`, [checkoutId]);
  }

  async insertEventReceipt(event: PaymentEventReceipt): Promise<string | null> {
    const result = await this.client.query<{ id: string }>(
      `INSERT INTO payment_event_receipts (
         event_fingerprint, provider_transaction_id, provider_reference, provider_status,
         amount_in_cents, currency, event_occurred_at, disposition
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'IGNORED')
       ON CONFLICT (event_fingerprint) DO NOTHING RETURNING id`,
      [event.fingerprint, event.transactionId, event.reference, event.status,
       event.amountInCents, event.currency, event.occurredAt]);
    return result.rows[0]?.id ?? null;
  }

  async findAttemptIdByReference(reference: string): Promise<string | null> {
    const result = await this.client.query<{ id: string }>(
      `SELECT id FROM payment_attempts WHERE provider_reference = $1`, [reference]);
    return result.rows[0]?.id ?? null;
  }

  async setReceiptDisposition(receiptId: string, attemptId: string | null, disposition: PaymentEventDisposition): Promise<void> {
    await this.client.query(
      `UPDATE payment_event_receipts SET payment_attempt_id = $2, disposition = $3 WHERE id = $1`,
      [receiptId, attemptId, disposition]);
  }

  async lockAttemptContext(attemptId: string): Promise<PaymentAttemptContext | null> {
    const owner = await this.client.query<{ checkout_id: string }>(
      `SELECT checkout_id FROM payment_attempts WHERE id = $1`, [attemptId]);
    const checkoutId = owner.rows[0]?.checkout_id;
    if (!checkoutId) return null;
    const checkout = await this.client.query<{ state: string }>(
      `SELECT state FROM checkouts WHERE id = $1 FOR UPDATE`, [checkoutId]);
    const checkoutState = checkout.rows[0]?.state;
    if (!checkoutState) return null;
    const reservation = await this.client.query<{
      id: string; state: PaymentAttemptContext['reservationState']; expires_at: Date;
      reservation_expired: boolean; product_id: string; quantity: number;
    }>(`SELECT id, state, expires_at, expires_at <= clock_timestamp() AS reservation_expired,
               product_id, quantity FROM reservations WHERE checkout_id = $1 FOR UPDATE`, [checkoutId]);
    const held = reservation.rows[0];
    if (!held) return null;
    const attemptResult = await this.client.query<{
      id: string; checkout_id: string; attempt_number: number; state: PaymentAttemptView['state'];
      provider_reference: string; provider_transaction_id: string | null; amount_cop: string;
      currency: string; provider_status: PaymentAttemptContext['providerStatus'];
      provider_status_updated_at: Date | null; request_fingerprint_hash: string | null;
      provider_response_received_at: Date | null;
    }>(`SELECT id, checkout_id, attempt_number, state, provider_reference, provider_transaction_id,
               amount_cop, currency, provider_status, provider_status_updated_at,
               request_fingerprint_hash, provider_response_received_at
        FROM payment_attempts WHERE id = $1 AND checkout_id = $2 FOR UPDATE`, [attemptId, checkoutId]);
    const attempt = attemptResult.rows[0];
    if (!attempt) return null;
    return {
      id: attempt.id, checkoutId: attempt.checkout_id, attemptNumber: attempt.attempt_number,
      state: attempt.state, providerReference: attempt.provider_reference,
      providerTransactionId: attempt.provider_transaction_id, amountCop: attempt.amount_cop,
      currency: attempt.currency, providerStatus: attempt.provider_status,
      providerStatusUpdatedAt: attempt.provider_status_updated_at,
      requestFingerprintHash: attempt.request_fingerprint_hash,
      providerResponseReceivedAt: attempt.provider_response_received_at,
      reservationId: held.id, reservationState: held.state,
      reservationExpiresAt: held.expires_at, reservationExpired: held.reservation_expired,
      reservationProductId: held.product_id, reservationQuantity: held.quantity,
      checkoutState,
    };
  }

  async updateAttemptLocalState(attemptId: string, state: 'FAILED_LOCAL' | 'REJECTED_NO_TRANSACTION' | 'UNKNOWN_OUTCOME', httpStatus?: number): Promise<void> {
    await this.client.query(
      `UPDATE payment_attempts SET state = $2,
         provider_http_status = CASE WHEN $2 = 'REJECTED_NO_TRANSACTION' THEN $3 ELSE provider_http_status END,
         unknown_outcome_at = CASE WHEN $2 = 'UNKNOWN_OUTCOME' THEN now() ELSE unknown_outcome_at END,
         reconciliation_lease_until = NULL, updated_at = now() WHERE id = $1`,
      [attemptId, state, httpStatus ?? null]);
  }

  async setCheckoutAfterDispatchFailure(checkoutId: string, state: 'RESERVED' | 'UNKNOWN_OUTCOME'): Promise<void> {
    await this.client.query(`UPDATE checkouts SET state = $2, updated_at = now()
      WHERE id = $1 AND state = 'PAYMENT_PENDING'`, [checkoutId, state]);
  }

  async recordTransactionMismatch(attemptId: string, markUnknown: boolean): Promise<void> {
    await this.client.query(`UPDATE payment_attempts
      SET state = CASE WHEN $2 THEN 'UNKNOWN_OUTCOME' ELSE state END,
          unknown_outcome_at = CASE WHEN $2 THEN now() ELSE unknown_outcome_at END,
          provider_response_received_at = COALESCE(provider_response_received_at, now()),
          manual_review_required_at = COALESCE(manual_review_required_at, now()),
          reconciliation_lease_until = NULL, last_reconciled_at = now(), updated_at = now()
      WHERE id = $1`, [attemptId, markUnknown]);
    if (markUnknown) {
      await this.client.query(`UPDATE checkouts SET state = 'UNKNOWN_OUTCOME', updated_at = now()
        WHERE id = (SELECT checkout_id FROM payment_attempts WHERE id = $1)
          AND state = 'PAYMENT_PENDING'`, [attemptId]);
    }
  }

  async recordStaleTransaction(attemptId: string, terminalConflict: boolean): Promise<void> {
    await this.client.query(`UPDATE payment_attempts
      SET manual_review_required_at = CASE WHEN $2 THEN COALESCE(manual_review_required_at, now()) ELSE manual_review_required_at END,
          reconciliation_lease_until = NULL, last_reconciled_at = now(), updated_at = now()
      WHERE id = $1`, [attemptId, terminalConflict]);
  }

  async clearAttemptLease(attemptId: string): Promise<void> {
    await this.client.query(`UPDATE payment_attempts SET reconciliation_lease_until = NULL, updated_at = now() WHERE id = $1`, [attemptId]);
  }

  async updateAttemptFromProvider(transaction: ProviderTransaction, occurredAt: Date, attemptId: string): Promise<void> {
    await this.client.query(`UPDATE payment_attempts
      SET state = $2, provider_status = $2,
          provider_transaction_id = COALESCE(provider_transaction_id, $3),
          provider_status_updated_at = $4,
          provider_response_received_at = COALESCE(provider_response_received_at, now()),
          last_reconciled_at = now(), unknown_outcome_at = NULL,
          reconciliation_lease_until = NULL, updated_at = now()
      WHERE id = $1`, [attemptId, transaction.status, transaction.id, occurredAt]);
  }

  async setCheckoutPaymentPendingUnlessClosed(checkoutId: string): Promise<void> {
    await this.client.query(`UPDATE checkouts SET state = 'PAYMENT_PENDING', updated_at = now()
      WHERE id = $1 AND state NOT IN ('EXPIRED', 'CANCELLED', 'PAID', 'FULFILLMENT_EXCEPTION')`, [checkoutId]);
  }

  async commitHeldInventory(attempt: PaymentAttemptContext): Promise<void> {
    const inventory = await this.client.query(`UPDATE products
      SET physical_quantity = physical_quantity - $2, reserved_quantity = reserved_quantity - $2, updated_at = now()
      WHERE id = $1 AND physical_quantity >= $2 AND reserved_quantity >= $2 RETURNING id`,
    [attempt.reservationProductId, attempt.reservationQuantity]);
    if (inventory.rowCount !== 1) throw new Error('Reserved inventory counters are inconsistent.');
    const committed = await this.client.query(`UPDATE reservations SET state = 'COMMITTED', committed_at = now()
      WHERE id = $1 AND state = 'HELD' RETURNING id`, [attempt.reservationId]);
    if (committed.rowCount !== 1) throw new Error('Inventory reservation could not be committed.');
  }

  async setCheckoutPaid(checkoutId: string): Promise<void> {
    await this.client.query(`UPDATE checkouts SET state = 'PAID', updated_at = now() WHERE id = $1`, [checkoutId]);
  }

  async createReadyFulfillment(checkoutId: string): Promise<void> {
    await this.client.query(`INSERT INTO fulfillments (checkout_id, state) VALUES ($1, 'READY')
      ON CONFLICT (checkout_id) DO NOTHING`, [checkoutId]);
  }

  async setCheckoutFulfillmentException(checkoutId: string): Promise<void> {
    await this.client.query(`UPDATE checkouts SET state = 'FULFILLMENT_EXCEPTION', updated_at = now() WHERE id = $1`, [checkoutId]);
  }

  async upsertExceptionFulfillment(checkoutId: string): Promise<void> {
    await this.client.query(`INSERT INTO fulfillments (checkout_id, state) VALUES ($1, 'FULFILLMENT_EXCEPTION')
      ON CONFLICT (checkout_id) DO UPDATE SET state = 'FULFILLMENT_EXCEPTION', updated_at = now()`, [checkoutId]);
  }

  async countChargeAttempts(checkoutId: string): Promise<number> {
    const result = await this.client.query<{ attempt_count: number }>(`SELECT count(*)::int AS attempt_count
      FROM payment_attempts WHERE checkout_id = $1 AND state IN
      ('DISPATCHING', 'PENDING', 'UNKNOWN_OUTCOME', 'APPROVED', 'DECLINED', 'ERROR', 'VOIDED')`, [checkoutId]);
    return result.rows[0]?.attempt_count ?? 0;
  }

  async releaseReservation(reservationId: string): Promise<void> {
    const released = await this.client.query<{ product_id: string; quantity: number }>(
      `UPDATE reservations SET state = 'RELEASED', released_at = now()
       WHERE id = $1 AND state = 'HELD' RETURNING product_id, quantity`, [reservationId]);
    const row = released.rows[0];
    if (!row) return;
    const inventory = await this.client.query(`UPDATE products SET reserved_quantity = reserved_quantity - $2, updated_at = now()
      WHERE id = $1 AND reserved_quantity >= $2 RETURNING id`, [row.product_id, row.quantity]);
    if (inventory.rowCount !== 1) throw new Error('Reserved inventory counters are inconsistent.');
  }

  async extendRetryWindow(checkoutId: string, reservationId: string, seconds: number): Promise<void> {
    const result = await this.client.query(`UPDATE reservations SET expires_at = now() + ($2 * interval '1 second')
      WHERE id = $1 AND state = 'HELD'`, [reservationId, seconds]);
    if (result.rowCount === 1) await this.client.query(
      `UPDATE checkouts SET reservation_expires_at = now() + ($2 * interval '1 second') WHERE id = $1`,
      [checkoutId, seconds]);
  }

  async setCheckoutPaymentFailed(checkoutId: string, closeRetryWindow: boolean): Promise<void> {
    await this.client.query(`UPDATE checkouts SET state = 'PAYMENT_FAILED',
      reservation_expires_at = CASE WHEN $2 THEN now() ELSE reservation_expires_at END,
      updated_at = now() WHERE id = $1`, [checkoutId, closeRetryWindow]);
  }

  async setCheckoutCancelled(checkoutId: string): Promise<void> {
    await this.client.query(`UPDATE checkouts SET state = 'CANCELLED', reservation_expires_at = now(), updated_at = now()
      WHERE id = $1`, [checkoutId]);
  }

  private toView(row: AttemptRow): PaymentAttemptView {
    return {
      attemptId: row.id, checkoutId: row.checkout_id, attemptNumber: row.attempt_number,
      state: row.state, dispatching: (row.state === 'DISPATCHING' || row.state === 'PENDING') && row.provider_response_received_at === null,
      amountCop: Number(row.amount_cop), currency: row.currency.trim(),
      manualReviewRequired: row.manual_review_required_at !== null, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }
}
