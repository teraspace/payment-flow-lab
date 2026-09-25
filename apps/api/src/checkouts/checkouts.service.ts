import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  GoneException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PoolClient, QueryResultRow } from 'pg';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import { DatabaseService } from '../database/database.service';
import { ReservationExpirationService } from '../inventory/reservation-expiration.service';
import { andThen, andThenAsync, err, ok, Result } from '../core/result';
import { UseCaseError, useCaseError } from '../core/use-case-error';

const CREATE_CHECKOUT_OPERATION = 'CREATE_CHECKOUT';
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const MAX_SAFE_MINOR_UNITS = BigInt(Number.MAX_SAFE_INTEGER);

interface ProductReservationRow extends QueryResultRow {
  id: string;
  sku: string;
  name: string;
  price_minor: string;
  currency: string;
}

interface ExistingIdempotencyRow extends QueryResultRow {
  fingerprint_hash: string | null;
  checkout_id: string;
}

interface CheckoutRow extends QueryResultRow {
  id: string;
  state:
    | 'RESERVED'
    | 'PAYMENT_PENDING'
    | 'UNKNOWN_OUTCOME'
    | 'PAYMENT_FAILED'
    | 'PAID'
    | 'CANCEL_PENDING'
    | 'CANCELLED'
    | 'EXPIRED'
    | 'FULFILLMENT_EXCEPTION';
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
  reservation_state: 'HELD' | 'RELEASED' | 'COMMITTED';
  product_id: string;
  product_sku: string;
  product_name: string;
  quantity: number;
  unit_price_minor: string;
  line_total_minor: string;
}

export interface CheckoutView {
  checkoutId: string;
  state:
    | 'RESERVED'
    | 'PAYMENT_PENDING'
    | 'UNKNOWN_OUTCOME'
    | 'PAYMENT_FAILED'
    | 'PAID'
    | 'CANCEL_PENDING'
    | 'CANCELLED'
    | 'EXPIRED'
    | 'FULFILLMENT_EXCEPTION';
  customer: { fullName: string | null; email: string | null };
  delivery: { recipient: string | null; address: string | null };
  item: {
    productId: string;
    sku: string;
    name: string;
    quantity: number;
    unitPriceMinor: number;
    lineTotalMinor: number;
  };
  subtotalMinor: number;
  baseFeeMinor: number;
  deliveryFeeMinor: number;
  totalAmountInMinorUnits: number;
  currency: string;
  reservation: { state: 'HELD' | 'RELEASED' | 'COMMITTED'; expiresAt: Date };
  createdAt: Date;
}

export interface CreateCheckoutResult {
  checkout: CheckoutView;
  replayed: boolean;
}

interface CanonicalCheckoutInput {
  productId: string;
  quantity: number;
  customer: { fullName: string; email: string };
  delivery: { recipient: string; address: string };
}

@Injectable()
export class CheckoutsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService,
    private readonly reservationExpiration: ReservationExpirationService,
  ) {}

  async create(
    sessionId: string,
    idempotencyKey: string | undefined,
    dto: CreateCheckoutDto,
  ): Promise<Result<CreateCheckoutResult, UseCaseError>> {
    const validKey = this.validateIdempotencyKey(idempotencyKey);
    const preparedInput = andThen(validKey, (validIdempotencyKey) => {
      const input = this.canonicalize(dto);
      return ok({
        input,
        idempotencyKeyHash: this.hash(validIdempotencyKey),
        fingerprintHash: this.hash(JSON.stringify(input)),
      });
    });

    return andThenAsync(preparedInput, async ({ input, idempotencyKeyHash, fingerprintHash }) => {
      return this.database.transactionResult<CreateCheckoutResult, UseCaseError>(async (client) => {
        await this.reservationExpiration.releaseExpired(client);
        const checkoutId = randomUUID();
        const claimed = await client.query<{ id: string }>(
          `
          INSERT INTO idempotency_records (
            guest_session_id, operation, idempotency_key_hash,
            fingerprint_hash, checkout_id
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (guest_session_id, operation, idempotency_key_hash)
          DO NOTHING
          RETURNING id
        `,
          [sessionId, CREATE_CHECKOUT_OPERATION, idempotencyKeyHash, fingerprintHash, checkoutId],
        );

        if (claimed.rowCount === 0) {
          const existing = await client.query<ExistingIdempotencyRow>(
            `
            SELECT fingerprint_hash, checkout_id
            FROM idempotency_records
            WHERE guest_session_id = $1
              AND operation = $2
              AND idempotency_key_hash = $3
            FOR UPDATE
          `,
            [sessionId, CREATE_CHECKOUT_OPERATION, idempotencyKeyHash],
          );
          const record = existing.rows[0];

          if (!record) {
            throw new InternalServerErrorException(
              'The idempotency record could not be recovered.',
            );
          }
          if (record.fingerprint_hash === null) {
            return err(
              useCaseError(
                'IDEMPOTENCY_REPLAY_EXPIRED',
                'This checkout replay window has expired. Start a new guest session.',
              ),
            );
          }
          if (record.fingerprint_hash.trim() !== fingerprintHash) {
            return err(
              useCaseError(
                'IDEMPOTENCY_PAYLOAD_CONFLICT',
                'Idempotency-Key was already used with a different checkout request.',
              ),
            );
          }

          return ok({
            checkout: await this.loadCheckout(client, sessionId, record.checkout_id),
            replayed: true,
          });
        }

        const baseFeeMinor = this.config.getOrThrow<number>('CHECKOUT_BASE_FEE_MINOR');
        const deliveryFeeMinor = this.config.getOrThrow<number>('CHECKOUT_DELIVERY_FEE_MINOR');
        const reservationTtlSeconds = this.config.getOrThrow<number>(
          'CHECKOUT_RESERVATION_TTL_SECONDS',
        );
        const reservation = await this.reserveProduct(client, input.productId, input.quantity);
        if (!reservation.ok) return reservation;

        const product = reservation.value;
        const unitPriceMinor = BigInt(product.price_minor);
        const subtotalMinor = unitPriceMinor * BigInt(input.quantity);
        const totalMinor = subtotalMinor + BigInt(baseFeeMinor) + BigInt(deliveryFeeMinor);

        if (
          subtotalMinor < 0n ||
          subtotalMinor > MAX_SAFE_MINOR_UNITS ||
          totalMinor < 0n ||
          totalMinor > MAX_SAFE_MINOR_UNITS
        ) {
          return err(
            useCaseError(
              'CHECKOUT_AMOUNT_OUT_OF_RANGE',
              'Checkout total exceeds the supported integer range.',
            ),
          );
        }

        const customer = await client.query<{ id: string }>(
          `
          INSERT INTO customers (full_name, email)
          VALUES ($1, $2)
          RETURNING id
        `,
          [input.customer.fullName, input.customer.email],
        );
        const customerId = customer.rows[0]?.id;
        if (!customerId) {
          throw new InternalServerErrorException('Customer snapshot was not created.');
        }
        const delivery = await client.query<{ id: string }>(
          `
          INSERT INTO deliveries (recipient, address)
          VALUES ($1, $2)
          RETURNING id
        `,
          [input.delivery.recipient, input.delivery.address],
        );
        const deliveryId = delivery.rows[0]?.id;
        if (!deliveryId) {
          throw new InternalServerErrorException('Delivery snapshot was not created.');
        }
        const checkout = await client.query<{
          id: string;
          reservation_expires_at: Date;
        }>(
          `
          INSERT INTO checkouts (
            id, guest_session_id, customer_id, delivery_id, state,
            subtotal_minor, base_fee_minor, delivery_fee_minor, total_minor,
            currency, reservation_expires_at
          )
          VALUES (
            $1, $2, $3, $4, 'RESERVED', $5, $6, $7, $8, $9,
            now() + ($10 * interval '1 second')
          )
          RETURNING id, reservation_expires_at
        `,
          [
            checkoutId,
            sessionId,
            customerId,
            deliveryId,
            subtotalMinor.toString(),
            baseFeeMinor,
            deliveryFeeMinor,
            totalMinor.toString(),
            product.currency,
            reservationTtlSeconds,
          ],
        );
        const reservationExpiresAt = checkout.rows[0]?.reservation_expires_at;
        if (!reservationExpiresAt) {
          throw new InternalServerErrorException('Checkout reservation was not created.');
        }

        await client.query(
          `
          INSERT INTO checkout_items (
            checkout_id, product_id, sku_snapshot, name_snapshot,
            quantity, unit_price_minor, line_total_minor
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
          [
            checkoutId,
            product.id,
            product.sku,
            product.name,
            input.quantity,
            unitPriceMinor.toString(),
            subtotalMinor.toString(),
          ],
        );
        await client.query(
          `
          INSERT INTO reservations (
            checkout_id, product_id, quantity, state, expires_at
          )
          VALUES ($1, $2, $3, 'HELD', $4)
        `,
          [checkoutId, product.id, input.quantity, reservationExpiresAt],
        );

        return ok({
          checkout: await this.loadCheckout(client, sessionId, checkoutId),
          replayed: false,
        });
      });
    });
  }

  async get(sessionId: string, checkoutId: string): Promise<CheckoutView> {
    return this.database.transaction(async (client) => {
      await this.reservationExpiration.releaseExpired(client);
      return this.loadCheckout(client, sessionId, checkoutId);
    });
  }

  async recover(
    sessionId: string,
    idempotencyKey: string | undefined,
  ): Promise<CheckoutView> {
    if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new BadRequestException(
        'Idempotency-Key must contain 16 to 128 permitted characters.',
      );
    }

    return this.database.transaction(async (client) => {
      await this.reservationExpiration.releaseExpired(client);
      const result = await client.query<ExistingIdempotencyRow>(
        `
          SELECT fingerprint_hash, checkout_id
          FROM idempotency_records
          WHERE guest_session_id = $1
            AND operation = $2
            AND idempotency_key_hash = $3
          FOR UPDATE
        `,
        [sessionId, CREATE_CHECKOUT_OPERATION, this.hash(idempotencyKey)],
      );
      const record = result.rows[0];
      if (!record) throw new NotFoundException('Checkout not found for this command.');
      if (record.fingerprint_hash === null) {
        throw new GoneException('This checkout replay window has expired.');
      }

      return this.loadCheckout(client, sessionId, record.checkout_id);
    });
  }

  private async reserveProduct(
    client: PoolClient,
    productId: string,
    quantity: number,
  ): Promise<Result<ProductReservationRow, UseCaseError>> {
    const updated = await client.query<ProductReservationRow>(
      `
        UPDATE products
        SET reserved_quantity = reserved_quantity + $2,
            updated_at = now()
        WHERE id = $1
          AND active = true
          AND physical_quantity - reserved_quantity >= $2
        RETURNING id, sku, name, price_minor, currency
      `,
      [productId, quantity],
    );
    const product = updated.rows[0];
    if (product) return ok(product);

    const exists = await client.query<{ active: boolean }>(
      'SELECT active FROM products WHERE id = $1',
      [productId],
    );
    if (!exists.rows[0]?.active) {
      return err(useCaseError('PRODUCT_NOT_FOUND', 'Product not found.'));
    }
    return err(useCaseError('INSUFFICIENT_INVENTORY', 'Not enough product units are available.'));
  }

  private validateIdempotencyKey(idempotencyKey: string | undefined): Result<string, UseCaseError> {
    if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      return err(
        useCaseError(
          'INVALID_IDEMPOTENCY_KEY',
          'Idempotency-Key must contain 16 to 128 permitted characters.',
        ),
      );
    }
    return ok(idempotencyKey);
  }

  private async loadCheckout(
    client: PoolClient,
    sessionId: string,
    checkoutId: string,
  ): Promise<CheckoutView> {
    const result = await client.query<CheckoutRow>(
      `
        SELECT
          c.id,
          c.state,
          c.subtotal_minor,
          c.base_fee_minor,
          c.delivery_fee_minor,
          c.total_minor,
          c.currency,
          c.reservation_expires_at,
          c.created_at,
          customer.full_name AS customer_name,
          customer.email AS customer_email,
          delivery.recipient,
          delivery.address AS delivery_address,
          reservation.state AS reservation_state,
          item.product_id,
          item.sku_snapshot AS product_sku,
          item.name_snapshot AS product_name,
          item.quantity,
          item.unit_price_minor,
          item.line_total_minor
        FROM checkouts AS c
        JOIN customers AS customer ON customer.id = c.customer_id
        JOIN deliveries AS delivery ON delivery.id = c.delivery_id
        JOIN reservations AS reservation ON reservation.checkout_id = c.id
        JOIN checkout_items AS item ON item.checkout_id = c.id
        WHERE c.id = $1 AND c.guest_session_id = $2
      `,
      [checkoutId, sessionId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Checkout not found.');

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
        unitPriceMinor: this.toSafeInteger(row.unit_price_minor),
        lineTotalMinor: this.toSafeInteger(row.line_total_minor),
      },
      subtotalMinor: this.toSafeInteger(row.subtotal_minor),
      baseFeeMinor: this.toSafeInteger(row.base_fee_minor),
      deliveryFeeMinor: this.toSafeInteger(row.delivery_fee_minor),
      totalAmountInMinorUnits: this.toSafeInteger(row.total_minor),
      currency: row.currency.trim(),
      reservation: {
        state: row.reservation_state,
        expiresAt: row.reservation_expires_at,
      },
      createdAt: row.created_at,
    };
  }

  private canonicalize(dto: CreateCheckoutDto): CanonicalCheckoutInput {
    return {
      productId: dto.productId.toLowerCase(),
      quantity: dto.quantity,
      customer: {
        fullName: dto.customer.fullName.trim(),
        email: dto.customer.email.trim().toLowerCase(),
      },
      delivery: {
        recipient: dto.delivery.recipient.trim(),
        address: dto.delivery.address.trim(),
      },
    };
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private ensureSafeAmount(amount: bigint): void {
    if (amount < 0n || amount > MAX_SAFE_MINOR_UNITS) {
      throw new UnprocessableEntityException(
        'Checkout total exceeds the supported integer range.',
      );
    }
  }

  private toSafeInteger(value: string): number {
    const amount = BigInt(value);
    this.ensureSafeAmount(amount);
    return Number(amount);
  }
}
