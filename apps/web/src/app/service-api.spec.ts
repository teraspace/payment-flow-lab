/** @jest-environment node */

import {
  ApiRequestError,
  getApiBaseUrl,
  loadAcceptanceDocumentsFromApi,
  serviceApi,
  submitPaymentAttempt,
} from './service-api';
import { store } from './store';

function jsonResponse(payload: unknown, status = 200): Response {
  const json = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 400 ? 'Request failed' : 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    clone() { return jsonResponse(payload, status); },
    json: async () => payload,
    text: async () => json,
  } as unknown as Response;
}

describe('service API helpers', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    store.dispatch(serviceApi.util.resetApiState());
    globalThis.fetch = originalFetch;
    (originalFetch as jest.Mock).mockReset().mockRejectedValue(new Error('No fetch mock configured'));
  });

  it('uses the configured Vite API base URL', () => {
    expect(getApiBaseUrl()).toBe('http://localhost:3000/api/v1');
  });

  it('loads valid HTTPS acceptance documents without caching', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({
      acceptanceToken: 'accept-1',
      acceptanceUrl: 'https://provider.example.test/terms',
      personalDataAuthorizationToken: 'privacy-1',
      personalDataAuthorizationUrl: 'https://provider.example.test/privacy',
    }));
    (originalFetch as jest.Mock).mockImplementation(fetchMock);
    await expect(loadAcceptanceDocumentsFromApi()).resolves.toEqual({
      acceptanceToken: 'accept-1',
      acceptanceUrl: 'https://provider.example.test/terms',
      personalDataAuthorizationToken: 'privacy-1',
      personalDataAuthorizationUrl: 'https://provider.example.test/privacy',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/payment-configuration/acceptance-documents',
      expect.objectContaining({ method: 'GET', cache: 'no-store', credentials: 'include' }),
    );
  });

  it('converts provider and malformed acceptance responses into safe API errors', async () => {
    globalThis.fetch = jest.fn().mockResolvedValueOnce(jsonResponse({}, 503));
    await expect(loadAcceptanceDocumentsFromApi()).rejects.toMatchObject({
      name: 'ApiRequestError', status: 503,
    });

    globalThis.fetch = jest.fn().mockResolvedValueOnce(jsonResponse({
      acceptanceToken: ' ',
      acceptanceUrl: 'http://provider.example.test/terms',
      personalDataAuthorizationToken: 'privacy-1',
      personalDataAuthorizationUrl: 'not a URL',
    }));
    await expect(loadAcceptanceDocumentsFromApi()).rejects.toMatchObject({
      name: 'ApiRequestError', status: 502,
      message: 'El API no devolvió documentos de aceptación válidos.',
    });

    globalThis.fetch = jest.fn().mockResolvedValueOnce({
      ok: true, status: 200, json: jest.fn().mockRejectedValue(new Error('bad json')),
    });
    await expect(loadAcceptanceDocumentsFromApi()).rejects.toMatchObject({ status: 502 });
  });

  it('submits an idempotent payment attempt and returns the attempt', async () => {
    const attempt = { attemptId: 'attempt-1', state: 'PENDING' };
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(attempt));
    (originalFetch as jest.Mock).mockImplementation(fetchMock);
    await expect(submitPaymentAttempt(
      'checkout-1', 'command-key-123456', {
        paymentToken: 'tok_test_123',
        acceptanceToken: 'accept-1',
        personalDataAuthorizationToken: 'privacy-1',
        installments: 1,
      },
    )).resolves.toEqual(attempt);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/checkouts/checkout-1/payment-attempts',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Idempotency-Key': 'command-key-123456' }),
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      paymentToken: 'tok_test_123',
      acceptanceToken: 'accept-1',
      personalDataAuthorizationToken: 'privacy-1',
      installments: 1,
    });
  });

  it('preserves API errors and rejects missing or malformed payment outcomes', async () => {
    globalThis.fetch = jest.fn().mockResolvedValueOnce(jsonResponse({ message: 'Checkout vencido' }, 410));
    await expect(submitPaymentAttempt('checkout-1', 'key', {
      paymentToken: 'tok_test_123', acceptanceToken: 'a', personalDataAuthorizationToken: 'p', installments: 1,
    })).rejects.toMatchObject({ name: 'ApiRequestError', status: 410, message: 'Checkout vencido' });

    globalThis.fetch = jest.fn().mockResolvedValueOnce(jsonResponse({}, 409));
    await expect(submitPaymentAttempt('checkout-1', 'key', {
      paymentToken: 'tok_test_123', acceptanceToken: 'a', personalDataAuthorizationToken: 'p', installments: 1,
    })).rejects.toMatchObject({ message: 'No fue posible registrar el intento de pago.' });

    globalThis.fetch = jest.fn().mockResolvedValueOnce(jsonResponse({ state: 'PENDING' }));
    await expect(submitPaymentAttempt('checkout-1', 'key', {
      paymentToken: 'tok_test_123', acceptanceToken: 'a', personalDataAuthorizationToken: 'p', installments: 1,
    })).rejects.toMatchObject({ status: 502, message: 'La respuesta del API no tiene un estado de pago válido.' });

    globalThis.fetch = jest.fn().mockResolvedValueOnce({
      ok: false, status: 502, json: jest.fn().mockRejectedValue(new Error('bad json')),
    });
    await expect(submitPaymentAttempt('checkout-1', 'key', {
      paymentToken: 'tok_test_123', acceptanceToken: 'a', personalDataAuthorizationToken: 'p', installments: 1,
    })).rejects.toBeInstanceOf(ApiRequestError);
  });

  it('builds each Redux API endpoint with the expected method, path, body, and idempotency header', async () => {
    const checkout = { checkoutId: 'checkout-1', state: 'RESERVED' };
    const product = { id: 'product-1', sku: 'desk-notebook' };
    const attempt = { attemptId: 'attempt-1', state: 'PENDING' };
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'ok', checks: { database: 'ok' } }))
      .mockResolvedValueOnce(jsonResponse([product]))
      .mockResolvedValueOnce(jsonResponse({ expiresAt: '2026-10-01T00:00:00Z' }))
      .mockResolvedValueOnce(jsonResponse(checkout))
      .mockResolvedValueOnce(jsonResponse(checkout))
      .mockResolvedValueOnce(jsonResponse(checkout))
      .mockResolvedValueOnce(jsonResponse(attempt));
    (originalFetch as jest.Mock).mockImplementation(fetchMock);
    store.dispatch(serviceApi.util.resetApiState());

    await expect(store.dispatch(serviceApi.endpoints.getReadiness.initiate(undefined, { subscribe: false })).unwrap())
      .resolves.toMatchObject({ status: 'ok' });
    await expect(store.dispatch(serviceApi.endpoints.getProducts.initiate(undefined, { subscribe: false })).unwrap())
      .resolves.toEqual([product]);
    await expect(store.dispatch(serviceApi.endpoints.initializeGuestSession.initiate(undefined, { track: false })).unwrap())
      .resolves.toHaveProperty('expiresAt');
    await expect(store.dispatch(serviceApi.endpoints.createCheckout.initiate({
      idempotencyKey: 'checkout-command-000001',
      body: { productId: 'product-1', quantity: 1, customer: { fullName: 'Ada', email: 'ada@example.test' }, delivery: { recipient: 'Ada', address: 'Calle 1 #2-3' } },
    }, { track: false })).unwrap()).resolves.toEqual(checkout);
    await expect(store.dispatch(serviceApi.endpoints.recoverCheckout.initiate('checkout-command-000001', { track: false })).unwrap())
      .resolves.toEqual(checkout);
    await expect(store.dispatch(serviceApi.endpoints.getCheckout.initiate('checkout-1', { subscribe: false })).unwrap())
      .resolves.toEqual(checkout);
    await expect(store.dispatch(serviceApi.endpoints.getLatestPaymentAttempt.initiate('checkout-1', { subscribe: false })).unwrap())
      .resolves.toEqual(attempt);

    const requests = fetchMock.mock.calls.map(([request]) => request as Request);
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      'GET /api/v1/health/ready',
      'GET /api/v1/products',
      'POST /api/v1/guest-session',
      'POST /api/v1/checkouts',
      'POST /api/v1/checkouts/recover',
      'GET /api/v1/checkouts/checkout-1',
      'GET /api/v1/checkouts/checkout-1/payment-attempts/latest',
    ]);
    expect(requests[3].headers.get('Idempotency-Key')).toBe('checkout-command-000001');
    expect(JSON.parse(await requests[3].clone().text())).toMatchObject({ productId: 'product-1', quantity: 1 });
    expect(requests[4].headers.get('Idempotency-Key')).toBe('checkout-command-000001');
  });

  it('keeps product-list invalidation tags when the product query has no result', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ message: 'unavailable' }, 503));
    (originalFetch as jest.Mock).mockImplementation(fetchMock);
    store.dispatch(serviceApi.util.resetApiState());
    await expect(store.dispatch(serviceApi.endpoints.getProducts.initiate(undefined, { subscribe: false })).unwrap())
      .rejects.toMatchObject({ status: 503 });
  });
});
