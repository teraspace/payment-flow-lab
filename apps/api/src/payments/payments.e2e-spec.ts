import { ConfigService } from '@nestjs/config';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { AppModule } from '../app.module';
import { configureApplication } from '../configure-application';
import { CheckoutPiiRetentionService } from '../checkouts/checkout-pii-retention.service';
import { PaymentGateway, ProviderTransaction, ProviderTransactionStatus, PAYMENT_GATEWAY } from './payment-gateway.contract';
import { PaymentsService } from './payments.service';
import {
  PaymentGatewayConfigurationError,
  PaymentGatewayRejectedError,
  PaymentGatewayUnavailableError,
} from './payment-gateway.errors';

describe('payment lifecycle API (PostgreSQL)', () => {
  let app: INestApplication;
  let database: Pool;
  let paymentsService: PaymentsService;
  let cookie: string;
  let nextCreateStatus: ProviderTransactionStatus = 'PENDING';
  let beforeProviderCreate: ((reference: string) => Promise<void>) | undefined;
  const currentStatuses = new Map<string, ProviderTransactionStatus>();
  const transactions = new Map<string, ProviderTransaction>();
  let transactionSequence = 0;
  let previousEventSecret: string | undefined;
  let previousEnvironment: string | undefined;
  let previousReviewThreshold: string | undefined;
  let previousReceiptRetention: string | undefined;

  const eventSecret = 'event-secret-for-controlled-contract-tests';
  const paymentInput = {
    paymentToken: 'single-use-card-token-0001',
    acceptanceToken: 'terms-acceptance-token-0001',
    personalDataAuthorizationToken: 'privacy-acceptance-token-0001',
  };

  const gateway: jest.Mocked<PaymentGateway> = {
    getAcceptanceDocuments: jest.fn(),
    getTokenizationPublicKey: jest.fn(),
    tokenizeEncryptedCard: jest.fn(),
    createTransaction: jest.fn(),
    getTransaction: jest.fn(),
  };

  async function initializeSession(): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/guest-session')
      .expect(201);
    const cookieHeader = response.headers['set-cookie']?.[0] ?? '';
    const value = cookieHeader.split(';', 1)[0];
    if (!value) throw new Error('The guest-session response did not set a cookie.');
    return value;
  }

  async function createCheckout(): Promise<{ id: string; total: number }> {
    const products = await request(app.getHttpServer()).get('/api/v1/products').expect(200);
    const product = (products.body as Array<{ id: string; sku: string }>).find(
      ({ sku }) => sku === 'desk-notebook',
    );
    if (!product) throw new Error('The notebook seed product was not found.');
    const response = await request(app.getHttpServer())
      .post('/api/v1/checkouts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', `checkout-test-${Math.random().toString(36).slice(2, 18)}`)
      .send({
        productId: product.id,
        quantity: 1,
        customer: { fullName: 'Ada Lovelace', email: 'ada@example.test' },
        delivery: { recipient: 'Ada Lovelace', address: '123 Example Street' },
      })
      .expect(201);
    return { id: response.body.checkoutId as string, total: response.body.totalAmountInMinorUnits as number };
  }

  function postPayment(checkoutId: string, key: string, body = paymentInput) {
    return request(app.getHttpServer())
      .post(`/api/v1/checkouts/${checkoutId}/payment-attempts`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key)
      .send(body);
  }

  beforeAll(async () => {
    previousEventSecret = process.env.PAYMENT_GATEWAY_EVENTS_SECRET;
    previousEnvironment = process.env.PAYMENT_GATEWAY_ENVIRONMENT;
    previousReviewThreshold = process.env.PAYMENT_UNRESOLVED_REVIEW_THRESHOLD_SECONDS;
    previousReceiptRetention = process.env.PAYMENT_EVENT_RECEIPT_RETENTION_DAYS;
    process.env.PAYMENT_GATEWAY_EVENTS_SECRET = eventSecret;
    process.env.PAYMENT_GATEWAY_ENVIRONMENT = 'test';
    process.env.PAYMENT_UNRESOLVED_REVIEW_THRESHOLD_SECONDS = '1800';
    process.env.PAYMENT_EVENT_RECEIPT_RETENTION_DAYS = '365';

    gateway.createTransaction.mockImplementation(async (input) => {
      await beforeProviderCreate?.(input.reference);
      transactionSequence += 1;
      const transaction: ProviderTransaction = {
        id: `provider-tx-${transactionSequence}`,
        reference: input.reference,
        amountInCents: input.amountCop * 100,
        currency: input.currency,
        status: nextCreateStatus,
      };
      currentStatuses.set(transaction.id, transaction.status);
      transactions.set(transaction.id, transaction);
      return transaction;
    });
    gateway.getTransaction.mockImplementation(async (id) => {
      const transaction = transactions.get(id);
      if (!transaction) throw new Error('Unknown provider transaction in test fixture.');
      return { ...transaction, status: currentStatuses.get(id) ?? transaction.status };
    });
    gateway.getAcceptanceDocuments.mockResolvedValue({
      acceptanceToken: 'sandbox-terms-token',
      acceptanceUrl: 'https://documents.example.test/terms.pdf',
      personalDataAuthorizationToken: 'sandbox-privacy-token',
      personalDataAuthorizationUrl: 'https://documents.example.test/privacy.pdf',
    });
    gateway.getTokenizationPublicKey.mockResolvedValue('sandbox-public-encryption-key');
    gateway.tokenizeEncryptedCard.mockResolvedValue('tok_test_sandbox-card-token-0001');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PAYMENT_GATEWAY)
      .useValue(gateway)
      .compile();
    paymentsService = moduleRef.get(PaymentsService);
    app = moduleRef.createNestApplication({ logger: false });
    configureApplication(app, moduleRef.get(ConfigService));
    await app.init();
    database = new Pool({ connectionString: process.env.DATABASE_URL });
  });

  beforeEach(async () => {
    nextCreateStatus = 'PENDING';
    beforeProviderCreate = undefined;
    transactions.clear();
    currentStatuses.clear();
    transactionSequence = 0;
    gateway.createTransaction.mockClear();
    gateway.getTransaction.mockClear();
    gateway.getAcceptanceDocuments.mockClear();
    gateway.getTokenizationPublicKey.mockClear();
    gateway.tokenizeEncryptedCard.mockClear();
    await database.query(`
      TRUNCATE payment_event_receipts, fulfillments, payment_attempts,
               idempotency_records, reservations, checkout_items, checkouts,
               deliveries, customers, guest_sessions;
      UPDATE products
      SET physical_quantity = CASE sku
            WHEN 'desk-notebook' THEN 7
            WHEN 'urban-bottle' THEN 4
            WHEN 'canvas-tote' THEN 5
          END,
          reserved_quantity = 0,
          price_minor = CASE sku
            WHEN 'desk-notebook' THEN 29000
            WHEN 'urban-bottle' THEN 59000
            WHEN 'canvas-tote' THEN 36000
          END,
          active = true
      WHERE sku IN ('desk-notebook', 'urban-bottle', 'canvas-tote');
    `);
    cookie = await initializeSession();
  });

  it('serves acceptance documents through the local API for browser compatibility', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/payment-configuration/acceptance-documents')
      .expect(200)
      .expect({
        acceptanceToken: 'sandbox-terms-token',
        acceptanceUrl: 'https://documents.example.test/terms.pdf',
        personalDataAuthorizationToken: 'sandbox-privacy-token',
        personalDataAuthorizationUrl: 'https://documents.example.test/privacy.pdf',
      });
    expect(gateway.getAcceptanceDocuments).toHaveBeenCalledTimes(1);
  });

  it('relays only a compact encrypted card payload for sandbox tokenization', async () => {
    const encryptedPayload =
      'eyJhbGciOiJSU0EtT0FFUC0yNTYifQ.dGVzdC1rZXk.dGVzdC1pdg.dGVzdC1jaXBoZXJ0ZXh0.dGVzdC10YWc';
    await request(app.getHttpServer())
      .get('/api/v1/payment-configuration/tokenization-key')
      .expect('Cache-Control', 'no-store')
      .expect(200)
      .expect({ publicKey: 'sandbox-public-encryption-key' });
    await request(app.getHttpServer())
      .post('/api/v1/payment-configuration/card-tokens')
      .send({ payload: encryptedPayload })
      .expect('Cache-Control', 'no-store')
      .expect(201)
      .expect({ paymentToken: 'tok_test_sandbox-card-token-0001' });

    expect(gateway.getTokenizationPublicKey).toHaveBeenCalledTimes(1);
    expect(gateway.tokenizeEncryptedCard).toHaveBeenCalledWith(encryptedPayload);
  });

  it('rejects plaintext card-shaped data at the tokenization relay', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/payment-configuration/card-tokens')
      .send({ payload: '4242424242424242' })
      .expect(400);

    expect(gateway.tokenizeEncryptedCard).not.toHaveBeenCalled();
  });

  it('maps provider configuration and availability failures to safe checkout responses', async () => {
    gateway.getAcceptanceDocuments.mockRejectedValueOnce(new PaymentGatewayConfigurationError());
    await request(app.getHttpServer())
      .get('/api/v1/payment-configuration/acceptance-documents')
      .expect(503);

    gateway.getAcceptanceDocuments.mockRejectedValueOnce(new PaymentGatewayUnavailableError());
    await request(app.getHttpServer())
      .get('/api/v1/payment-configuration/acceptance-documents')
      .expect(503);

    gateway.getTokenizationPublicKey.mockRejectedValueOnce(new PaymentGatewayUnavailableError());
    await request(app.getHttpServer())
      .get('/api/v1/payment-configuration/tokenization-key')
      .expect(503);

    const encryptedPayload =
      'eyJhbGciOiJSU0EtT0FFUC0yNTYifQ.dGVzdC1rZXk.dGVzdC1pdg.dGVzdC1jaXBoZXJ0ZXh0.dGVzdC10YWc';
    gateway.tokenizeEncryptedCard.mockRejectedValueOnce(new PaymentGatewayRejectedError(422));
    await request(app.getHttpServer())
      .post('/api/v1/payment-configuration/card-tokens')
      .send({ payload: encryptedPayload })
      .expect(400);

    gateway.tokenizeEncryptedCard.mockRejectedValueOnce(new PaymentGatewayConfigurationError());
    await request(app.getHttpServer())
      .post('/api/v1/payment-configuration/card-tokens')
      .send({ payload: encryptedPayload })
      .expect(503);

    gateway.getAcceptanceDocuments.mockRejectedValueOnce(new Error('unexpected provider failure'));
    await request(app.getHttpServer())
      .get('/api/v1/payment-configuration/acceptance-documents')
      .expect(500);

    gateway.getTokenizationPublicKey.mockRejectedValueOnce(new Error('unexpected provider failure'));
    await request(app.getHttpServer())
      .get('/api/v1/payment-configuration/tokenization-key')
      .expect(500);

    gateway.tokenizeEncryptedCard.mockRejectedValueOnce(new Error('unexpected provider failure'));
    await request(app.getHttpServer())
      .post('/api/v1/payment-configuration/card-tokens')
      .send({ payload: encryptedPayload })
      .expect(500);
  });

  afterAll(async () => {
    await app.close();
    await database.query(`
      TRUNCATE payment_event_receipts, fulfillments, payment_attempts,
               idempotency_records, reservations, checkout_items, checkouts,
               deliveries, customers, guest_sessions;
    `);
    await database.end();
    if (previousEventSecret === undefined) delete process.env.PAYMENT_GATEWAY_EVENTS_SECRET;
    else process.env.PAYMENT_GATEWAY_EVENTS_SECRET = previousEventSecret;
    if (previousEnvironment === undefined) delete process.env.PAYMENT_GATEWAY_ENVIRONMENT;
    else process.env.PAYMENT_GATEWAY_ENVIRONMENT = previousEnvironment;
    if (previousReviewThreshold === undefined) delete process.env.PAYMENT_UNRESOLVED_REVIEW_THRESHOLD_SECONDS;
    else process.env.PAYMENT_UNRESOLVED_REVIEW_THRESHOLD_SECONDS = previousReviewThreshold;
    if (previousReceiptRetention === undefined) delete process.env.PAYMENT_EVENT_RECEIPT_RETENTION_DAYS;
    else process.env.PAYMENT_EVENT_RECEIPT_RETENTION_DAYS = previousReceiptRetention;
  });

  it('persists before dispatch, replays without a second charge, and reconciles approval atomically', async () => {
    const checkout = await createCheckout();
    const key = 'payment-replay-key-000001';
    beforeProviderCreate = async (reference) => {
      const persisted = await database.query<{
        state: string;
        checkout_state: string;
        provider_response_received_at: Date | null;
      }>(`
        SELECT attempt.state, checkout.state AS checkout_state,
               attempt.provider_response_received_at
        FROM payment_attempts AS attempt
        JOIN checkouts AS checkout ON checkout.id = attempt.checkout_id
        WHERE attempt.provider_reference = $1
      `, [reference]);
      expect(persisted.rows[0]).toEqual({
        state: 'PENDING',
        checkout_state: 'PAYMENT_PENDING',
        provider_response_received_at: null,
      });
    };
    const created = await postPayment(checkout.id, key).expect(201);
    expect(created.body).toMatchObject({
      checkoutId: checkout.id,
      attemptNumber: 1,
      state: 'PENDING',
      dispatching: false,
      amountCop: 42000,
      currency: 'COP',
      manualReviewRequired: false,
    });
    expect(created.body).not.toHaveProperty('paymentToken');
    expect(gateway.createTransaction).toHaveBeenCalledTimes(1);
    expect(gateway.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ amountCop: checkout.total, currency: 'COP' }),
    );

    const otherGuestCookie = await initializeSession();
    await request(app.getHttpServer())
      .get(`/api/v1/checkouts/${checkout.id}/payment-attempts/${created.body.attemptId}`)
      .set('Cookie', otherGuestCookie)
      .expect(404);

    await postPayment(checkout.id, key).expect(200);
    await postPayment(checkout.id, key, {
      ...paymentInput,
      paymentToken: 'different-single-use-token-0002',
    }).expect(409);
    expect(gateway.createTransaction).toHaveBeenCalledTimes(1);

    const latest = await request(app.getHttpServer())
      .get(`/api/v1/checkouts/${checkout.id}/payment-attempts/latest`)
      .set('Cookie', cookie)
      .expect(200);
    expect(latest.body.attemptId).toBe(created.body.attemptId);

    const attemptId = created.body.attemptId as string;
    const providerId = 'provider-tx-1';
    currentStatuses.set(providerId, 'APPROVED');
    await database.query(
      `UPDATE payment_attempts SET last_reconciled_at = now() - interval '1 minute' WHERE id = $1`,
      [attemptId],
    );
    const reconciled = await request(app.getHttpServer())
      .get(`/api/v1/checkouts/${checkout.id}/payment-attempts/${attemptId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(reconciled.body.state).toBe('APPROVED');

    const state = await database.query<{
      checkout_state: string;
      reservation_state: string;
      physical_quantity: number;
      reserved_quantity: number;
      fulfillment_count: string;
    }>(`
      SELECT checkout.state AS checkout_state,
             reservation.state AS reservation_state,
             product.physical_quantity, product.reserved_quantity,
             (SELECT count(*)::text FROM fulfillments WHERE checkout_id = checkout.id) AS fulfillment_count
      FROM checkouts AS checkout
      JOIN reservations AS reservation ON reservation.checkout_id = checkout.id
      JOIN products AS product ON product.id = reservation.product_id
      WHERE checkout.id = $1
    `, [checkout.id]);
    expect(state.rows[0]).toEqual({
      checkout_state: 'PAID',
      reservation_state: 'COMMITTED',
      physical_quantity: 6,
      reserved_quantity: 0,
      fulfillment_count: '1',
    });
  });

  it('keeps an unknown timeout held and never resends it on command replay', async () => {
    const checkout = await createCheckout();
    gateway.createTransaction.mockRejectedValueOnce(new Error('simulated connection timeout'));
    const key = 'payment-timeout-key-00001';
    const attempt = await postPayment(checkout.id, key).expect(201);
    expect(attempt.body.state).toBe('UNKNOWN_OUTCOME');

    const replay = await postPayment(checkout.id, key).expect(200);
    expect(replay.body.attemptId).toBe(attempt.body.attemptId);
    expect(gateway.createTransaction).toHaveBeenCalledTimes(1);
    await postPayment(checkout.id, 'payment-new-key-0000001').expect(409);

    const result = await database.query<{
      checkout_state: string;
      reservation_state: string;
      reserved_quantity: number;
    }>(`
      SELECT checkout.state AS checkout_state, reservation.state AS reservation_state,
             product.reserved_quantity
      FROM checkouts AS checkout
      JOIN reservations AS reservation ON reservation.checkout_id = checkout.id
      JOIN products AS product ON product.id = reservation.product_id
      WHERE checkout.id = $1
    `, [checkout.id]);
    expect(result.rows[0]).toEqual({
      checkout_state: 'UNKNOWN_OUTCOME',
      reservation_state: 'HELD',
      reserved_quantity: 1,
    });
  });

  it('reconciles an aged known pending transaction and flags it for review without releasing stock', async () => {
    const checkout = await createCheckout();
    const attempt = await postPayment(checkout.id, 'payment-review-threshold-001').expect(201);
    await database.query(
      `UPDATE payment_attempts
       SET created_at = now() - interval '31 minutes',
           last_reconciled_at = now() - interval '1 minute'
       WHERE id = $1`,
      [attempt.body.attemptId],
    );

    const reviewed = await request(app.getHttpServer())
      .get(`/api/v1/checkouts/${checkout.id}/payment-attempts/${attempt.body.attemptId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(reviewed.body).toMatchObject({ state: 'PENDING', manualReviewRequired: true });
    expect(gateway.getTransaction).toHaveBeenCalledWith('provider-tx-1');

    const inventory = await database.query<{ reservation_state: string; reserved_quantity: number }>(`
      SELECT reservation.state AS reservation_state, product.reserved_quantity
      FROM reservations AS reservation
      JOIN products AS product ON product.id = reservation.product_id
      WHERE reservation.checkout_id = $1
    `, [checkout.id]);
    expect(inventory.rows[0]).toEqual({ reservation_state: 'HELD', reserved_quantity: 1 });
    expect(gateway.createTransaction).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid payment commands and reports missing attempts without contacting the provider', async () => {
    const checkout = await createCheckout();
    await postPayment(checkout.id, 'short').expect(400);
    await postPayment('d7e3a5b1-1778-44c7-8bf4-cde6fbf317a1', 'payment-missing-key-001').expect(404);
    await request(app.getHttpServer())
      .get(`/api/v1/checkouts/${checkout.id}/payment-attempts/latest`)
      .set('Cookie', cookie)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/v1/checkouts/${checkout.id}/payment-attempts/d7e3a5b1-1778-44c7-8bf4-cde6fbf317a1`)
      .set('Cookie', cookie)
      .expect(404);
    expect(gateway.createTransaction).not.toHaveBeenCalled();
  });

  it('uses payment history as a second guard when checkout state appears eligible', async () => {
    const checkout = await createCheckout();
    const first = await postPayment(checkout.id, 'payment-history-guard-0001').expect(201);
    expect(first.body.state).toBe('PENDING');

    // Simulate a stale/incorrect checkout projection; an unreconciled charge must still block a new request.
    await database.query(`UPDATE checkouts SET state = 'RESERVED' WHERE id = $1`, [checkout.id]);
    await postPayment(checkout.id, 'payment-history-guard-0002').expect(409);
    expect(gateway.createTransaction).toHaveBeenCalledTimes(1);
  });

  it('marks a provider response with mismatched payment details for manual review and keeps stock held', async () => {
    const checkout = await createCheckout();
    gateway.createTransaction.mockImplementationOnce(async (input) => ({
      id: 'provider-tx-mismatched-amount',
      reference: input.reference,
      amountInCents: input.amountCop * 100 + 1,
      currency: input.currency,
      status: 'PENDING',
    }));

    const attempt = await postPayment(checkout.id, 'payment-mismatch-response-001').expect(201);
    expect(attempt.body).toMatchObject({ state: 'UNKNOWN_OUTCOME', manualReviewRequired: true });
    const state = await database.query<{ checkout_state: string; reservation_state: string; reserved_quantity: number }>(`
      SELECT checkout.state AS checkout_state, reservation.state AS reservation_state,
             product.reserved_quantity
      FROM checkouts AS checkout
      JOIN reservations AS reservation ON reservation.checkout_id = checkout.id
      JOIN products AS product ON product.id = reservation.product_id
      WHERE checkout.id = $1
    `, [checkout.id]);
    expect(state.rows[0]).toEqual({
      checkout_state: 'UNKNOWN_OUTCOME',
      reservation_state: 'HELD',
      reserved_quantity: 1,
    });
  });

  it('applies a confirmed void by releasing the hold and closing checkout', async () => {
    const checkout = await createCheckout();
    nextCreateStatus = 'VOIDED';
    const attempt = await postPayment(checkout.id, 'payment-provider-void-0001').expect(201);
    expect(attempt.body.state).toBe('VOIDED');
    const state = await database.query<{ checkout_state: string; reservation_state: string; reserved_quantity: number }>(`
      SELECT checkout.state AS checkout_state, reservation.state AS reservation_state,
             product.reserved_quantity
      FROM checkouts AS checkout
      JOIN reservations AS reservation ON reservation.checkout_id = checkout.id
      JOIN products AS product ON product.id = reservation.product_id
      WHERE checkout.id = $1
    `, [checkout.id]);
    expect(state.rows[0]).toEqual({ checkout_state: 'CANCELLED', reservation_state: 'RELEASED', reserved_quantity: 0 });
  });

  it('does not replay a payment command after the retention job erases its fingerprint', async () => {
    const checkout = await createCheckout();
    nextCreateStatus = 'DECLINED';
    const key = 'payment-retention-replay-001';
    const attempt = await postPayment(checkout.id, key).expect(201);
    await database.query(
      `UPDATE checkouts SET created_at = now() - interval '31 days' WHERE id = $1`,
      [checkout.id],
    );
    await expect(app.get(CheckoutPiiRetentionService).redactExpiredPersonalData()).resolves.toBe(1);

    await postPayment(checkout.id, key).expect(410);
    await postPayment(checkout.id, 'payment-after-retention-new-key-01').expect(410);
    expect(gateway.createTransaction).toHaveBeenCalledTimes(1);
    const fingerprint = await database.query<{ fingerprint: string | null }>(
      `SELECT request_fingerprint_hash AS fingerprint FROM payment_attempts WHERE id = $1`,
      [attempt.body.attemptId],
    );
    expect(fingerprint.rows[0]?.fingerprint).toBeNull();
  });

  it('keeps a proven local failure distinct from a provider attempt', async () => {
    const checkout = await createCheckout();
    gateway.createTransaction.mockRejectedValueOnce(new PaymentGatewayConfigurationError());
    const first = await postPayment(checkout.id, 'payment-local-failure-0001').expect(201);
    expect(first.body.state).toBe('FAILED_LOCAL');
    await postPayment(checkout.id, 'payment-local-failure-0001').expect(200);
    expect(gateway.createTransaction).toHaveBeenCalledTimes(1);

    const second = await postPayment(checkout.id, 'payment-local-retry-00001', {
      ...paymentInput,
      paymentToken: 'fresh-token-after-local-failure-0002',
    }).expect(201);
    expect(second.body).toMatchObject({ attemptNumber: 2, state: 'PENDING' });
    expect(gateway.createTransaction).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401])(
    'does not consume the provider retry allowance when the provider rejects HTTP %s before creating a transaction',
    async (httpStatus) => {
      const checkout = await createCheckout();
      gateway.createTransaction.mockRejectedValueOnce(new PaymentGatewayRejectedError(httpStatus));

      const rejected = await postPayment(checkout.id, `payment-rejected-${httpStatus}-key-001`).expect(201);
      expect(rejected.body.state).toBe('REJECTED_NO_TRANSACTION');
      expect(rejected.body).not.toHaveProperty('providerHttpStatus');

      const state = await database.query<{
        checkout_state: string;
        reservation_state: string;
        provider_http_status: number;
        provider_status: string | null;
        reserved_quantity: number;
      }>(`
        SELECT checkout.state AS checkout_state, reservation.state AS reservation_state,
               attempt.provider_http_status, attempt.provider_status, product.reserved_quantity
        FROM checkouts AS checkout
        JOIN reservations AS reservation ON reservation.checkout_id = checkout.id
        JOIN payment_attempts AS attempt ON attempt.checkout_id = checkout.id
        JOIN products AS product ON product.id = reservation.product_id
        WHERE checkout.id = $1
      `, [checkout.id]);
      expect(state.rows[0]).toEqual({
        checkout_state: 'RESERVED',
        reservation_state: 'HELD',
        provider_http_status: httpStatus,
        provider_status: null,
        reserved_quantity: 1,
      });

      const retried = await postPayment(checkout.id, `payment-corrected-${httpStatus}-key-001`, {
        ...paymentInput,
        paymentToken: `fresh-token-after-http-${httpStatus}`,
      }).expect(201);
      expect(retried.body).toMatchObject({ attemptNumber: 2, state: 'PENDING' });
      expect(gateway.createTransaction).toHaveBeenCalledTimes(2);
    },
  );

  it('allows one explicit retry after confirmed decline and blocks further payment attempts', async () => {
    const checkout = await createCheckout();
    nextCreateStatus = 'DECLINED';
    const first = await postPayment(checkout.id, 'payment-decline-key-00001').expect(201);
    expect(first.body.state).toBe('DECLINED');
    const initialRetryWindow = await database.query<{ seconds_left: number }>(
      `SELECT greatest(0, extract(epoch from (expires_at - now())))::int AS seconds_left
       FROM reservations WHERE checkout_id = $1`,
      [checkout.id],
    );
    expect(initialRetryWindow.rows[0]?.seconds_left).toBeGreaterThan(500);

    nextCreateStatus = 'PENDING';
    const second = await postPayment(checkout.id, 'payment-retry-key-0000001', {
      ...paymentInput,
      paymentToken: 'fresh-single-use-card-token-0002',
    }).expect(201);
    expect(second.body).toMatchObject({ attemptNumber: 2, state: 'PENDING' });

    currentStatuses.set('provider-tx-2', 'DECLINED');
    await database.query(
      `UPDATE payment_attempts SET last_reconciled_at = now() - interval '1 minute' WHERE id = $1`,
      [second.body.attemptId],
    );
    const reconciled = await request(app.getHttpServer())
      .get(`/api/v1/checkouts/${checkout.id}/payment-attempts/${second.body.attemptId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(reconciled.body.state).toBe('DECLINED');
    await postPayment(checkout.id, 'payment-third-key-000001').expect(409);
    expect(gateway.createTransaction).toHaveBeenCalledTimes(2);

    const terminal = await database.query<{
      checkout_state: string;
      reservation_state: string;
      reserved_quantity: number;
    }>(`
      SELECT checkout.state AS checkout_state, reservation.state AS reservation_state,
             product.reserved_quantity
      FROM checkouts AS checkout
      JOIN reservations AS reservation ON reservation.checkout_id = checkout.id
      JOIN products AS product ON product.id = reservation.product_id
      WHERE checkout.id = $1
    `, [checkout.id]);
    expect(terminal.rows[0]).toEqual({
      checkout_state: 'PAYMENT_FAILED',
      reservation_state: 'RELEASED',
      reserved_quantity: 0,
    });
  });

  it('verifies and deduplicates signed events and ignores an older status', async () => {
    const checkout = await createCheckout();
    const created = await postPayment(checkout.id, 'payment-webhook-key-0001').expect(201);
    const transaction = transactions.get('provider-tx-1');
    if (!transaction) throw new Error('Provider test transaction is missing.');
    const approvedTimestamp = Math.floor(Date.now() / 1000) + 2;
    const approvedEvent = signedEvent(
      { ...transaction, status: 'APPROVED' },
      approvedTimestamp,
      eventSecret,
    );

    await request(app.getHttpServer())
      .post('/api/v1/webhooks/payment-events')
      .send(approvedEvent)
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/payment-events')
      .send(signedEvent({ ...transaction, status: 'APPROVED' }, approvedTimestamp + 1, eventSecret))
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/payment-events')
      .send(approvedEvent)
      .expect(200);

    const staleEvent = signedEvent(
      { ...transaction, status: 'PENDING' },
      approvedTimestamp - 1,
      eventSecret,
    );
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/payment-events')
      .send(staleEvent)
      .expect(200);

    const state = await database.query<{
      attempt_state: string;
      checkout_state: string;
      receipt_count: string;
      duplicate_count: string;
      stale_count: string;
      fulfillment_count: string;
    }>(`
      SELECT attempt.state AS attempt_state, checkout.state AS checkout_state,
             (SELECT count(*)::text FROM payment_event_receipts WHERE payment_attempt_id = attempt.id) AS receipt_count,
             (SELECT count(*)::text FROM payment_event_receipts WHERE payment_attempt_id = attempt.id AND disposition = 'DUPLICATE') AS duplicate_count,
             (SELECT count(*)::text FROM payment_event_receipts WHERE payment_attempt_id = attempt.id AND disposition = 'STALE') AS stale_count,
             (SELECT count(*)::text FROM fulfillments WHERE checkout_id = checkout.id) AS fulfillment_count
      FROM payment_attempts AS attempt
      JOIN checkouts AS checkout ON checkout.id = attempt.checkout_id
      WHERE attempt.id = $1
    `, [created.body.attemptId]);
    expect(state.rows[0]).toEqual({
      attempt_state: 'APPROVED',
      checkout_state: 'PAID',
      receipt_count: '3',
      duplicate_count: '1',
      stale_count: '1',
      fulfillment_count: '1',
    });

    const invalid = { ...approvedEvent, timestamp: approvedTimestamp + 2 };
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/payment-events')
      .send(invalid)
      .expect(400);

    await database.query(
      `UPDATE payment_event_receipts SET received_at = now() - interval '366 days'`,
    );
    await expect(paymentsService.purgeExpiredEventReceipts()).resolves.toBe(3);
  });

  it('rejects correctly signed webhook events outside the accepted time window', async () => {
    const checkout = await createCheckout();
    const attempt = await postPayment(checkout.id, 'payment-event-time-window-01').expect(201);
    const transaction = transactions.get('provider-tx-1');
    if (!transaction) throw new Error('Provider test transaction is missing.');
    const now = Math.floor(Date.now() / 1000);

    await request(app.getHttpServer())
      .post('/api/v1/webhooks/payment-events')
      .send(signedEvent(transaction, now - 48 * 60 * 60 - 1, eventSecret))
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/payment-events')
      .send(signedEvent(transaction, now + 61, eventSecret))
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/payment-events')
      .send([])
      .expect(400);
    expect(attempt.body.state).toBe('PENDING');
    const count = await database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM payment_event_receipts',
    );
    expect(count.rows[0]?.count).toBe('0');
  });

  it('rejects sandbox events when event verification is disabled or production mode is selected', async () => {
    const checkout = await createCheckout();
    const attempt = await postPayment(checkout.id, 'payment-event-config-00001').expect(201);
    const transaction = transactions.get('provider-tx-1');
    if (!transaction) throw new Error('Provider test transaction is missing.');
    const event = signedEvent(transaction, Math.floor(Date.now() / 1000), eventSecret);

    const config = app.get(ConfigService);
    config.set('PAYMENT_GATEWAY_EVENTS_SECRET', '   ');
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/payment-events')
      .send(event)
      .expect(503);

    config.set('PAYMENT_GATEWAY_EVENTS_SECRET', eventSecret);
    config.set('PAYMENT_GATEWAY_ENVIRONMENT', 'prod');
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/payment-events')
      .send(event)
      .expect(503);

    config.set('PAYMENT_GATEWAY_ENVIRONMENT', 'test');
    const count = await database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM payment_event_receipts',
    );
    expect(attempt.body.state).toBe('PENDING');
    expect(count.rows[0]?.count).toBe('0');
  });

  it('deduplicates a repeated confirmed decline and flags a stale conflicting status', async () => {
    const checkout = await createCheckout();
    nextCreateStatus = 'DECLINED';
    const created = await postPayment(checkout.id, 'payment-terminal-event-0001').expect(201);
    const transaction = transactions.get('provider-tx-1');
    if (!transaction) throw new Error('Provider test transaction is missing.');
    const timestamp = Math.floor(Date.now() / 1000) + 2;

    await request(app.getHttpServer())
      .post('/api/v1/webhooks/payment-events')
      .send(signedEvent(transaction, timestamp, eventSecret))
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/payment-events')
      .send(signedEvent(transaction, timestamp + 1, eventSecret))
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/payment-events')
      .send(signedEvent({ ...transaction, status: 'PENDING' }, timestamp + 2, eventSecret))
      .expect(200);

    const persisted = await database.query<{
      state: string;
      manual_review_required_at: Date | null;
      duplicate_count: string;
      stale_count: string;
      checkout_state: string;
      reservation_state: string;
      reserved_quantity: number;
    }>(`
      SELECT attempt.state, attempt.manual_review_required_at,
             (SELECT count(*)::text FROM payment_event_receipts
              WHERE payment_attempt_id = attempt.id AND disposition = 'DUPLICATE') AS duplicate_count,
             (SELECT count(*)::text FROM payment_event_receipts
              WHERE payment_attempt_id = attempt.id AND disposition = 'STALE') AS stale_count,
             checkout.state AS checkout_state, reservation.state AS reservation_state,
             product.reserved_quantity
      FROM payment_attempts AS attempt
      JOIN checkouts AS checkout ON checkout.id = attempt.checkout_id
      JOIN reservations AS reservation ON reservation.checkout_id = checkout.id
      JOIN products AS product ON product.id = reservation.product_id
      WHERE attempt.id = $1
    `, [created.body.attemptId]);

    expect(persisted.rows[0]).toMatchObject({
      state: 'DECLINED',
      manual_review_required_at: expect.any(Date),
      duplicate_count: '2',
      stale_count: '1',
      checkout_state: 'PAYMENT_FAILED',
      reservation_state: 'HELD',
      reserved_quantity: 1,
    });
  });

  it('reconciles known transactions after temporary provider failures', async () => {
    const checkout = await createCheckout();
    const created = await postPayment(checkout.id, 'payment-batch-reconcile-01').expect(201);
    await database.query(
      `UPDATE payment_attempts SET last_reconciled_at = now() - interval '1 minute' WHERE id = $1`,
      [created.body.attemptId],
    );
    gateway.getTransaction.mockRejectedValueOnce(new PaymentGatewayUnavailableError());

    await (paymentsService as unknown as { reconcileDueAttempts: () => Promise<void> })
      .reconcileDueAttempts();

    const deferred = await database.query<{
      state: string;
      reconciliation_lease_until: Date | null;
    }>(`SELECT state, reconciliation_lease_until FROM payment_attempts WHERE id = $1`, [created.body.attemptId]);
    expect(deferred.rows[0]).toMatchObject({ state: 'PENDING', reconciliation_lease_until: null });

    currentStatuses.set('provider-tx-1', 'APPROVED');
    await database.query(
      `UPDATE payment_attempts SET last_reconciled_at = now() - interval '1 minute' WHERE id = $1`,
      [created.body.attemptId],
    );
    await (paymentsService as unknown as { reconcileDueAttempts: () => Promise<void> })
      .reconcileDueAttempts();

    const completed = await database.query<{
      state: string;
      checkout_state: string;
      reservation_state: string;
      physical_quantity: number;
      reserved_quantity: number;
    }>(`
      SELECT attempt.state, checkout.state AS checkout_state, reservation.state AS reservation_state,
             product.physical_quantity, product.reserved_quantity
      FROM payment_attempts AS attempt
      JOIN checkouts AS checkout ON checkout.id = attempt.checkout_id
      JOIN reservations AS reservation ON reservation.checkout_id = checkout.id
      JOIN products AS product ON product.id = reservation.product_id
      WHERE attempt.id = $1
    `, [created.body.attemptId]);
    expect(completed.rows[0]).toEqual({
      state: 'APPROVED',
      checkout_state: 'PAID',
      reservation_state: 'COMMITTED',
      physical_quantity: 6,
      reserved_quantity: 0,
    });
  });

  it('turns a stale dispatch without a provider id into an unknown outcome for review', async () => {
    const checkout = await createCheckout();
    const created = await postPayment(checkout.id, 'payment-stale-dispatch-01').expect(201);
    await database.query(
      `UPDATE payment_attempts
       SET state = 'DISPATCHING', provider_transaction_id = NULL,
           provider_response_received_at = NULL,
           dispatch_started_at = now() - interval '1 minute',
           created_at = now() - interval '31 minutes', last_reconciled_at = NULL
       WHERE id = $1`,
      [created.body.attemptId],
    );

    await (paymentsService as unknown as { reconcileDueAttempts: () => Promise<void> })
      .reconcileDueAttempts();

    const recovered = await database.query<{
      state: string;
      checkout_state: string;
      manual_review_required_at: Date | null;
      reconciliation_lease_until: Date | null;
      reservation_state: string;
      reserved_quantity: number;
    }>(`
      SELECT attempt.state, checkout.state AS checkout_state, attempt.manual_review_required_at,
             attempt.reconciliation_lease_until, reservation.state AS reservation_state,
             product.reserved_quantity
      FROM payment_attempts AS attempt
      JOIN checkouts AS checkout ON checkout.id = attempt.checkout_id
      JOIN reservations AS reservation ON reservation.checkout_id = checkout.id
      JOIN products AS product ON product.id = reservation.product_id
      WHERE attempt.id = $1
    `, [created.body.attemptId]);
    expect(recovered.rows[0]).toMatchObject({
      state: 'UNKNOWN_OUTCOME',
      checkout_state: 'UNKNOWN_OUTCOME',
      manual_review_required_at: expect.any(Date),
      reconciliation_lease_until: null,
      reservation_state: 'HELD',
      reserved_quantity: 1,
    });
  });

  it('records a correctly signed event without a matching payment attempt', async () => {
    const transaction: ProviderTransaction = {
      id: 'provider-tx-without-local-attempt',
      reference: 'pfl_unknown_but_valid_signature',
      amountInCents: 4200000,
      currency: 'COP',
      status: 'APPROVED',
    };
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/payment-events')
      .send(signedEvent(transaction, Math.floor(Date.now() / 1000), eventSecret))
      .expect(200);

    const receipt = await database.query<{ disposition: string; payment_attempt_id: string | null }>(
      'SELECT disposition, payment_attempt_id FROM payment_event_receipts',
    );
    expect(receipt.rows).toEqual([{ disposition: 'UNMATCHED', payment_attempt_id: null }]);
  });

  it('flags a newer contradictory void after approval for manual review', async () => {
    const checkout = await createCheckout();
    const created = await postPayment(checkout.id, 'payment-contradictory-status-001').expect(201);
    const transaction = transactions.get('provider-tx-1');
    if (!transaction) throw new Error('Provider test transaction is missing.');
    const approvedTimestamp = Math.floor(Date.now() / 1000) + 2;

    await request(app.getHttpServer())
      .post('/api/v1/webhooks/payment-events')
      .send(signedEvent({ ...transaction, status: 'APPROVED' }, approvedTimestamp, eventSecret))
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/payment-events')
      .send(signedEvent({ ...transaction, status: 'VOIDED' }, approvedTimestamp + 1, eventSecret))
      .expect(200);

    const status = await request(app.getHttpServer())
      .get(`/api/v1/checkouts/${checkout.id}/payment-attempts/${created.body.attemptId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(status.body).toMatchObject({ state: 'APPROVED', manualReviewRequired: true });

    const persisted = await database.query<{
      checkout_state: string;
      reservation_state: string;
      fulfillment_state: string;
      disposition: string;
    }>(`
      SELECT checkout.state AS checkout_state, reservation.state AS reservation_state,
             fulfillment.state AS fulfillment_state, receipt.disposition
      FROM checkouts AS checkout
      JOIN reservations AS reservation ON reservation.checkout_id = checkout.id
      JOIN fulfillments AS fulfillment ON fulfillment.checkout_id = checkout.id
      JOIN payment_event_receipts AS receipt ON receipt.payment_attempt_id = $2
       AND receipt.provider_status = 'VOIDED'
      WHERE checkout.id = $1
    `, [checkout.id, created.body.attemptId]);
    expect(persisted.rows[0]).toEqual({
      checkout_state: 'PAID',
      reservation_state: 'COMMITTED',
      fulfillment_state: 'READY',
      disposition: 'CONTRADICTORY',
    });
  });

  it('escalates an old unknown without releasing its hold', async () => {
    const checkout = await createCheckout();
    gateway.createTransaction.mockRejectedValueOnce(new Error('simulated timeout'));
    const created = await postPayment(checkout.id, 'payment-old-unknown-0001').expect(201);
    await database.query(
      `UPDATE payment_attempts SET created_at = now() - interval '31 minutes',
         unknown_outcome_at = now() - interval '31 minutes' WHERE id = $1`,
      [created.body.attemptId],
    );

    const status = await request(app.getHttpServer())
      .get(`/api/v1/checkouts/${checkout.id}/payment-attempts/${created.body.attemptId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(status.body).toMatchObject({
      state: 'UNKNOWN_OUTCOME',
      manualReviewRequired: true,
    });
    const reservation = await database.query<{ state: string; reserved_quantity: number }>(`
      SELECT reservation.state, product.reserved_quantity
      FROM reservations AS reservation
      JOIN products AS product ON product.id = reservation.product_id
      WHERE reservation.checkout_id = $1
    `, [checkout.id]);
    expect(reservation.rows[0]).toEqual({ state: 'HELD', reserved_quantity: 1 });
  });

  it('records a late approval as a fulfillment exception after releasing inventory', async () => {
    const checkout = await createCheckout();
    const created = await postPayment(checkout.id, 'payment-late-approval-001').expect(201);
    currentStatuses.set('provider-tx-1', 'DECLINED');
    await database.query(
      `UPDATE payment_attempts SET last_reconciled_at = now() - interval '1 minute' WHERE id = $1`,
      [created.body.attemptId],
    );
    await request(app.getHttpServer())
      .get(`/api/v1/checkouts/${checkout.id}/payment-attempts/${created.body.attemptId}`)
      .set('Cookie', cookie)
      .expect(200);

    await database.query(
      `UPDATE reservations SET expires_at = now() - interval '1 second' WHERE checkout_id = $1`,
      [checkout.id],
    );
    const providerTransaction = transactions.get('provider-tx-1');
    if (!providerTransaction) throw new Error('Provider test transaction is missing.');
    const lateApproval = signedEvent(
      { ...providerTransaction, status: 'APPROVED' },
      Math.floor(Date.now() / 1000) + 2,
      eventSecret,
    );
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/payment-events')
      .send(lateApproval)
      .expect(200);
    expect(created.body.state).toBe('PENDING');
    const state = await database.query<{
      checkout_state: string;
      reservation_state: string;
      physical_quantity: number;
      reserved_quantity: number;
      fulfillment_state: string;
    }>(`
      SELECT checkout.state AS checkout_state, reservation.state AS reservation_state,
             product.physical_quantity, product.reserved_quantity,
             fulfillment.state AS fulfillment_state
      FROM checkouts AS checkout
      JOIN reservations AS reservation ON reservation.checkout_id = checkout.id
      JOIN products AS product ON product.id = reservation.product_id
      JOIN fulfillments AS fulfillment ON fulfillment.checkout_id = checkout.id
      WHERE checkout.id = $1
    `, [checkout.id]);
    expect(state.rows[0]).toEqual({
      checkout_state: 'FULFILLMENT_EXCEPTION',
      reservation_state: 'RELEASED',
      physical_quantity: 7,
      reserved_quantity: 0,
      fulfillment_state: 'FULFILLMENT_EXCEPTION',
    });
  });

  it('serializes expiry and a late approval without losing inventory consistency', async () => {
    const checkout = await createCheckout();
    nextCreateStatus = 'DECLINED';
    await postPayment(checkout.id, 'payment-expiry-race-000001').expect(201);
    const transaction = transactions.get('provider-tx-1');
    if (!transaction) throw new Error('Provider test transaction is missing.');

    await database.query(
      `UPDATE reservations SET expires_at = now() - interval '1 second' WHERE checkout_id = $1`,
      [checkout.id],
    );
    const lateApproval = signedEvent(
      { ...transaction, status: 'APPROVED' },
      Math.floor(Date.now() / 1000) + 2,
      eventSecret,
    );

    const [catalog, event] = await Promise.all([
      request(app.getHttpServer()).get('/api/v1/products'),
      request(app.getHttpServer()).post('/api/v1/webhooks/payment-events').send(lateApproval),
    ]);
    expect(catalog.status).toBe(200);
    expect(event.status).toBe(200);

    const state = await database.query<{
      checkout_state: string;
      reservation_state: string;
      physical_quantity: number;
      reserved_quantity: number;
      fulfillment_state: string | null;
    }>(`
      SELECT checkout.state AS checkout_state, reservation.state AS reservation_state,
             product.physical_quantity, product.reserved_quantity, fulfillment.state AS fulfillment_state
      FROM checkouts AS checkout
      JOIN reservations AS reservation ON reservation.checkout_id = checkout.id
      JOIN products AS product ON product.id = reservation.product_id
      LEFT JOIN fulfillments AS fulfillment ON fulfillment.checkout_id = checkout.id
      WHERE checkout.id = $1
    `, [checkout.id]);

    expect(state.rows[0]).toEqual({
      checkout_state: 'FULFILLMENT_EXCEPTION',
      reservation_state: 'RELEASED',
      physical_quantity: 7,
      reserved_quantity: 0,
      fulfillment_state: 'FULFILLMENT_EXCEPTION',
    });
  });
});

function signedEvent(
  transaction: ProviderTransaction,
  timestamp: number,
  secret: string,
): Record<string, unknown> {
  const providerTransaction = {
    id: transaction.id,
    status: transaction.status,
    amount_in_cents: transaction.amountInCents,
    currency: transaction.currency,
    reference: transaction.reference,
  };
  const properties = [
    'transaction.id',
    'transaction.status',
    'transaction.amount_in_cents',
    'transaction.currency',
    'transaction.reference',
  ];
  const values = [
    providerTransaction.id,
    providerTransaction.status,
    String(providerTransaction.amount_in_cents),
    providerTransaction.currency,
    providerTransaction.reference,
  ].join('');
  const checksum = createHash('sha256')
    .update(`${values}${timestamp}${secret}`)
    .digest('hex');

  return {
    event: 'transaction.updated',
    data: { transaction: providerTransaction },
    environment: 'test',
    signature: { properties, checksum },
    timestamp,
  };
}
