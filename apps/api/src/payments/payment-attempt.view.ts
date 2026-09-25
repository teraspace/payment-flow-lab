export type PaymentAttemptState =
  | 'CREATED'
  | 'DISPATCHING'
  | 'FAILED_LOCAL'
  | 'REJECTED_NO_TRANSACTION'
  | 'PENDING'
  | 'UNKNOWN_OUTCOME'
  | 'APPROVED'
  | 'DECLINED'
  | 'ERROR'
  | 'VOIDED';

export interface PaymentAttemptView {
  attemptId: string;
  checkoutId: string;
  attemptNumber: number;
  state: PaymentAttemptState;
  amountCop: number;
  currency: string;
  manualReviewRequired: boolean;
  createdAt: Date;
  updatedAt: Date;
}
