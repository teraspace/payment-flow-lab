import { PaymentAttemptView } from './payment-attempt.view';
import { ProviderTransaction, ProviderTransactionStatus } from './payment-gateway.contract';

export const PAYMENT_PERSISTENCE = Symbol('PAYMENT_PERSISTENCE');

export interface PaymentCheckoutForAttempt {
  id: string;
  state: string;
  totalMinor: string;
  currency: string;
  customerEmail: string | null;
  reservationState: 'HELD' | 'RELEASED' | 'COMMITTED';
  reservationExpiresAt: Date;
}

export interface PaymentAttemptHistoryItem {
  attemptNumber: number;
  state: PaymentAttemptView['state'];
}

export interface StoredPaymentAttempt {
  view: PaymentAttemptView;
  fingerprintHash: string | null;
}

export interface PaymentAttemptInsert {
  checkoutId: string;
  attemptNumber: number;
  idempotencyKeyHash: string;
  fingerprintHash: string;
  reference: string;
  amountCop: string;
  currency: string;
}

export interface PaymentAttemptContext {
  id: string;
  checkoutId: string;
  attemptNumber: number;
  state: PaymentAttemptView['state'];
  providerReference: string;
  providerTransactionId: string | null;
  amountCop: string;
  currency: string;
  providerStatus: ProviderTransactionStatus | null;
  providerStatusUpdatedAt: Date | null;
  requestFingerprintHash: string | null;
  providerResponseReceivedAt: Date | null;
  reservationId: string;
  reservationState: 'HELD' | 'RELEASED' | 'COMMITTED';
  reservationExpiresAt: Date;
  reservationExpired: boolean;
  reservationProductId: string;
  reservationQuantity: number;
  checkoutState: string;
}

export interface PaymentReconciliationCandidate {
  id: string;
  providerTransactionId: string | null;
  state: PaymentAttemptView['state'];
  createdAt: Date;
  dispatchStartedAt: Date | null;
  providerResponseReceivedAt: Date | null;
}

export type PaymentEventDisposition =
  | 'APPLIED' | 'DUPLICATE' | 'UNMATCHED' | 'MISMATCH' | 'STALE' | 'CONTRADICTORY' | 'IGNORED';

export interface PaymentEventReceipt {
  fingerprint: string;
  transactionId: string;
  reference: string;
  status: ProviderTransactionStatus;
  amountInCents: number;
  currency: string;
  occurredAt: Date;
}

export interface PaymentTransactionPort {
  releaseExpiredReservations(): Promise<number>;
  lockCheckoutForAttempt(sessionId: string, checkoutId: string): Promise<PaymentCheckoutForAttempt | null>;
  findAttemptByIdempotencyKey(checkoutId: string, keyHash: string): Promise<StoredPaymentAttempt | null>;
  listAttemptHistory(checkoutId: string): Promise<PaymentAttemptHistoryItem[]>;
  insertAttempt(input: PaymentAttemptInsert): Promise<PaymentAttemptView>;
  setCheckoutPaymentPending(checkoutId: string): Promise<void>;
  insertEventReceipt(event: PaymentEventReceipt): Promise<string | null>;
  findAttemptIdByReference(reference: string): Promise<string | null>;
  setReceiptDisposition(receiptId: string, attemptId: string | null, disposition: PaymentEventDisposition): Promise<void>;
  lockAttemptContext(attemptId: string): Promise<PaymentAttemptContext | null>;
  updateAttemptLocalState(attemptId: string, state: 'FAILED_LOCAL' | 'REJECTED_NO_TRANSACTION' | 'UNKNOWN_OUTCOME', httpStatus?: number): Promise<void>;
  setCheckoutAfterDispatchFailure(checkoutId: string, state: 'RESERVED' | 'UNKNOWN_OUTCOME'): Promise<void>;
  recordTransactionMismatch(attemptId: string, markUnknown: boolean): Promise<void>;
  recordStaleTransaction(attemptId: string, terminalConflict: boolean): Promise<void>;
  clearAttemptLease(attemptId: string): Promise<void>;
  updateAttemptFromProvider(transaction: ProviderTransaction, occurredAt: Date, attemptId: string): Promise<void>;
  setCheckoutPaymentPendingUnlessClosed(checkoutId: string): Promise<void>;
  commitHeldInventory(attempt: PaymentAttemptContext): Promise<void>;
  setCheckoutPaid(checkoutId: string): Promise<void>;
  createReadyFulfillment(checkoutId: string): Promise<void>;
  setCheckoutFulfillmentException(checkoutId: string): Promise<void>;
  upsertExceptionFulfillment(checkoutId: string): Promise<void>;
  countChargeAttempts(checkoutId: string): Promise<number>;
  releaseReservation(reservationId: string): Promise<void>;
  extendRetryWindow(checkoutId: string, reservationId: string, seconds: number): Promise<void>;
  setCheckoutPaymentFailed(checkoutId: string, closeRetryWindow: boolean): Promise<void>;
  setCheckoutCancelled(checkoutId: string): Promise<void>;
}

export interface PaymentPersistencePort {
  transaction<T>(work: (unitOfWork: PaymentTransactionPort) => Promise<T>): Promise<T>;
  transactionResult<T, F>(work: (unitOfWork: PaymentTransactionPort) => Promise<import('../core/result').Result<T, F>>): Promise<import('../core/result').Result<T, F>>;
  findAttempt(sessionId: string, checkoutId: string, attemptId: string): Promise<PaymentAttemptView | null>;
  findLatestAttemptId(sessionId: string, checkoutId: string): Promise<string | null>;
  findReconciliationState(checkoutId: string, attemptId: string): Promise<{
    providerTransactionId: string | null; lastReconciledAt: Date | null; createdAt: Date;
    state: PaymentAttemptView['state'];
  } | null>;
  markManualReview(attemptId: string): Promise<void>;
  clearReconciliationAfterFailure(attemptId: string): Promise<void>;
  claimReconciliationCandidates(): Promise<PaymentReconciliationCandidate[]>;
  clearCandidateLease(candidateId: string): Promise<void>;
  purgeExpiredEventReceipts(retentionDays: number): Promise<number>;
}
