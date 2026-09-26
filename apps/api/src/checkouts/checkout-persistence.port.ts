import { Result } from '../core/result';

export const CHECKOUT_PERSISTENCE = Symbol('CHECKOUT_PERSISTENCE');

export interface CheckoutView {
  checkoutId: string;
  state:
    | 'RESERVED'
    | 'PAYMENT_PENDING'
    | 'UNKNOWN_OUTCOME'
    | 'PAYMENT_FAILED'
    | 'PAID'
    | 'CANCEL_PENDING'
    | 'CANCELLED'
    | 'EXPIRED'
    | 'FULFILLMENT_EXCEPTION';
  customer: { fullName: string | null; email: string | null };
  delivery: { recipient: string | null; address: string | null };
  item: {
    productId: string;
    sku: string;
    name: string;
    quantity: number;
    unitPriceMinor: number;
    lineTotalMinor: number;
  };
  subtotalMinor: number;
  baseFeeMinor: number;
  deliveryFeeMinor: number;
  totalAmountInMinorUnits: number;
  currency: string;
  reservation: { state: 'HELD' | 'RELEASED' | 'COMMITTED'; expiresAt: Date };
  createdAt: Date;
}

export interface CreateCheckoutSnapshot {
  checkoutId: string;
  sessionId: string;
  product: { id: string; sku: string; name: string; currency: string };
  quantity: number;
  unitPriceMinor: bigint;
  subtotalMinor: bigint;
  baseFeeMinor: number;
  deliveryFeeMinor: number;
  totalMinor: bigint;
  reservationTtlSeconds: number;
  customer: { fullName: string; email: string };
  delivery: { recipient: string; address: string };
}

export type ProductReservationResult =
  | { kind: 'reserved'; product: { id: string; sku: string; name: string; priceMinor: string; currency: string } }
  | { kind: 'not-found' }
  | { kind: 'insufficient-inventory' };

export interface CheckoutIdempotencyRecord {
  fingerprintHash: string | null;
  checkoutId: string;
}

export interface CheckoutTransactionPort {
  releaseExpiredReservations(): Promise<number>;
  claimIdempotencyRecord(input: {
    sessionId: string;
    keyHash: string;
    fingerprintHash: string;
    checkoutId: string;
  }): Promise<{ claimed: boolean; existing?: CheckoutIdempotencyRecord }>;
  reserveProduct(productId: string, quantity: number): Promise<ProductReservationResult>;
  persistCheckoutSnapshot(input: CreateCheckoutSnapshot): Promise<Date>;
  findIdempotencyRecord(sessionId: string, keyHash: string): Promise<CheckoutIdempotencyRecord | null>;
  getCheckout(sessionId: string, checkoutId: string): Promise<CheckoutView | null>;
}

export interface CheckoutPersistencePort {
  transaction<T>(work: (unitOfWork: CheckoutTransactionPort) => Promise<T>): Promise<T>;
  transactionResult<T, F>(
    work: (unitOfWork: CheckoutTransactionPort) => Promise<Result<T, F>>,
  ): Promise<Result<T, F>>;
}
