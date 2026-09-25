import { ConfigService } from '@nestjs/config';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { AppModule } from '../app.module';
import { configureApplication } from '../configure-application';
import { PaymentGateway, ProviderTransaction, ProviderTransactionStatus, PAYMENT_GATEWAY } from './payment-gateway.contract';
import { PaymentsService } from './payments.service';
import { PaymentGatewayConfigurationError } from './payment-gateway.errors';

describe('payment lifecycle API (PostgreSQL)', () => {
  let app: INestApplication;
  let database: Pool;
  let paymentsService: PaymentsService;
  let cookie: string;
  let nextCreateStatus: ProviderTransactionStatus = 'PENDING';
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
    transactions.clear();
    currentStatuses.clear();
    transactionSequence = 0;
    gateway.createTransaction.mockClear();
    gateway.getTransaction.mockClear();
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
    const created = await postPayment(checkout.id, key).expect(201);
    expect(created.body).toMatchObject({
      checkoutId: checkout.id,
      attemptNumber: 1,
      state: 'PENDING',
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
      stale_count: string;
      fulfillment_count: string;
    }>(`
      SELECT attempt.state AS attempt_state, checkout.state AS checkout_state,
             (SELECT count(*)::text FROM payment_event_receipts WHERE payment_attempt_id = attempt.id) AS receipt_count,
             (SELECT count(*)::text FROM payment_event_receipts WHERE payment_attempt_id = attempt.id AND disposition = 'STALE') AS stale_count,
             (SELECT count(*)::text FROM fulfillments WHERE checkout_id = checkout.id) AS fulfillment_count
      FROM payment_attempts AS attempt
      JOIN checkouts AS checkout ON checkout.id = attempt.checkout_id
      WHERE attempt.id = $1
    `, [created.body.attemptId]);
    expect(state.rows[0]).toEqual({
      attempt_state: 'APPROVED',
      checkout_state: 'PAID',
      receipt_count: '2',
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
    await expect(paymentsService.purgeExpiredEventReceipts()).resolves.toBe(2);
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
    await request(app.getHttpServer()).get('/api/v1/products').expect(200);
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
