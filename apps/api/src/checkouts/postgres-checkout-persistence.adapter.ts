import { Injectable } from '@nestjs/common';
import { PoolClient, QueryResultRow } from 'pg';
import { Result } from '../core/result';
import { DatabaseService } from '../database/database.service';
import { PostgresReservationExpirationAdapter } from '../inventory/postgres-reservation-expiration.adapter';
import {
  CheckoutIdempotencyRecord,
  CheckoutPersistencePort,
  CheckoutTransactionPort,
  CheckoutView,
  CreateCheckoutSnapshot,
  ProductReservationResult,
} from './checkout-persistence.port';

interface ProductReservationRow extends QueryResultRow {
  id: string;
  sku: string;
  name: string;
  price_minor: string;
  currency: string;
}

interface CheckoutRow extends QueryResultRow {
  id: string;
  state: CheckoutView['state'];
  subtotal_minor: string;
  base_fee_minor: string;
  delivery_fee_minor: string;
  total_minor: string;
  currency: string;
  reservation_expires_at: Date;
  created_at: Date;
  customer_name: string | null;
  customer_email: string | null;
  recipient: string | null;
  delivery_address: string | null;
  reservation_state: CheckoutView['reservation']['state'];
  product_id: string;
  product_sku: string;
  product_name: string;
  quantity: number;
  unit_price_minor: string;
  line_total_minor: string;
}

interface IdempotencyRow extends QueryResultRow, CheckoutIdempotencyRecord {}

@Injectable()
export class PostgresCheckoutPersistenceAdapter implements CheckoutPersistencePort {
  constructor(
    private readonly database: DatabaseService,
    private readonly reservationExpiration: PostgresReservationExpirationAdapter,
  ) {}

  transaction<T>(work: (unitOfWork: CheckoutTransactionPort) => Promise<T>): Promise<T> {
    return this.database.transaction((client) =>
      work(new PostgresCheckoutUnitOfWork(client, this.reservationExpiration)),
    );
  }

  transactionResult<T, F>(
    work: (unitOfWork: CheckoutTransactionPort) => Promise<Result<T, F>>,
  ): Promise<Result<T, F>> {
    return this.database.transactionResult((client) =>
      work(new PostgresCheckoutUnitOfWork(client, this.reservationExpiration)),
    );
  }
}

class PostgresCheckoutUnitOfWork implements CheckoutTransactionPort {
  constructor(
    private readonly client: PoolClient,
    private readonly reservationExpiration: PostgresReservationExpirationAdapter,
  ) {}

  async releaseExpiredReservations(): Promise<number> {
    return this.reservationExpiration.releaseExpired(this.client);
  }

  async claimIdempotencyRecord(input: {
    sessionId: string;
    keyHash: string;
    fingerprintHash: string;
    checkoutId: string;
  }): Promise<{ claimed: boolean; existing?: CheckoutIdempotencyRecord }> {
    const inserted = await this.client.query<{ id: string }>(
      `INSERT INTO idempotency_records (
         guest_session_id, operation, idempotency_key_hash, fingerprint_hash, checkout_id
       ) VALUES ($1, 'CREATE_CHECKOUT', $2, $3, $4)
       ON CONFLICT (guest_session_id, operation, idempotency_key_hash) DO NOTHING
       RETURNING id`,
      [input.sessionId, input.keyHash, input.fingerprintHash, input.checkoutId],
    );
    if (inserted.rowCount === 1) return { claimed: true };
    const existing = await this.findIdempotencyRecord(input.sessionId, input.keyHash, true);
    return { claimed: false, ...(existing ? { existing } : {}) };
  }

  async reserveProduct(productId: string, quantity: number): Promise<ProductReservationResult> {
    const reserved = await this.client.query<ProductReservationRow>(
      `UPDATE products
       SET reserved_quantity = reserved_quantity + $2, updated_at = now()
       WHERE id = $1 AND active = true AND physical_quantity - reserved_quantity >= $2
       RETURNING id, sku, name, price_minor, currency`,
      [productId, quantity],
    );
    const product = reserved.rows[0];
    if (product) {
      return {
        kind: 'reserved',
        product: { id: product.id, sku: product.sku, name: product.name, priceMinor: product.price_minor, currency: product.currency },
      };
    }
    const existing = await this.client.query<{ active: boolean }>(
      'SELECT active FROM products WHERE id = $1',
      [productId],
    );
    return existing.rows[0]?.active
      ? { kind: 'insufficient-inventory' }
      : { kind: 'not-found' };
  }

  async persistCheckoutSnapshot(input: CreateCheckoutSnapshot): Promise<Date> {
    const customer = await this.client.query<{ id: string }>(
      'INSERT INTO customers (full_name, email) VALUES ($1, $2) RETURNING id',
      [input.customer.fullName, input.customer.email],
    );
    const customerId = customer.rows[0]?.id;
    if (!customerId) throw new Error('Customer snapshot was not created.');
    const delivery = await this.client.query<{ id: string }>(
      'INSERT INTO deliveries (recipient, address) VALUES ($1, $2) RETURNING id',
      [input.delivery.recipient, input.delivery.address],
    );
    const deliveryId = delivery.rows[0]?.id;
    if (!deliveryId) throw new Error('Delivery snapshot was not created.');
    const checkout = await this.client.query<{ reservation_expires_at: Date }>(
      `INSERT INTO checkouts (
         id, guest_session_id, customer_id, delivery_id, state,
         subtotal_minor, base_fee_minor, delivery_fee_minor, total_minor, currency,
         reservation_expires_at
       ) VALUES ($1, $2, $3, $4, 'RESERVED', $5, $6, $7, $8, $9,
         now() + ($10 * interval '1 second'))
       RETURNING reservation_expires_at`,
      [input.checkoutId, input.sessionId, customerId, deliveryId,
       input.subtotalMinor.toString(), input.baseFeeMinor, input.deliveryFeeMinor,
       input.totalMinor.toString(), input.product.currency, input.reservationTtlSeconds],
    );
    const expiresAt = checkout.rows[0]?.reservation_expires_at;
    if (!expiresAt) throw new Error('Checkout reservation was not created.');
    await this.client.query(
      `INSERT INTO checkout_items (
         checkout_id, product_id, sku_snapshot, name_snapshot, quantity,
         unit_price_minor, line_total_minor
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [input.checkoutId, input.product.id, input.product.sku, input.product.name,
       input.quantity, input.unitPriceMinor.toString(), input.subtotalMinor.toString()],
    );
    await this.client.query(
      `INSERT INTO reservations (checkout_id, product_id, quantity, state, expires_at)
       VALUES ($1, $2, $3, 'HELD', $4)`,
      [input.checkoutId, input.product.id, input.quantity, expiresAt],
    );
    return expiresAt;
  }

  async findIdempotencyRecord(
    sessionId: string,
    keyHash: string,
    lock = false,
  ): Promise<CheckoutIdempotencyRecord | null> {
    const result = await this.client.query<IdempotencyRow>(
      `SELECT fingerprint_hash AS "fingerprintHash", checkout_id AS "checkoutId"
       FROM idempotency_records
       WHERE guest_session_id = $1 AND operation = 'CREATE_CHECKOUT'
         AND idempotency_key_hash = $2${lock ? ' FOR UPDATE' : ''}`,
      [sessionId, keyHash],
    );
    return result.rows[0] ?? null;
  }

  async getCheckout(sessionId: string, checkoutId: string): Promise<CheckoutView | null> {
    const result = await this.client.query<CheckoutRow>(
      `SELECT c.id, c.state, c.subtotal_minor, c.base_fee_minor, c.delivery_fee_minor,
              c.total_minor, c.currency, c.reservation_expires_at, c.created_at,
              customer.full_name AS customer_name, customer.email AS customer_email,
              delivery.recipient, delivery.address AS delivery_address,
              reservation.state AS reservation_state, item.product_id,
              item.sku_snapshot AS product_sku, item.name_snapshot AS product_name,
              item.quantity, item.unit_price_minor, item.line_total_minor
       FROM checkouts AS c
       JOIN customers AS customer ON customer.id = c.customer_id
       JOIN deliveries AS delivery ON delivery.id = c.delivery_id
       JOIN reservations AS reservation ON reservation.checkout_id = c.id
       JOIN checkout_items AS item ON item.checkout_id = c.id
       WHERE c.id = $1 AND c.guest_session_id = $2`,
      [checkoutId, sessionId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      checkoutId: row.id,
      state: row.state,
      customer: { fullName: row.customer_name, email: row.customer_email },
      delivery: { recipient: row.recipient, address: row.delivery_address },
      item: {
        productId: row.product_id,
        sku: row.product_sku,
        name: row.product_name,
        quantity: row.quantity,
        unitPriceMinor: this.safeInteger(row.unit_price_minor),
        lineTotalMinor: this.safeInteger(row.line_total_minor),
      },
      subtotalMinor: this.safeInteger(row.subtotal_minor),
      baseFeeMinor: this.safeInteger(row.base_fee_minor),
      deliveryFeeMinor: this.safeInteger(row.delivery_fee_minor),
      totalAmountInMinorUnits: this.safeInteger(row.total_minor),
      currency: row.currency.trim(),
      reservation: { state: row.reservation_state, expiresAt: row.reservation_expires_at },
      createdAt: row.created_at,
    };
  }

  private safeInteger(value: string): number {
    const amount = BigInt(value);
    if (amount < 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Persisted checkout amount exceeds the supported integer range.');
    }
    return Number(amount);
  }
}
