import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CreatePaymentAttemptDto } from './dto/create-payment-attempt.dto';
import {
  PAYMENT_GATEWAY,
  PaymentGateway,
  ProviderTransaction,
  ProviderAcceptanceDocuments,
  VerifiedProviderEvent,
} from './payment-gateway.contract';
import {
  PaymentGatewayConfigurationError,
  PaymentGatewayRejectedError,
  PaymentGatewayUnavailableError,
} from './payment-gateway.errors';
import { PaymentAttemptView } from './payment-attempt.view';
import { PAYMENT_PERSISTENCE, PaymentPersistencePort, PaymentTransactionPort } from './payment-persistence.port';
import { ProviderEventEnvelope, verifyProviderEvent } from './payment-signatures';
import { andThen, andThenAsync, err, ok, Result } from '../core/result';
import { UseCaseError, useCaseError } from '../core/use-case-error';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const PAYMENT_RETRY_WINDOW_SECONDS = 600;
const RECONCILIATION_INTERVAL_MS = 30_000;
const DISPATCH_STALE_SECONDS = 20;
const EVENT_MAX_AGE_SECONDS = 48 * 60 * 60;
const PAYMENT_RELEVANT_STATES = ['DISPATCHING', 'PENDING', 'UNKNOWN_OUTCOME', 'APPROVED', 'DECLINED', 'ERROR', 'VOIDED'];

interface AttemptResult {
  attempt: PaymentAttemptView;
  replayed: boolean;
}

interface PreparedAttempt {
  attempt: PaymentAttemptView;
  replayed: boolean;
  context: {
    attemptId: string;
    reference: string;
    amountCop: number;
    currency: 'COP';
    customerEmail: string;
  } | null;
}

@Injectable()
export class PaymentsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentsService.name);
  private timer?: NodeJS.Timeout;
  private activeReconciliation?: Promise<void>;

  constructor(
    @Inject(PAYMENT_PERSISTENCE) private readonly persistence: PaymentPersistencePort,
    private readonly config: ConfigService,
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

  async getAcceptanceDocuments(): Promise<ProviderAcceptanceDocuments> {
    try {
      return await this.gateway.getAcceptanceDocuments();
    } catch (error) {
      if (
        error instanceof PaymentGatewayConfigurationError ||
        error instanceof PaymentGatewayUnavailableError
      ) {
        throw new ServiceUnavailableException(
          'Sandbox acceptance documents are temporarily unavailable.',
        );
      }
      throw error;
    }
  }

  async getTokenizationPublicKey(): Promise<string> {
    try {
      return await this.gateway.getTokenizationPublicKey();
    } catch (error) {
      if (
        error instanceof PaymentGatewayConfigurationError ||
        error instanceof PaymentGatewayUnavailableError
      ) {
        throw new ServiceUnavailableException(
          'Sandbox card tokenization is temporarily unavailable.',
        );
      }
      throw error;
    }
  }

  async tokenizeEncryptedCard(payload: string): Promise<string> {
    try {
      return await this.gateway.tokenizeEncryptedCard(payload);
    } catch (error) {
      if (error instanceof PaymentGatewayRejectedError) {
        throw new BadRequestException('The sandbox rejected the test card.');
      }
      if (
        error instanceof PaymentGatewayConfigurationError ||
        error instanceof PaymentGatewayUnavailableError
      ) {
        throw new ServiceUnavailableException(
          'Sandbox card tokenization is temporarily unavailable.',
        );
      }
      throw error;
    }
  }

  async createAttempt(
    sessionId: string,
    checkoutId: string,
    rawIdempotencyKey: string | undefined,
    dto: CreatePaymentAttemptDto,
  ): Promise<Result<AttemptResult, UseCaseError>> {
    const validKey = this.validateIdempotencyKey(rawIdempotencyKey);
    const preparedInput = andThen(validKey, (validIdempotencyKey) =>
      ok({
        idempotencyKeyHash: this.hash(validIdempotencyKey),
        requestFingerprintHash: this.hash(
          JSON.stringify([
            dto.paymentToken,
            dto.acceptanceToken,
            dto.personalDataAuthorizationToken,
            dto.installments ?? 1,
          ]),
        ),
      }),
    );

    return andThenAsync<
      { idempotencyKeyHash: string; requestFingerprintHash: string },
      UseCaseError,
      AttemptResult,
      UseCaseError
    >(preparedInput, async ({ idempotencyKeyHash, requestFingerprintHash }) => {
      const preparedResult = await this.persistence.transactionResult<PreparedAttempt, UseCaseError>(
        async (unitOfWork) => {
          await unitOfWork.releaseExpiredReservations();
          const checkout = await unitOfWork.lockCheckoutForAttempt(sessionId, checkoutId);
          if (!checkout) {
            return err(useCaseError('CHECKOUT_NOT_FOUND', 'Checkout not found.'));
          }

          const prior = await unitOfWork.findAttemptByIdempotencyKey(checkoutId, idempotencyKeyHash);
          if (prior) {
            if (prior.fingerprintHash === null) {
              return err(
                useCaseError(
                  'IDEMPOTENCY_REPLAY_EXPIRED',
                  'This payment replay window has expired.',
                ),
              );
            }
            if (prior.fingerprintHash !== requestFingerprintHash) {
              return err(
                useCaseError(
                  'IDEMPOTENCY_PAYLOAD_CONFLICT',
                  'Idempotency-Key was already used with a different payment request.',
                ),
              );
            }
            return ok({
              attempt: prior.view,
              replayed: true,
              context: null,
            });
          }

          if (!['RESERVED', 'PAYMENT_FAILED'].includes(checkout.state)) {
            return err(
              useCaseError(
                'CHECKOUT_NOT_ELIGIBLE',
                'Checkout is not eligible for a payment attempt.',
              ),
            );
          }
          if (
            checkout.reservationState !== 'HELD' ||
            checkout.reservationExpiresAt <= new Date()
          ) {
            return err(
              useCaseError('RESERVATION_EXPIRED', 'The inventory reservation has expired.'),
            );
          }
          if (!checkout.customerEmail) {
            return err(
              useCaseError(
                'CHECKOUT_DATA_EXPIRED',
                'The checkout payment data is no longer available.',
              ),
            );
          }

          const history = await unitOfWork.listAttemptHistory(checkoutId);
          if (
            history.some(({ state }) =>
              ['CREATED', 'DISPATCHING', 'PENDING', 'UNKNOWN_OUTCOME'].includes(state),
            )
          ) {
            return err(
              useCaseError(
                'PAYMENT_RECONCILIATION_REQUIRED',
                'An existing payment attempt must be reconciled first.',
              ),
            );
          }

          const chargeAttempts = history.filter(({ state }) =>
            PAYMENT_RELEVANT_STATES.includes(state),
          );
          const confirmedFailures = history.filter(
            ({ state }) => state === 'DECLINED' || state === 'ERROR',
          ).length;
          if (confirmedFailures >= 2 || chargeAttempts.length >= 2) {
            return err(
              useCaseError(
                'PAYMENT_RETRY_LIMIT_REACHED',
                'The permitted payment retry has already been used.',
              ),
            );
          }
          if (
            history.some(({ state }) => ['APPROVED', 'VOIDED'].includes(state)) ||
            checkout.state === 'PAID' ||
            checkout.state === 'CANCELLED'
          ) {
            return err(
              useCaseError('CHECKOUT_PAYMENT_CLOSED', 'Checkout is already closed for payment.'),
            );
          }

          const attemptNumber = (history.at(-1)?.attemptNumber ?? 0) + 1;
          if (attemptNumber > 10) {
            return err(
              useCaseError(
                'PAYMENT_ATTEMPT_LIMIT_REACHED',
                'No further payment attempts are permitted.',
              ),
            );
          }

          const reference = `pfl_${randomUUID()}`;
          const attempt = await unitOfWork.insertAttempt({
            checkoutId,
            attemptNumber,
            idempotencyKeyHash,
            fingerprintHash: requestFingerprintHash,
            reference,
            amountCop: checkout.totalMinor,
            currency: checkout.currency.trim(),
          });
          await unitOfWork.setCheckoutPaymentPending(checkoutId);

          return ok({
            attempt,
            replayed: false,
            context: {
              attemptId: attempt.attemptId,
              reference,
              amountCop: Number(checkout.totalMinor),
              currency: checkout.currency.trim() as 'COP',
              customerEmail: checkout.customerEmail!,
            },
          });
        },
      );

      if (!preparedResult.ok) return preparedResult;
      const prepared = preparedResult.value;
      if (prepared.replayed || !prepared.context) {
        return ok({ attempt: prepared.attempt, replayed: true });
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
        return ok({
          attempt: await this.readAttempt(sessionId, checkoutId, prepared.context.attemptId),
          replayed: false,
        });
      }

      const disposition = await this.applyTransactionResult(
        transaction,
        new Date(),
        prepared.context.attemptId,
      );
      if (disposition === 'MISMATCH') {
        await this.markManualReview(prepared.context.attemptId);
      }
      return ok({
        attempt: await this.readAttempt(sessionId, checkoutId, prepared.context.attemptId),
        replayed: false,
      });
    });
  }

  async getAttempt(
    sessionId: string,
    checkoutId: string,
    attemptId: string,
  ): Promise<PaymentAttemptView> {
    const initial = await this.readAttempt(sessionId, checkoutId, attemptId);
    const row = await this.persistence.findReconciliationState(checkoutId, attemptId);
    if (!row) throw new NotFoundException('Payment attempt not found.');

    if (
      row.providerTransactionId &&
      ['DISPATCHING', 'PENDING', 'UNKNOWN_OUTCOME'].includes(row.state) &&
      this.shouldReconcile(row.lastReconciledAt)
    ) {
      await this.reconcileById(attemptId, row.providerTransactionId);
      if (this.reviewIsDue(row.createdAt)) {
        await this.markManualReview(attemptId);
      }
      return this.readAttempt(sessionId, checkoutId, attemptId);
    }

    if (
      ['DISPATCHING', 'PENDING', 'UNKNOWN_OUTCOME'].includes(row.state) &&
      this.reviewIsDue(row.createdAt)
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
    const attemptId = await this.persistence.findLatestAttemptId(sessionId, checkoutId);
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

    await this.persistence.transaction(async (unitOfWork) => {
      const receiptId = await unitOfWork.insertEventReceipt({
        fingerprint: event.fingerprint,
        transactionId: event.transactionId,
        reference: event.reference,
        status: event.status,
        amountInCents: event.amountInCents,
        currency: event.currency,
        occurredAt: event.occurredAt,
      });
      if (!receiptId) return;

      const attemptId = await unitOfWork.findAttemptIdByReference(event.reference);
      if (!attemptId) {
        await unitOfWork.setReceiptDisposition(receiptId, null, 'UNMATCHED');
        return;
      }

      const disposition = await this.applyTransactionInTransaction(
        unitOfWork,
        this.toProviderTransaction(event),
        event.occurredAt,
        attemptId,
      );
      await unitOfWork.setReceiptDisposition(receiptId, attemptId, disposition);
    });
  }

  private async markLocalFailure(attemptId: string): Promise<void> {
    await this.persistence.transaction(async (unitOfWork) => {
      const attempt = await unitOfWork.lockAttemptContext(attemptId);
      if (!attempt || !this.isDispatchInFlight(attempt)) return;
      await unitOfWork.updateAttemptLocalState(attemptId, 'FAILED_LOCAL');
      await unitOfWork.setCheckoutAfterDispatchFailure(attempt.checkoutId, 'RESERVED');
    });
  }

  private isDispatchInFlight(attempt: import('./payment-persistence.port').PaymentAttemptContext): boolean {
    return (attempt.state === 'DISPATCHING' || attempt.state === 'PENDING') &&
      attempt.providerResponseReceivedAt === null;
  }

  private async markRejected(attemptId: string, httpStatus: number): Promise<void> {
    await this.persistence.transaction(async (unitOfWork) => {
      const attempt = await unitOfWork.lockAttemptContext(attemptId);
      if (!attempt || !this.isDispatchInFlight(attempt)) return;
      await unitOfWork.updateAttemptLocalState(attemptId, 'REJECTED_NO_TRANSACTION', httpStatus);
      await unitOfWork.setCheckoutAfterDispatchFailure(attempt.checkoutId, 'RESERVED');
    });
  }

  private async markUnknown(attemptId: string): Promise<void> {
    await this.persistence.transaction(async (unitOfWork) => {
      const attempt = await unitOfWork.lockAttemptContext(attemptId);
      if (!attempt || !this.isDispatchInFlight(attempt)) return;
      await unitOfWork.updateAttemptLocalState(attemptId, 'UNKNOWN_OUTCOME');
      await unitOfWork.setCheckoutAfterDispatchFailure(attempt.checkoutId, 'UNKNOWN_OUTCOME');
    });
  }

  private async applyTransactionResult(
    transaction: ProviderTransaction,
    occurredAt: Date,
    attemptId: string,
  ): Promise<import('./payment-persistence.port').PaymentEventDisposition> {
    return this.persistence.transaction((unitOfWork) =>
      this.applyTransactionInTransaction(unitOfWork, transaction, occurredAt, attemptId),
    );
  }

  private async applyTransactionInTransaction(
    unitOfWork: PaymentTransactionPort,
    transaction: ProviderTransaction,
    occurredAt: Date,
    attemptId: string,
  ): Promise<import('./payment-persistence.port').PaymentEventDisposition> {
    const attempt = await unitOfWork.lockAttemptContext(attemptId);
    if (!attempt) return 'UNMATCHED';

    const expectedAmountInCents = BigInt(attempt.amountCop) * 100n;
    if (
      transaction.reference !== attempt.providerReference ||
      BigInt(transaction.amountInCents) !== expectedAmountInCents ||
      transaction.currency !== attempt.currency.trim() ||
      (attempt.providerTransactionId && attempt.providerTransactionId !== transaction.id)
    ) {
      await unitOfWork.recordTransactionMismatch(
        attemptId,
        attempt.providerResponseReceivedAt === null,
      );
      return 'MISMATCH';
    }

    if (attempt.providerStatusUpdatedAt && occurredAt < attempt.providerStatusUpdatedAt) {
      const terminalConflict =
        ['APPROVED', 'DECLINED', 'ERROR', 'VOIDED'].includes(attempt.state) &&
        attempt.providerStatus !== transaction.status;
      await unitOfWork.recordStaleTransaction(attemptId, terminalConflict);
      return 'STALE';
    }

    if (attempt.state === 'APPROVED') {
      if (transaction.status === 'APPROVED') {
        await unitOfWork.clearAttemptLease(attemptId);
        return 'DUPLICATE';
      }
      await unitOfWork.recordStaleTransaction(attemptId, true);
      return 'CONTRADICTORY';
    }

    if (
      ['DECLINED', 'ERROR', 'VOIDED'].includes(attempt.state) &&
      attempt.providerStatus === transaction.status
    ) {
      await unitOfWork.clearAttemptLease(attemptId);
      return 'DUPLICATE';
    }
    if (
      ['DECLINED', 'ERROR', 'VOIDED'].includes(attempt.state) &&
      transaction.status !== 'APPROVED' && transaction.status !== 'VOIDED'
    ) {
      await unitOfWork.recordStaleTransaction(attemptId, true);
      return 'STALE';
    }

    await unitOfWork.updateAttemptFromProvider(transaction, occurredAt, attemptId);
    if (transaction.status === 'PENDING') {
      if (!['EXPIRED', 'CANCELLED', 'PAID', 'FULFILLMENT_EXCEPTION'].includes(attempt.checkoutState)) {
        await unitOfWork.setCheckoutPaymentPendingUnlessClosed(attempt.checkoutId);
      }
      return 'APPLIED';
    }

    if (transaction.status === 'APPROVED') {
      const retryWindowExpired = attempt.checkoutState === 'PAYMENT_FAILED' && attempt.reservationExpired;
      if (
        attempt.reservationState === 'HELD' &&
        !['EXPIRED', 'CANCELLED'].includes(attempt.checkoutState) &&
        !retryWindowExpired
      ) {
        await unitOfWork.commitHeldInventory(attempt);
        await unitOfWork.setCheckoutPaid(attempt.checkoutId);
        await unitOfWork.createReadyFulfillment(attempt.checkoutId);
      } else {
        if (attempt.reservationState === 'HELD') {
          await unitOfWork.releaseReservation(attempt.reservationId);
        }
        await unitOfWork.setCheckoutFulfillmentException(attempt.checkoutId);
        await unitOfWork.upsertExceptionFulfillment(attempt.checkoutId);
      }
      return 'APPLIED';
    }

    if (transaction.status === 'DECLINED' || transaction.status === 'ERROR') {
      if (attempt.reservationState === 'HELD' && !['PAID', 'CANCELLED'].includes(attempt.checkoutState)) {
        const retryLimitReached = await unitOfWork.countChargeAttempts(attempt.checkoutId) >= 2;
        if (retryLimitReached) {
          await unitOfWork.releaseReservation(attempt.reservationId);
        } else {
          await unitOfWork.extendRetryWindow(
            attempt.checkoutId,
            attempt.reservationId,
            PAYMENT_RETRY_WINDOW_SECONDS,
          );
        }
        await unitOfWork.setCheckoutPaymentFailed(attempt.checkoutId, retryLimitReached);
      }
      return 'APPLIED';
    }

    if (transaction.status === 'VOIDED') {
      if (attempt.reservationState === 'HELD') {
        await unitOfWork.releaseReservation(attempt.reservationId);
      }
      if (!['PAID', 'FULFILLMENT_EXCEPTION'].includes(attempt.checkoutState)) {
        await unitOfWork.setCheckoutCancelled(attempt.checkoutId);
      }
      return 'APPLIED';
    }

    return 'IGNORED';
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
    const attempt = await this.persistence.findAttempt(sessionId, checkoutId, attemptId);
    if (!attempt) throw new NotFoundException('Payment attempt not found.');
    return attempt;
  }

  private async markManualReview(attemptId: string): Promise<void> {
    await this.persistence.markManualReview(attemptId);
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
      await this.persistence.clearReconciliationAfterFailure(attemptId);
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
    const candidates = await this.persistence.claimReconciliationCandidates();

    const outcomes = await Promise.allSettled(candidates.map(async (candidate) => {
      if (candidate.providerTransactionId) {
        await this.reconcileById(candidate.id, candidate.providerTransactionId);
        if (this.reviewIsDue(candidate.createdAt)) {
          await this.markManualReview(candidate.id);
        }
        return;
      }
      if (
        (candidate.state === 'DISPATCHING' || candidate.state === 'PENDING') &&
        candidate.providerResponseReceivedAt === null &&
        candidate.dispatchStartedAt &&
        Date.now() - candidate.dispatchStartedAt.getTime() >= DISPATCH_STALE_SECONDS * 1000
      ) {
        await this.markUnknown(candidate.id);
      }
      if (this.reviewIsDue(candidate.createdAt)) {
        await this.markManualReview(candidate.id);
      }
      await this.persistence.clearCandidateLease(candidate.id);
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
    return this.persistence.purgeExpiredEventReceipts(retentionDays);
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

  private validateIdempotencyKey(idempotencyKey: string | undefined): Result<string, UseCaseError> {
    if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      return err(
        useCaseError(
          'INVALID_IDEMPOTENCY_KEY',
          'Idempotency-Key must contain 16 to 128 permitted characters.',
        ),
      );
    }
    return ok(idempotencyKey);
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
