import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { AcceptanceDocuments } from './sandbox-payment';

export interface ReadinessResponse {
  status: 'ok';
  checks: { database: 'ok' };
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  description: string;
  imageUrl: string;
  unitPriceMinor: number;
  currency: string;
  physicalQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
}

export type CheckoutState =
  | 'RESERVED'
  | 'PAYMENT_PENDING'
  | 'UNKNOWN_OUTCOME'
  | 'PAYMENT_FAILED'
  | 'PAID'
  | 'CANCEL_PENDING'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'FULFILLMENT_EXCEPTION';

export interface Checkout {
  checkoutId: string;
  state: CheckoutState;
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
  reservation: { state: 'HELD' | 'RELEASED' | 'COMMITTED'; expiresAt: string };
  createdAt: string;
}

export interface CreateCheckoutInput {
  idempotencyKey: string;
  body: {
    productId: string;
    quantity: number;
    customer: { fullName: string; email: string };
    delivery: { recipient: string; address: string };
  };
}

export interface PaymentAttempt {
  attemptId: string;
  checkoutId: string;
  attemptNumber: number;
  state:
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
  dispatching: boolean;
  amountCop: number;
  currency: string;
  manualReviewRequired: boolean;
  createdAt: string;
  updatedAt: string;
}

const apiBaseUrl =
  import.meta.env.VITE_API_BASE_URL ??
  (import.meta.env.DEV ? 'http://localhost:3000/api/v1' : '/api/v1');

export const serviceApi = createApi({
  reducerPath: 'serviceApi',
  tagTypes: ['Product', 'Checkout', 'PaymentAttempt'],
  baseQuery: fetchBaseQuery({
    baseUrl: apiBaseUrl,
    credentials: 'include',
  }),
  endpoints: (builder) => ({
    getReadiness: builder.query<ReadinessResponse, void>({
      query: () => '/health/ready',
    }),
    getProducts: builder.query<Product[], void>({
      query: () => '/products',
      providesTags: (products) => [
        ...(products ?? []).map(({ id }) => ({ type: 'Product' as const, id })),
        { type: 'Product' as const, id: 'LIST' },
      ],
    }),
    initializeGuestSession: builder.mutation<{ expiresAt: string }, void>({
      query: () => ({ url: '/guest-session', method: 'POST' }),
    }),
    createCheckout: builder.mutation<Checkout, CreateCheckoutInput>({
      query: ({ idempotencyKey, body }) => ({
        url: '/checkouts',
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body,
      }),
      invalidatesTags: [{ type: 'Product', id: 'LIST' }],
    }),
    recoverCheckout: builder.mutation<Checkout, string>({
      query: (idempotencyKey) => ({
        url: '/checkouts/recover',
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    }),
    getCheckout: builder.query<Checkout, string>({
      query: (checkoutId) => `/checkouts/${checkoutId}`,
      providesTags: (_checkout, _error, checkoutId) => [
        { type: 'Checkout', id: checkoutId },
      ],
      keepUnusedDataFor: 0,
    }),
    getLatestPaymentAttempt: builder.query<PaymentAttempt, string>({
      query: (checkoutId) => `/checkouts/${checkoutId}/payment-attempts/latest`,
      providesTags: (_attempt, _error, checkoutId) => [
        { type: 'PaymentAttempt', id: checkoutId },
      ],
      keepUnusedDataFor: 0,
    }),
  }),
});

export const {
  useGetReadinessQuery,
  useGetProductsQuery,
  useInitializeGuestSessionMutation,
  useCreateCheckoutMutation,
  useRecoverCheckoutMutation,
  useGetCheckoutQuery,
  useGetLatestPaymentAttemptQuery,
} = serviceApi;

export function getApiBaseUrl(): string {
  return apiBaseUrl;
}

export async function loadAcceptanceDocumentsFromApi(): Promise<AcceptanceDocuments> {
  const response = await fetch(
    `${apiBaseUrl.replace(/\/$/, '')}/payment-configuration/acceptance-documents`,
    {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    },
  );
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiRequestError(response.status, 'No se pudieron cargar los documentos de aceptación sandbox.');
  }
  const record = isRecord(payload) ? payload : null;
  const acceptanceToken = readString(record?.acceptanceToken);
  const acceptanceUrl = readHttpsUrl(record?.acceptanceUrl);
  const personalDataAuthorizationToken = readString(record?.personalDataAuthorizationToken);
  const personalDataAuthorizationUrl = readHttpsUrl(record?.personalDataAuthorizationUrl);
  if (
    !acceptanceToken ||
    !acceptanceUrl ||
    !personalDataAuthorizationToken ||
    !personalDataAuthorizationUrl
  ) {
    throw new ApiRequestError(502, 'El API no devolvió documentos de aceptación válidos.');
  }
  return {
    acceptanceToken,
    acceptanceUrl,
    personalDataAuthorizationToken,
    personalDataAuthorizationUrl,
  };
}

export async function submitPaymentAttempt(
  checkoutId: string,
  idempotencyKey: string,
  body: {
    paymentToken: string;
    acceptanceToken: string;
    personalDataAuthorizationToken: string;
    installments: number;
  },
): Promise<PaymentAttempt> {
  const response = await fetch(
    `${apiBaseUrl.replace(/\/$/, '')}/checkouts/${checkoutId}/payment-attempts`,
    {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    },
  );

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.message === 'string'
      ? payload.message
      : 'No fue posible registrar el intento de pago.';
    throw new ApiRequestError(response.status, message);
  }
  if (!isRecord(payload) || typeof payload.attemptId !== 'string') {
    throw new ApiRequestError(502, 'La respuesta del API no tiene un estado de pago válido.');
  }
  return payload as unknown as PaymentAttempt;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readHttpsUrl(value: unknown): string | null {
  const candidate = readString(value);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}
