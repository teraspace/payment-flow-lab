import { CompactEncrypt, importSPKI } from 'jose';
import { getApiBaseUrl } from './service-api';

export interface SandboxPaymentConfiguration {
  environment: 'test';
}

export interface AcceptanceDocuments {
  acceptanceToken: string;
  acceptanceUrl: string;
  personalDataAuthorizationToken: string;
  personalDataAuthorizationUrl: string;
}

export interface SandboxCardData {
  number: string;
  expMonth: string;
  expYear: string;
  cvc: string;
  cardHolder: string;
}

export const SANDBOX_TEST_CARDS = {
  approved: '4242424242424242',
  declined: '4111111111111111',
} as const;

const SANDBOX_CARD_NUMBERS: ReadonlySet<string> = new Set(Object.values(SANDBOX_TEST_CARDS));

export function getSandboxPaymentConfiguration():
  | { ready: true; configuration: SandboxPaymentConfiguration }
  | { ready: false; message: string } {
  const environment = import.meta.env.VITE_PAYMENT_GATEWAY_ENVIRONMENT?.trim() || 'test';

  if (environment !== 'test') {
    return {
      ready: false,
      message: 'Esta aplicación sólo permite procesar pagos en el ambiente sandbox.',
    };
  }
  return {
    ready: true,
    configuration: { environment: 'test' },
  };
}

export async function tokenizeSandboxCard(
  card: SandboxCardData,
): Promise<string> {
  const normalizedNumber = card.number.replace(/\s/g, '');
  if (!SANDBOX_CARD_NUMBERS.has(normalizedNumber)) {
    throw new Error('Usa únicamente uno de los números de prueba indicados en esta pantalla.');
  }
  if (!isFutureExpiry(card.expMonth, card.expYear)) {
    throw new Error('La fecha de expiración de la tarjeta de prueba debe estar en el futuro.');
  }
  if (!/^\d{3}$/.test(card.cvc)) {
    throw new Error('El código de seguridad de prueba debe tener tres dígitos.');
  }
  if (!card.cardHolder.trim()) {
    throw new Error('Escribe el nombre de prueba que aparece en la tarjeta.');
  }

  const paymentConfigurationUrl = `${getApiBaseUrl().replace(/\/$/, '')}/payment-configuration`;
  const keyResponse = await fetchApi(
    `${paymentConfigurationUrl}/tokenization-key`,
    {
      method: 'GET',
      cache: 'no-store',
      credentials: 'include',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    },
  );
  const keyPayload = await readSuccessfulJson(keyResponse, 'No se pudo cargar la llave de cifrado sandbox.');
  const publicKeyPem = readString(keyPayload.publicKey);
  if (!publicKeyPem) throw new Error('El ambiente sandbox no devolvió una llave de cifrado.');

  const protectedCard = {
    number: normalizedNumber,
    cvc: card.cvc,
    exp_month: card.expMonth,
    exp_year: card.expYear,
    card_holder: card.cardHolder.trim(),
  };

  let encryptedPayload: string;
  try {
    const encryptionKey = await importSPKI(publicKeyPem, 'RSA-OAEP-256');
    encryptedPayload = await new CompactEncrypt(
      new TextEncoder().encode(JSON.stringify(protectedCard)),
    )
      .setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A256GCM' })
      .encrypt(encryptionKey);
  } catch {
    throw new Error('No se pudo cifrar la tarjeta de prueba en el navegador.');
  }

  const tokenResponse = await fetchApi(
    `${paymentConfigurationUrl}/card-tokens`,
    {
      method: 'POST',
      cache: 'no-store',
      credentials: 'include',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ payload: encryptedPayload }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  const tokenPayload = await readSuccessfulJson(tokenResponse, 'La tokenización sandbox fue rechazada.');
  const paymentToken = readString(tokenPayload.paymentToken);
  if (!paymentToken?.startsWith('tok_test_') && !paymentToken?.startsWith('tok_stagtest_')) {
    throw new Error('El ambiente no devolvió un token de pago de prueba.');
  }
  return paymentToken;
}

async function fetchApi(input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new Error('No se pudo conectar con el API de tokenización sandbox.');
  }
}

function isFutureExpiry(month: string, year: string): boolean {
  if (!/^\d{2}$/.test(month) || !/^\d{2}$/.test(year)) return false;
  const monthNumber = Number(month);
  if (monthNumber < 1 || monthNumber > 12) return false;
  const fullYear = 2000 + Number(year);
  const now = new Date();
  return fullYear > now.getFullYear() ||
    (fullYear === now.getFullYear() && monthNumber >= now.getMonth() + 1);
}

async function readSuccessfulJson(response: Response, failureMessage: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(failureMessage);
  const payload: unknown = await response.json().catch(() => null);
  const record = asRecord(payload);
  if (!record) throw new Error(failureMessage);
  return record;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
