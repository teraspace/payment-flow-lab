import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { PersonalDataRetentionPort } from './personal-data-retention.port';

@Injectable()
export class PostgresPersonalDataRetentionAdapter implements PersonalDataRetentionPort {
  constructor(private readonly database: DatabaseService) {}

  async redactExpiredCheckoutBatch(limit: number): Promise<number> {
    return this.database.transaction(async (client) => {
      const result = await client.query<{ redacted_count: number }>(`
        WITH candidates AS MATERIALIZED (
          SELECT checkout.id, checkout.customer_id, checkout.delivery_id
          FROM checkouts AS checkout
          WHERE checkout.created_at <= now() - interval '30 days'
            AND (
              EXISTS (SELECT 1 FROM customers AS customer WHERE customer.id = checkout.customer_id
                AND (customer.full_name IS NOT NULL OR customer.email IS NOT NULL))
              OR EXISTS (SELECT 1 FROM deliveries AS delivery WHERE delivery.id = checkout.delivery_id
                AND (delivery.recipient IS NOT NULL OR delivery.address IS NOT NULL))
              OR EXISTS (SELECT 1 FROM idempotency_records AS record WHERE record.checkout_id = checkout.id
                AND record.fingerprint_hash IS NOT NULL)
            )
          ORDER BY checkout.created_at, checkout.id
          LIMIT $1
          FOR UPDATE OF checkout SKIP LOCKED
        ),
        redacted_customers AS (
          UPDATE customers AS customer SET full_name = NULL, email = NULL
          FROM candidates AS candidate WHERE customer.id = candidate.customer_id RETURNING customer.id
        ),
        redacted_deliveries AS (
          UPDATE deliveries AS delivery SET recipient = NULL, address = NULL
          FROM candidates AS candidate WHERE delivery.id = candidate.delivery_id RETURNING delivery.id
        ),
        redacted_fingerprints AS (
          UPDATE idempotency_records AS record SET fingerprint_hash = NULL
          FROM candidates AS candidate WHERE record.checkout_id = candidate.id
            AND record.fingerprint_hash IS NOT NULL RETURNING record.id
        ),
        redacted_payment_fingerprints AS (
          UPDATE payment_attempts AS attempt SET request_fingerprint_hash = NULL
          FROM candidates AS candidate WHERE attempt.checkout_id = candidate.id
            AND attempt.request_fingerprint_hash IS NOT NULL RETURNING attempt.id
        ),
        updated_checkouts AS (
          UPDATE checkouts AS checkout SET updated_at = now()
          FROM candidates AS candidate WHERE checkout.id = candidate.id RETURNING checkout.id
        )
        SELECT count(*)::int AS redacted_count FROM candidates
      `, [limit]);
      return result.rows[0]?.redacted_count ?? 0;
    });
  }
}
