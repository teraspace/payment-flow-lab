import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ProviderTransactionStatus,
  VerifiedProviderEvent,
} from './payment-gateway.contract';

const STATUS_VALUES = new Set<ProviderTransactionStatus>([
  'PENDING',
  'APPROVED',
  'DECLINED',
  'VOIDED',
  'ERROR',
]);
const PROPERTY_PATH = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/;
const REQUIRED_SIGNED_PROPERTIES = [
  'transaction.id',
  'transaction.reference',
  'transaction.amount_in_cents',
  'transaction.currency',
  'transaction.status',
] as const;

export interface ProviderEventEnvelope {
  event?: unknown;
  data?: unknown;
  environment?: unknown;
  signature?: unknown;
  timestamp?: unknown;
}

export function createIntegritySignature(
  reference: string,
  amountInCents: number,
  currency: string,
  integritySecret: string,
): string {
  return createHash('sha256')
    .update(`${reference}${amountInCents}${currency}${integritySecret}`, 'utf8')
    .digest('hex');
}

export function verifyProviderEvent(
  envelope: ProviderEventEnvelope,
  eventSecret: string,
  expectedEnvironment: 'test' | 'prod',
  headerChecksum?: string,
): VerifiedProviderEvent {
  if (
    envelope.event !== 'transaction.updated' ||
    envelope.environment !== expectedEnvironment ||
    typeof envelope.timestamp !== 'number' ||
    !Number.isSafeInteger(envelope.timestamp) ||
    envelope.timestamp <= 0 ||
    !isRecord(envelope.data) ||
    !isRecord(envelope.signature)
  ) {
    throw new Error('Invalid payment event envelope.');
  }

  const transaction = envelope.data.transaction;
  const signature = envelope.signature;
  if (!isRecord(transaction) || !Array.isArray(signature.properties)) {
    throw new Error('Invalid payment event transaction or signature.');
  }
  const signedProperties: unknown[] = signature.properties;

  const values: string[] = [];
  for (const property of signedProperties) {
    if (typeof property !== 'string' || !PROPERTY_PATH.test(property)) {
      throw new Error('Invalid payment event signature property.');
    }
    const value = propertyValue(envelope.data, property);
    if (value === null) throw new Error('Missing signed payment event value.');
    values.push(value);
  }
  if (new Set(signedProperties).size !== signedProperties.length) {
    throw new Error('Duplicate payment event signature property.');
  }
  if (REQUIRED_SIGNED_PROPERTIES.some((property) => !signedProperties.includes(property))) {
    throw new Error('Required payment event fields are not all signed.');
  }

  const checksum = signature.checksum;
  if (typeof checksum !== 'string' || !/^[a-fA-F0-9]{64}$/.test(checksum)) {
    throw new Error('Invalid payment event checksum.');
  }
  if (
    headerChecksum !== undefined &&
    (typeof headerChecksum !== 'string' ||
      !/^[a-fA-F0-9]{64}$/.test(headerChecksum) ||
      !safeHexEqual(headerChecksum, checksum))
  ) {
    throw new Error('Conflicting payment event checksums.');
  }

  const expectedChecksum = createHash('sha256')
    .update(`${values.join('')}${envelope.timestamp}${eventSecret}`, 'utf8')
    .digest('hex');
  if (!safeHexEqual(expectedChecksum, checksum)) {
    throw new Error('Payment event signature verification failed.');
  }

  const transactionId = transaction.id;
  const reference = transaction.reference;
  const amountInCents = transaction.amount_in_cents;
  const currency = transaction.currency;
  const status = transaction.status;
  if (
    typeof transactionId !== 'string' ||
    transactionId.length < 1 ||
    transactionId.length > 255 ||
    typeof reference !== 'string' ||
    reference.length < 1 ||
    reference.length > 255 ||
    typeof amountInCents !== 'number' ||
    !Number.isSafeInteger(amountInCents) ||
    amountInCents < 0 ||
    typeof currency !== 'string' ||
    currency.length !== 3 ||
    typeof status !== 'string' ||
    !STATUS_VALUES.has(status as ProviderTransactionStatus)
  ) {
    throw new Error('Invalid signed payment transaction fields.');
  }

  const fingerprint = createHash('sha256')
    .update(`${envelope.timestamp}:${checksum.toLowerCase()}`, 'utf8')
    .digest('hex');

  return {
    fingerprint,
    transactionId,
    reference,
    amountInCents,
    currency,
    status: status as ProviderTransactionStatus,
    occurredAt: new Date(envelope.timestamp * 1000),
  };
}

function propertyValue(root: unknown, path: string): string | null {
  let current: unknown = root;
  for (const part of path.split('.')) {
    if (!isRecord(current) || !Object.hasOwn(current, part)) return null;
    current = current[part];
  }
  if (typeof current === 'string') return current;
  if (typeof current === 'number' && Number.isFinite(current)) {
    return String(current);
  }
  return null;
}

function safeHexEqual(left: string, right: string): boolean {
  if (!/^[a-fA-F0-9]{64}$/.test(left) || !/^[a-fA-F0-9]{64}$/.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
