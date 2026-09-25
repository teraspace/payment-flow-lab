jest.mock('jose', () => ({
  CompactEncrypt: jest.fn().mockImplementation(() => ({
    setProtectedHeader: jest.fn().mockReturnThis(),
    encrypt: jest.fn().mockResolvedValue('compact-jwe-only'),
  })),
  importSPKI: jest.fn().mockResolvedValue({}),
}));

import { CompactEncrypt, importSPKI } from 'jose';
import {
  getSandboxPaymentConfiguration,
  SANDBOX_TEST_CARDS,
  tokenizeSandboxCard,
  type SandboxCardData,
} from './sandbox-payment';

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

function validCard(overrides: Partial<SandboxCardData> = {}): SandboxCardData {
  return {
    number: SANDBOX_TEST_CARDS.approved,
    expMonth: '12',
    expYear: '40',
    cvc: '123',
    cardHolder: 'Ada Test',
    ...overrides,
  };
}

describe('sandbox-only card tokenization', () => {
  const originalFetch = globalThis.fetch;
  const viteEnv = (globalThis as typeof globalThis & {
    __VITE_ENV__: Record<string, unknown>;
  }).__VITE_ENV__;

  beforeEach(() => {
    viteEnv.VITE_PAYMENT_GATEWAY_ENVIRONMENT = 'test';
    (importSPKI as jest.Mock).mockResolvedValue({});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.useRealTimers();
  });

  it('enables only the test environment and fails closed elsewhere', () => {
    expect(getSandboxPaymentConfiguration()).toEqual({ ready: true, configuration: { environment: 'test' } });
    viteEnv.VITE_PAYMENT_GATEWAY_ENVIRONMENT = 'production';
    expect(getSandboxPaymentConfiguration()).toEqual({
      ready: false,
      message: 'Esta aplicación sólo permite procesar pagos en el ambiente sandbox.',
    });
    viteEnv.VITE_PAYMENT_GATEWAY_ENVIRONMENT = '  ';
    expect(getSandboxPaymentConfiguration().ready).toBe(true);
  });

  it.each([
    ['real or unknown card number', { number: '5555555555554444' }, 'Usa únicamente uno de los números de prueba indicados en esta pantalla.'],
    ['past expiration', { expMonth: '01', expYear: '20' }, 'La fecha de expiración de la tarjeta de prueba debe estar en el futuro.'],
    ['malformed expiration', { expMonth: '1', expYear: '40' }, 'La fecha de expiración de la tarjeta de prueba debe estar en el futuro.'],
    ['expiration month out of range', { expMonth: '13', expYear: '40' }, 'La fecha de expiración de la tarjeta de prueba debe estar en el futuro.'],
    ['short CVC', { cvc: '12' }, 'El código de seguridad de prueba debe tener tres dígitos.'],
    ['blank holder', { cardHolder: '   ' }, 'Escribe el nombre de prueba que aparece en la tarjeta.'],
  ] as const)('rejects %s before any network call', async (_case, overrides, message) => {
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
    await expect(tokenizeSandboxCard(validCard(overrides))).rejects.toThrow(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts the current month through the end of that month', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2030-05-15T12:00:00.000Z'));
    globalThis.fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ publicKey: 'test-pem' }))
      .mockResolvedValueOnce(jsonResponse({ paymentToken: 'tok_test_current_month' }));
    await expect(tokenizeSandboxCard(validCard({ expMonth: '05', expYear: '30' })))
      .resolves.toBe('tok_test_current_month');
    await expect(tokenizeSandboxCard(validCard({ expMonth: '04', expYear: '30' })))
      .rejects.toThrow('La fecha de expiración de la tarjeta de prueba debe estar en el futuro.');
  });

  it('encrypts card details in the browser and sends only the compact payload', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ publicKey: 'test-pem' }))
      .mockResolvedValueOnce(jsonResponse({ paymentToken: ' tok_stagtest_abc ' }));
    globalThis.fetch = fetchMock;
    await expect(tokenizeSandboxCard(validCard({
      number: '4242 4242 4242 4242', cardHolder: ' Ada Test ',
    }))).resolves.toBe('tok_stagtest_abc');
    expect(importSPKI).toHaveBeenCalledWith('test-pem', 'RSA-OAEP-256');
    const cleartext = (CompactEncrypt as jest.Mock).mock.calls[0][0] as Uint8Array;
    expect(JSON.parse(new TextDecoder().decode(cleartext))).toEqual({
      number: '4242424242424242',
      cvc: '123',
      exp_month: '12',
      exp_year: '40',
      card_holder: 'Ada Test',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1,
      'http://localhost:3000/api/v1/payment-configuration/tokenization-key',
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
    );
    const sent = JSON.stringify(fetchMock.mock.calls[1][1]);
    expect(sent).toContain('compact-jwe-only');
    expect(sent).not.toContain('4242');
    expect(sent).not.toContain('123');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ payload: 'compact-jwe-only' });
  });

  it('handles key lookup, malformed key, encryption, and network failures', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new Error('offline'));
    await expect(tokenizeSandboxCard(validCard())).rejects.toThrow('No se pudo conectar con el API de tokenización sandbox.');

    globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse({}, 502));
    await expect(tokenizeSandboxCard(validCard())).rejects.toThrow('No se pudo cargar la llave de cifrado sandbox.');

    globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse({ publicKey: '  ' }));
    await expect(tokenizeSandboxCard(validCard())).rejects.toThrow('El ambiente sandbox no devolvió una llave de cifrado.');

    (importSPKI as jest.Mock).mockRejectedValueOnce(new Error('invalid key'));
    globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse({ publicKey: 'bad-pem' }));
    await expect(tokenizeSandboxCard(validCard())).rejects.toThrow('No se pudo cifrar la tarjeta de prueba en el navegador.');
  });

  it('rejects non-success, invalid JSON, and non-test tokens from tokenization', async () => {
    const key = jsonResponse({ publicKey: 'test-pem' });
    globalThis.fetch = jest.fn().mockResolvedValueOnce(key).mockResolvedValueOnce(jsonResponse({}, 400));
    await expect(tokenizeSandboxCard(validCard())).rejects.toThrow('La tokenización sandbox fue rechazada.');

    globalThis.fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ publicKey: 'test-pem' }))
      .mockResolvedValueOnce({ ok: true, status: 200, json: jest.fn().mockRejectedValue(new Error('bad json')) });
    await expect(tokenizeSandboxCard(validCard())).rejects.toThrow('La tokenización sandbox fue rechazada.');

    globalThis.fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ publicKey: 'test-pem' }))
      .mockResolvedValueOnce(jsonResponse({ paymentToken: 'tok_live_do_not_accept' }));
    await expect(tokenizeSandboxCard(validCard())).rejects.toThrow('El ambiente no devolvió un token de pago de prueba.');
  });
});
