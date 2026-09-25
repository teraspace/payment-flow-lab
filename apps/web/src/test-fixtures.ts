import type { Checkout, PaymentAttempt, Product } from './app/service-api';

export function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'product-1',
    sku: 'desk-notebook',
    name: 'Cuaderno de puntos',
    description: 'Cuaderno de tapa dura para notas.',
    imageUrl: '/catalog/notebook.svg',
    unitPriceMinor: 45_000,
    currency: 'COP',
    physicalQuantity: 10,
    reservedQuantity: 2,
    availableQuantity: 8,
    ...overrides,
  };
}

export function makeCheckout(overrides: Partial<Checkout> = {}): Checkout {
  return {
    checkoutId: 'a745095c-4932-4cdb-a1d3-2e30f81e380b',
    state: 'RESERVED',
    customer: { fullName: 'Ada Lovelace', email: 'ada@example.test' },
    delivery: { recipient: 'Ada Lovelace', address: 'Calle 1 #2-3, Bogotá' },
    item: {
      productId: 'product-1',
      sku: 'desk-notebook',
      name: 'Cuaderno de puntos',
      quantity: 1,
      unitPriceMinor: 45_000,
      lineTotalMinor: 45_000,
    },
    subtotalMinor: 45_000,
    baseFeeMinor: 1_350,
    deliveryFeeMinor: 8_000,
    totalAmountInMinorUnits: 54_350,
    currency: 'COP',
    reservation: { state: 'HELD', expiresAt: '2026-10-01T12:00:00.000Z' },
    createdAt: '2026-09-24T12:00:00.000Z',
    ...overrides,
  };
}

export function makeAttempt(overrides: Partial<PaymentAttempt> = {}): PaymentAttempt {
  return {
    attemptId: 'attempt-1',
    checkoutId: 'a745095c-4932-4cdb-a1d3-2e30f81e380b',
    attemptNumber: 1,
    state: 'PENDING',
    dispatching: false,
    amountCop: 54_350,
    currency: 'COP',
    manualReviewRequired: false,
    createdAt: '2026-09-24T12:00:00.000Z',
    updatedAt: '2026-09-24T12:00:00.000Z',
    ...overrides,
  };
}
