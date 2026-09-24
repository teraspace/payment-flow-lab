import { ConfigService } from '@nestjs/config';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../app.module';
import { configureApplication } from '../configure-application';

describe('checkout API (PostgreSQL)', () => {
  let app: INestApplication;
  let database: Pool;
  let cookie: string;

  const productSkus = {
    notebook: 'desk-notebook',
    bottle: 'urban-bottle',
    tote: 'canvas-tote',
  };

  const checkoutPayload = (productId: string, quantity = 1) => ({
    productId,
    quantity,
    customer: {
      fullName: '  Ada Lovelace  ',
      email: ' ADA@example.test ',
    },
    delivery: {
      recipient: ' Ada Lovelace ',
      address: ' 123 Example Street, Apartment 4 ',
    },
  });

  async function initializeSession(): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/guest-session')
      .expect(201);
    const setCookie = response.headers['set-cookie'];
    const cookieEntry = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (!cookieEntry) throw new Error('The guest-session response did not set a cookie.');
    return cookieEntry.split(';', 1)[0];
  }

  async function getProducts(): Promise<Record<string, unknown>[]> {
    const response = await request(app.getHttpServer())
      .get('/api/v1/products')
      .expect(200);
    return response.body as Record<string, unknown>[];
  }

  async function getProductId(sku: string): Promise<string> {
    const products = await getProducts();
    const product = products.find((candidate) => candidate.sku === sku);
    if (typeof product?.id !== 'string') throw new Error(`Missing product ${sku}.`);
    return product.id;
  }

  function postCheckout(
    guestCookie: string,
    idempotencyKey: string,
    payload: Record<string, unknown>,
  ) {
    return request(app.getHttpServer())
      .post('/api/v1/checkouts')
      .set('Cookie', guestCookie)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApplication(app, moduleRef.get(ConfigService));
    await app.init();
    database = new Pool({ connectionString: process.env.DATABASE_URL });
  });

  beforeEach(async () => {
    await database.query(`
      DROP TRIGGER IF EXISTS fail_test_reservation_insert ON reservations;
      DROP FUNCTION IF EXISTS fail_test_reservation_insert();
      TRUNCATE idempotency_records, reservations, checkout_items, checkouts,
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
    await database.end();
  });

  it('lists seeded products with derived availability and returns product detail', async () => {
    const products = await getProducts();
    const notebook = products.find((product) => product.sku === productSkus.notebook);

    expect(products).toHaveLength(3);
    expect(notebook).toMatchObject({
      name: 'Cuaderno de puntos',
      unitPriceMinor: 29000,
      currency: 'COP',
      physicalQuantity: 7,
      reservedQuantity: 0,
      availableQuantity: 7,
      imageUrl: '/catalog/notebook.svg',
    });

    await request(app.getHttpServer())
      .get(`/api/v1/products/${notebook?.id as string}`)
      .expect(200)
      .expect(({ body }) => expect(body.id).toBe(notebook?.id));
    await request(app.getHttpServer())
      .get('/api/v1/products/00000000-0000-4000-8000-000000000000')
      .expect(404);
  });

  it('sets an HttpOnly guest cookie and requires it to create or read a checkout', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/guest-session')
      .expect(201);

    const setCookie = response.headers['set-cookie']?.[0] ?? '';
    const sessionCookie = setCookie.split(';', 1)[0];
    if (!sessionCookie) throw new Error('The guest-session response did not set a cookie.');
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toHaveProperty('token');

    await request(app.getHttpServer())
      .post('/api/v1/guest-session')
      .set('Cookie', sessionCookie)
      .expect(200)
      .expect(({ headers }) => expect(headers['set-cookie']).toBeUndefined());

    const productId = await getProductId(productSkus.notebook);
    await request(app.getHttpServer())
      .post('/api/v1/checkouts')
      .set('Idempotency-Key', 'no-session-key-0001')
      .send(checkoutPayload(productId))
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/checkouts/00000000-0000-4000-8000-000000000000')
      .expect(401);
  });

  it('removes expired guest sessions that never owned a checkout', async () => {
    await database.query(`
      UPDATE guest_sessions
      SET created_at = now() - interval '2 seconds',
          expires_at = now() - interval '1 second'
    `);

    await request(app.getHttpServer())
      .post('/api/v1/guest-session')
      .expect(201);

    const result = await database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM guest_sessions',
    );
    expect(result.rows[0]?.count).toBe('1');
  });

  it('creates a server-priced checkout and replays it for equivalent input', async () => {
    const productId = await getProductId(productSkus.notebook);
    const key = 'checkout-replay-key-0001';
    const payload = checkoutPayload(productId);
    const created = await postCheckout(cookie, key, {
      ...payload,
      totalAmountInMinorUnits: 1,
    }).expect(201);

    expect(created.body).toMatchObject({
      state: 'RESERVED',
      customer: { fullName: 'Ada Lovelace', email: 'ada@example.test' },
      delivery: {
        recipient: 'Ada Lovelace',
        address: '123 Example Street, Apartment 4',
      },
      item: {
        sku: 'desk-notebook',
        quantity: 1,
        unitPriceMinor: 29000,
        lineTotalMinor: 29000,
      },
      subtotalMinor: 29000,
      baseFeeMinor: 5000,
      deliveryFeeMinor: 8000,
      totalAmountInMinorUnits: 42000,
      currency: 'COP',
      reservation: { state: 'HELD' },
    });

    await database.query(
      "UPDATE products SET price_minor = 35000 WHERE sku = 'desk-notebook'",
    );

    const replayed = await postCheckout(cookie, key, {
      ...checkoutPayload(productId),
      totalAmountInMinorUnits: 999999,
    }).expect(200);

    expect(replayed.body.checkoutId).toBe(created.body.checkoutId);
    expect(replayed.body.totalAmountInMinorUnits).toBe(42000);
    expect(replayed.body.item.unitPriceMinor).toBe(29000);

    const product = (await getProducts()).find((entry) => entry.sku === productSkus.notebook);
    expect(product?.availableQuantity).toBe(6);
    const counts = await database.query<{
      checkout_count: string;
      reservation_count: string;
      idempotency_count: string;
    }>(`
      SELECT
        (SELECT count(*) FROM checkouts) AS checkout_count,
        (SELECT count(*) FROM reservations) AS reservation_count,
        (SELECT count(*) FROM idempotency_records) AS idempotency_count
    `);
    expect(counts.rows[0]).toEqual({
      checkout_count: '1',
      reservation_count: '1',
      idempotency_count: '1',
    });
  });

  it('rejects reuse of a key with a different business payload without changing stock', async () => {
    const productId = await getProductId(productSkus.notebook);
    const key = 'checkout-conflict-key-01';
    const first = await postCheckout(cookie, key, checkoutPayload(productId)).expect(201);

    await postCheckout(cookie, key, checkoutPayload(productId, 2))
      .expect(409)
      .expect(({ body }) => expect(body.message).toMatch(/different checkout request/i));

    const product = (await getProducts()).find((entry) => entry.sku === productSkus.notebook);
    expect(product?.availableQuantity).toBe(6);
    const checkouts = await database.query<{ id: string }>('SELECT id FROM checkouts');
    expect(checkouts.rows).toEqual([{ id: first.body.checkoutId }]);
  });

  it('isolates the same idempotency key across different guest sessions', async () => {
    const productId = await getProductId(productSkus.notebook);
    const otherCookie = await initializeSession();
    const key = 'checkout-session-key-001';

    const [first, second] = await Promise.all([
      postCheckout(cookie, key, checkoutPayload(productId)),
      postCheckout(otherCookie, key, checkoutPayload(productId)),
    ]);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.checkoutId).not.toBe(second.body.checkoutId);
    const counts = await database.query<{ checkout_count: string }>(
      'SELECT count(*) AS checkout_count FROM checkouts',
    );
    expect(counts.rows[0]?.checkout_count).toBe('2');
  });

  it('does not let another guest read a checkout by its identifier', async () => {
    const productId = await getProductId(productSkus.notebook);
    const created = await postCheckout(
      cookie,
      'checkout-owner-scope-key-01',
      checkoutPayload(productId),
    ).expect(201);
    const otherCookie = await initializeSession();

    await request(app.getHttpServer())
      .get(`/api/v1/checkouts/${created.body.checkoutId}`)
      .set('Cookie', otherCookie)
      .expect(404);
  });

  it('does not consume an idempotency key when stock rejects the command', async () => {
    const productId = await getProductId(productSkus.notebook);
    const key = 'stock-retry-idempotency-01';
    await database.query(
      "UPDATE products SET physical_quantity = 0 WHERE sku = 'desk-notebook'",
    );

    await postCheckout(cookie, key, checkoutPayload(productId)).expect(409);
    const noRecord = await database.query<{ count: string }>(
      'SELECT count(*) AS count FROM idempotency_records',
    );
    expect(noRecord.rows[0]?.count).toBe('0');

    await database.query(
      "UPDATE products SET physical_quantity = 1 WHERE sku = 'desk-notebook'",
    );
    await postCheckout(cookie, key, checkoutPayload(productId)).expect(201);
  });

  it('allows only one buyer to reserve the final unit using concurrent connections', async () => {
    const productId = await getProductId(productSkus.notebook);
    await database.query(
      "UPDATE products SET physical_quantity = 1 WHERE sku = 'desk-notebook'",
    );
    const secondCookie = await initializeSession();

    const results = await Promise.all([
      postCheckout(cookie, 'last-unit-buyer-one-001', checkoutPayload(productId)),
      postCheckout(secondCookie, 'last-unit-buyer-two-001', checkoutPayload(productId)),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    const product = (await getProducts()).find((entry) => entry.sku === productSkus.notebook);
    expect(product?.physicalQuantity).toBe(1);
    expect(product?.reservedQuantity).toBe(1);
    expect(product?.availableQuantity).toBe(0);
    const rows = await database.query<{
      checkout_count: string;
      reservation_count: string;
    }>(`
      SELECT
        (SELECT count(*) FROM checkouts) AS checkout_count,
        (SELECT count(*) FROM reservations WHERE state = 'HELD') AS reservation_count
    `);
    expect(rows.rows[0]).toEqual({ checkout_count: '1', reservation_count: '1' });
  });

  it('returns one checkout for concurrent replays of the same command', async () => {
    const productId = await getProductId(productSkus.notebook);
    const key = 'concurrent-replay-command-01';
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        postCheckout(cookie, key, checkoutPayload(productId)),
      ),
    );

    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(5);
    expect(new Set(responses.map((response) => response.body.checkoutId)).size).toBe(1);
    const counts = await database.query<{
      checkout_count: string;
      reservation_count: string;
      reserved_quantity: number;
    }>(`
      SELECT
        (SELECT count(*) FROM checkouts) AS checkout_count,
        (SELECT count(*) FROM reservations) AS reservation_count,
        (SELECT reserved_quantity FROM products WHERE sku = 'desk-notebook')
          AS reserved_quantity
    `);
    expect(counts.rows[0]).toEqual({
      checkout_count: '1',
      reservation_count: '1',
      reserved_quantity: 1,
    });
  });

  it('releases an expired reservation once and restores availability', async () => {
    const productId = await getProductId(productSkus.notebook);
    const created = await postCheckout(
      cookie,
      'reservation-expiry-test-001',
      checkoutPayload(productId),
    ).expect(201);

    await database.query(
      `UPDATE reservations
       SET expires_at = now() - interval '1 second'
       WHERE checkout_id = $1`,
      [created.body.checkoutId],
    );
    await database.query(
      `UPDATE checkouts
       SET reservation_expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [created.body.checkoutId],
    );

    const firstProductsRead = await getProducts();
    const secondProductsRead = await getProducts();
    const notebook = firstProductsRead.find((entry) => entry.sku === productSkus.notebook);
    const notebookAgain = secondProductsRead.find(
      (entry) => entry.sku === productSkus.notebook,
    );
    expect(notebook?.availableQuantity).toBe(7);
    expect(notebookAgain?.reservedQuantity).toBe(0);

    const recovered = await request(app.getHttpServer())
      .get(`/api/v1/checkouts/${created.body.checkoutId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(recovered.body.state).toBe('EXPIRED');
    expect(recovered.body.reservation.state).toBe('RELEASED');
  });

  it('rolls back the key, checkout, customer and stock if reservation persistence fails', async () => {
    const productId = await getProductId(productSkus.notebook);
    await database.query(`
      CREATE FUNCTION fail_test_reservation_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced reservation insert failure';
      END;
      $$;
      CREATE TRIGGER fail_test_reservation_insert
      BEFORE INSERT ON reservations
      FOR EACH ROW EXECUTE FUNCTION fail_test_reservation_insert();
    `);

    try {
      await postCheckout(
        cookie,
        'transaction-rollback-test-001',
        checkoutPayload(productId),
      ).expect(500);
    } finally {
      await database.query(`
        DROP TRIGGER IF EXISTS fail_test_reservation_insert ON reservations;
        DROP FUNCTION IF EXISTS fail_test_reservation_insert();
      `);
    }

    const rolledBack = await database.query<{
      checkouts: string;
      customers: string;
      reservations: string;
      idempotency_records: string;
      reserved_quantity: number;
    }>(`
      SELECT
        (SELECT count(*) FROM checkouts) AS checkouts,
        (SELECT count(*) FROM customers) AS customers,
        (SELECT count(*) FROM reservations) AS reservations,
        (SELECT count(*) FROM idempotency_records) AS idempotency_records,
        (SELECT reserved_quantity FROM products WHERE sku = 'desk-notebook')
          AS reserved_quantity
    `);
    expect(rolledBack.rows[0]).toEqual({
      checkouts: '0',
      customers: '0',
      reservations: '0',
      idempotency_records: '0',
      reserved_quantity: 0,
    });

    await postCheckout(
      cookie,
      'transaction-rollback-test-001',
      checkoutPayload(productId),
    ).expect(201);
  });
});
