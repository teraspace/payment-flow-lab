import { ConfigService } from '@nestjs/config';
import { HttpPaymentGateway } from './http-payment-gateway';
import {
  PaymentGatewayConfigurationError,
  PaymentGatewayOutcomeUnknownError,
  PaymentGatewayRejectedError,
  PaymentGatewayUnavailableError,
} from './payment-gateway.errors';

describe('HttpPaymentGateway', () => {
  const config = new ConfigService({
    PAYMENT_GATEWAY_BASE_URL: 'https://gateway.example.test/v1',
    PAYMENT_GATEWAY_PRIVATE_KEY: 'private-test-key',
    PAYMENT_GATEWAY_INTEGRITY_SECRET: 'integrity-test-secret',
  });

  function gateway(fetcher: jest.Mock): HttpPaymentGateway {
    return new HttpPaymentGateway(config, fetcher as unknown as typeof fetch);
  }

  it('sends a server-priced transaction over TLS and maps the response', async () => {
    const fetcher = jest.fn().mockResolvedValue(
      jsonResponse(201, {
        data: {
          id: 'provider-tx-001',
          reference: 'attempt-ref-001',
          amount_in_cents: 4_200_000,
          currency: 'COP',
          status: 'PENDING',
        },
      }),
    );
    const result = await gateway(fetcher).createTransaction({
      acceptanceToken: 'acceptance-token',
      personalDataAuthorizationToken: 'personal-data-acceptance-token',
      amountCop: 42_000,
      currency: 'COP',
      customerEmail: 'buyer@example.test',
      installments: 1,
      paymentToken: 'one-time-payment-token',
      reference: 'attempt-ref-001',
    });

    expect(result).toEqual({
      id: 'provider-tx-001',
      reference: 'attempt-ref-001',
      amountInCents: 4_200_000,
      currency: 'COP',
      status: 'PENDING',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gateway.example.test/v1/transactions');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe(
      'Bearer private-test-key',
    );
    const requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(requestBody).toMatchObject({
      acceptance_token: 'acceptance-token',
      accept_personal_auth: 'personal-data-acceptance-token',
      amount_in_cents: 4_200_000,
      currency: 'COP',
      customer_email: 'buyer@example.test',
      payment_method: {
        type: 'CARD',
        token: 'one-time-payment-token',
        installments: 1,
      },
      reference: 'attempt-ref-001',
    });
    expect(requestBody.signature).toMatch(/^[a-f0-9]{64}$/);
  });

  it('treats documented authentication and payload errors as a confirmed rejection', async () => {
    const fetcher = jest.fn().mockResolvedValue(jsonResponse(400, { errors: [] }));

    await expect(
      gateway(fetcher).createTransaction({
        acceptanceToken: 'acceptance-token',
        personalDataAuthorizationToken: 'personal-data-acceptance-token',
        amountCop: 42_000,
        currency: 'COP',
        customerEmail: 'buyer@example.test',
        installments: 1,
        paymentToken: 'one-time-payment-token',
        reference: 'attempt-ref-001',
      }),
    ).rejects.toBeInstanceOf(PaymentGatewayRejectedError);
  });

  it('keeps a duplicate-reference response unknown instead of assuming replay success', async () => {
    const fetcher = jest.fn().mockResolvedValue(jsonResponse(422, { errors: [] }));

    await expect(
      gateway(fetcher).createTransaction({
        acceptanceToken: 'acceptance-token',
        personalDataAuthorizationToken: 'personal-data-acceptance-token',
        amountCop: 42_000,
        currency: 'COP',
        customerEmail: 'buyer@example.test',
        installments: 1,
        paymentToken: 'one-time-payment-token',
        reference: 'attempt-ref-001',
      }),
    ).rejects.toBeInstanceOf(PaymentGatewayOutcomeUnknownError);
  });

  it('treats network failures and provider 5xx responses as unknown outcomes', async () => {
    const networkFailure = jest.fn().mockRejectedValue(new Error('socket closed'));
    const serverFailure = jest.fn().mockResolvedValue(jsonResponse(503, {}));
    const input = {
      acceptanceToken: 'acceptance-token',
      personalDataAuthorizationToken: 'personal-data-acceptance-token',
      amountCop: 42_000,
      currency: 'COP' as const,
      customerEmail: 'buyer@example.test',
      installments: 1,
      paymentToken: 'one-time-payment-token',
      reference: 'attempt-ref-001',
    };

    await expect(gateway(networkFailure).createTransaction(input)).rejects.toBeInstanceOf(
      PaymentGatewayOutcomeUnknownError,
    );
    await expect(gateway(serverFailure).createTransaction(input)).rejects.toBeInstanceOf(
      PaymentGatewayOutcomeUnknownError,
    );
  });

  it('does not make a request when configuration is missing or insecure', async () => {
    const fetcher = jest.fn();
    const missing = new HttpPaymentGateway(
      new ConfigService({ PAYMENT_GATEWAY_BASE_URL: '', PAYMENT_GATEWAY_PRIVATE_KEY: '' }),
      fetcher as unknown as typeof fetch,
    );
    const insecure = new HttpPaymentGateway(
      new ConfigService({
        PAYMENT_GATEWAY_BASE_URL: 'http://gateway.example.test/v1',
        PAYMENT_GATEWAY_PRIVATE_KEY: 'private-test-key',
        PAYMENT_GATEWAY_INTEGRITY_SECRET: 'integrity-test-secret',
      }),
      fetcher as unknown as typeof fetch,
    );
    const input = {
      acceptanceToken: 'acceptance-token',
      personalDataAuthorizationToken: 'personal-data-acceptance-token',
      amountCop: 42_000,
      currency: 'COP' as const,
      customerEmail: 'buyer@example.test',
      installments: 1,
      paymentToken: 'one-time-payment-token',
      reference: 'attempt-ref-001',
    };

    await expect(missing.createTransaction(input)).rejects.toBeInstanceOf(
      PaymentGatewayConfigurationError,
    );
    await expect(insecure.createTransaction(input)).rejects.toBeInstanceOf(
      PaymentGatewayConfigurationError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('queries current status only by the server-side provider transaction ID', async () => {
    const fetcher = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        data: {
          id: 'provider/tx-001',
          reference: 'attempt-ref-001',
          amount_in_cents: 4_200_000,
          currency: 'COP',
          status: 'APPROVED',
        },
      }),
    );

    await expect(gateway(fetcher).getTransaction('provider/tx-001')).resolves.toMatchObject({
      id: 'provider/tx-001',
      status: 'APPROVED',
    });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://gateway.example.test/v1/transactions/provider%2Ftx-001',
    );
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('does not convert a failed status query into a payment transition', async () => {
    const fetcher = jest.fn().mockResolvedValue(jsonResponse(500, {}));

    await expect(gateway(fetcher).getTransaction('provider-tx-001')).rejects.toBeInstanceOf(
      PaymentGatewayUnavailableError,
    );
  });
});

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
