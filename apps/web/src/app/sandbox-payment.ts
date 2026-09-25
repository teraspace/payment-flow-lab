import { CompactEncrypt, importSPKI } from 'jose';

export interface SandboxPaymentConfiguration {
  baseUrl: string;
  publicKey: string;
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
  const baseUrlValue = import.meta.env.VITE_PAYMENT_GATEWAY_BASE_URL?.trim() || '';
  const publicKey = import.meta.env.VITE_PAYMENT_GATEWAY_PUBLIC_KEY?.trim() || '';

  if (environment !== 'test') {
    return {
      ready: false,
      message: 'Esta aplicación sólo permite procesar pagos en el ambiente sandbox.',
    };
  }
  if (!baseUrlValue || !publicKey) {
    return {
      ready: false,
      message:
        'El pago sandbox está deshabilitado hasta configurar la URL y la llave pública de prueba.',
    };
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(baseUrlValue);
  } catch {
    return { ready: false, message: 'La URL sandbox configurada no es válida.' };
  }

  if (
    baseUrl.protocol !== 'https:' ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    !/(sandbox|test)/i.test(baseUrl.hostname) ||
    !publicKey.startsWith('pub_test_')
  ) {
    return {
      ready: false,
      message:
        'La configuración no parece pertenecer a sandbox. No se enviarán tarjetas ni se crearán transacciones.',
    };
  }

  return {
    ready: true,
    configuration: {
      baseUrl: baseUrl.toString().replace(/\/+$/, ''),
      publicKey,
    },
  };
}

export async function loadAcceptanceDocuments(
  configuration: SandboxPaymentConfiguration,
): Promise<AcceptanceDocuments> {
  const response = await fetch(`${configuration.baseUrl}/merchants/info`, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    headers: {
      accept: 'application/json',
      'x-merchant-public-key': configuration.publicKey,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await readSuccessfulJson(response, 'No se pudieron cargar los documentos de aceptación sandbox.');
  const data = asRecord(payload.data);
  const acceptance = asRecord(data?.presigned_acceptance);
  const personalData = asRecord(data?.presigned_personal_data_auth);
  const acceptanceToken = readString(acceptance?.acceptance_token);
  const acceptanceUrl = httpsUrl(acceptance?.permalink);
  const personalDataAuthorizationToken = readString(personalData?.acceptance_token);
  const personalDataAuthorizationUrl = httpsUrl(personalData?.permalink);

  if (
    !acceptanceToken ||
    !acceptanceUrl ||
    !personalDataAuthorizationToken ||
    !personalDataAuthorizationUrl
  ) {
    throw new Error('El ambiente sandbox no devolvió ambos documentos de aceptación.');
  }

  return {
    acceptanceToken,
    acceptanceUrl,
    personalDataAuthorizationToken,
    personalDataAuthorizationUrl,
  };
}

export async function tokenizeSandboxCard(
  configuration: SandboxPaymentConfiguration,
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

  const keyResponse = await fetch(`${configuration.baseUrl}/tokens/keys/tokenization`, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${configuration.publicKey}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const keyPayload = await readSuccessfulJson(keyResponse, 'No se pudo cargar la llave de cifrado sandbox.');
  const publicKeyPem = readString(asRecord(keyPayload.data)?.publicKey);
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

  const tokenResponse = await fetch(`${configuration.baseUrl}/tokens/cards`, {
    method: 'POST',
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${configuration.publicKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ payload: encryptedPayload }),
    signal: AbortSignal.timeout(20_000),
  });
  const tokenPayload = await readSuccessfulJson(tokenResponse, 'La tokenización sandbox fue rechazada.');
  const paymentToken = readString(asRecord(tokenPayload.data)?.id);
  if (!paymentToken?.startsWith('tok_test_')) {
    throw new Error('El ambiente no devolvió un token de pago de prueba.');
  }
  return paymentToken;
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

function httpsUrl(value: unknown): string | null {
  const candidate = readString(value);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}
