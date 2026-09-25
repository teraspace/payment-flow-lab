import { createHash } from 'node:crypto';
import {
  createIntegritySignature,
  ProviderEventEnvelope,
  verifyProviderEvent,
} from './payment-signatures';

describe('payment signatures', () => {
  it('creates the server-side integrity signature from amount, currency, and reference', () => {
    const signature = createIntegritySignature(
      'checkout-attempt-001',
      42_000,
      'COP',
      'integrity-secret-for-tests',
    );

    expect(signature).toBe(
      createHash('sha256')
        .update('checkout-attempt-00142000COPintegrity-secret-for-tests')
        .digest('hex'),
    );
  });

  it('verifies the signed properties in the supplied order and returns a minimal event', () => {
    const eventSecret = 'event-secret-for-tests';
    const timestamp = 1_790_000_000;
    const envelope = signedEvent(timestamp, eventSecret);

    expect(verifyProviderEvent(envelope, eventSecret, 'test')).toMatchObject({
      transactionId: 'provider-tx-001',
      reference: 'attempt-ref-001',
      amountInCents: 4_200_000,
      currency: 'COP',
      status: 'APPROVED',
      occurredAt: new Date(timestamp * 1000),
    });
  });

  it('accepts the matching optional checksum header case-insensitively', () => {
    const envelope = signedEvent(1_790_000_000, 'event-secret-for-tests');
    const signature = envelope.signature as { checksum: string };

    expect(() =>
      verifyProviderEvent(
        envelope,
        'event-secret-for-tests',
        'test',
        signature.checksum.toUpperCase(),
      ),
    ).not.toThrow();
  });

  it('rejects altered transaction data, mismatched environments, and conflicting headers', () => {
    const secret = 'event-secret-for-tests';
    const envelope = signedEvent(1_790_000_000, secret);
    const altered = structuredClone(envelope);
    ((altered.data as Record<string, unknown>).transaction as Record<string, unknown>)[
      'amount_in_cents'
    ] = 4_300_000;

    expect(() => verifyProviderEvent(altered, secret, 'test')).toThrow(
      'Payment event signature verification failed.',
    );
    expect(() => verifyProviderEvent(envelope, secret, 'prod')).toThrow(
      'Invalid payment event envelope.',
    );
    expect(() =>
      verifyProviderEvent(envelope, secret, 'test', '0'.repeat(64)),
    ).toThrow('Conflicting payment event checksums.');
  });

  it('rejects unsafe property paths and values not covered by the signature', () => {
    const secret = 'event-secret-for-tests';
    const unsafe = signedEvent(1_790_000_000, secret);
    ((unsafe.signature as { properties: string[] }).properties[0]) =
      'transaction.__proto__.id';

    expect(() => verifyProviderEvent(unsafe, secret, 'test')).toThrow(
      'Invalid payment event signature property.',
    );

    const missing = signedEvent(1_790_000_000, secret);
    ((missing.signature as { properties: string[] }).properties[0]) =
      'transaction.not_present';
    expect(() => verifyProviderEvent(missing, secret, 'test')).toThrow(
      'Missing signed payment event value.',
    );
  });
});

function signedEvent(
  timestamp: number,
  eventSecret: string,
): ProviderEventEnvelope {
  const transaction = {
    id: 'provider-tx-001',
    status: 'APPROVED',
    amount_in_cents: 4_200_000,
    currency: 'COP',
    reference: 'attempt-ref-001',
  };
  const properties = [
    'transaction.id',
    'transaction.status',
    'transaction.amount_in_cents',
    'transaction.currency',
    'transaction.reference',
  ];
  const signedValues = [
    transaction.id,
    transaction.status,
    String(transaction.amount_in_cents),
    transaction.currency,
    transaction.reference,
  ].join('');
  const checksum = createHash('sha256')
    .update(`${signedValues}${timestamp}${eventSecret}`)
    .digest('hex');

  return {
    event: 'transaction.updated',
    data: { transaction },
    environment: 'test',
    signature: { properties, checksum },
    timestamp,
  };
}
