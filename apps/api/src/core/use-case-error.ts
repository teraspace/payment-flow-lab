export type UseCaseErrorCode =
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'IDEMPOTENCY_REPLAY_EXPIRED'
  | 'IDEMPOTENCY_PAYLOAD_CONFLICT'
  | 'CHECKOUT_NOT_FOUND'
  | 'PRODUCT_NOT_FOUND'
  | 'INSUFFICIENT_INVENTORY'
  | 'CHECKOUT_AMOUNT_OUT_OF_RANGE'
  | 'CHECKOUT_NOT_ELIGIBLE'
  | 'RESERVATION_EXPIRED'
  | 'CHECKOUT_DATA_EXPIRED'
  | 'PAYMENT_RECONCILIATION_REQUIRED'
  | 'PAYMENT_RETRY_LIMIT_REACHED'
  | 'CHECKOUT_PAYMENT_CLOSED'
  | 'PAYMENT_ATTEMPT_LIMIT_REACHED';

export interface UseCaseError {
  readonly code: UseCaseErrorCode;
  readonly message: string;
}

export function useCaseError(code: UseCaseErrorCode, message: string): UseCaseError {
  return { code, message };
}
