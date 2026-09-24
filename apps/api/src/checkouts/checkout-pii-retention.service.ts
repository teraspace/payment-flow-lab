import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

const PII_RETENTION_BATCH_SIZE = 500;
const PII_RETENTION_INTERVAL_MS = 5 * 60 * 1000;

interface RedactionBatchRow {
  redacted_count: number;
}

@Injectable()
export class CheckoutPiiRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CheckoutPiiRetentionService.name);
  private timer?: NodeJS.Timeout;
  private activeRun?: Promise<void>;

  constructor(private readonly database: DatabaseService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => this.scheduleRedaction(), PII_RETENTION_INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.activeRun;
  }

  async redactExpiredPersonalData(): Promise<number> {
    let redactedCount = 0;

    while (true) {
      const batchCount = await this.database.transaction(async (client) => {
        const result = await client.query<RedactionBatchRow>(`
          WITH candidates AS MATERIALIZED (
            SELECT checkout.id, checkout.customer_id, checkout.delivery_id
            FROM checkouts AS checkout
            WHERE checkout.created_at <= now() - interval '30 days'
              AND (
                EXISTS (
                  SELECT 1 FROM customers AS customer
                  WHERE customer.id = checkout.customer_id
                    AND (customer.full_name IS NOT NULL OR customer.email IS NOT NULL)
                )
                OR EXISTS (
                  SELECT 1 FROM deliveries AS delivery
                  WHERE delivery.id = checkout.delivery_id
                    AND (delivery.recipient IS NOT NULL OR delivery.address IS NOT NULL)
                )
                OR EXISTS (
                  SELECT 1 FROM idempotency_records AS record
                  WHERE record.checkout_id = checkout.id
                    AND record.fingerprint_hash IS NOT NULL
                )
              )
            ORDER BY checkout.created_at, checkout.id
            LIMIT ${PII_RETENTION_BATCH_SIZE}
            FOR UPDATE OF checkout SKIP LOCKED
          ),
          redacted_customers AS (
            UPDATE customers AS customer
            SET full_name = NULL, email = NULL
            FROM candidates AS candidate
            WHERE customer.id = candidate.customer_id
            RETURNING customer.id
          ),
          redacted_deliveries AS (
            UPDATE deliveries AS delivery
            SET recipient = NULL, address = NULL
            FROM candidates AS candidate
            WHERE delivery.id = candidate.delivery_id
            RETURNING delivery.id
          ),
          redacted_fingerprints AS (
            UPDATE idempotency_records AS record
            SET fingerprint_hash = NULL
            FROM candidates AS candidate
            WHERE record.checkout_id = candidate.id
              AND record.fingerprint_hash IS NOT NULL
            RETURNING record.id
          ),
          updated_checkouts AS (
            UPDATE checkouts AS checkout
            SET updated_at = now()
            FROM candidates AS candidate
            WHERE checkout.id = candidate.id
            RETURNING checkout.id
          )
          SELECT count(*)::int AS redacted_count FROM candidates
        `);

        return result.rows[0]?.redacted_count ?? 0;
      });

      redactedCount += batchCount;
      if (batchCount < PII_RETENTION_BATCH_SIZE) return redactedCount;
    }
  }

  private scheduleRedaction(): void {
    if (this.activeRun) return;

    this.activeRun = this.redactExpiredPersonalData()
      .then((redactedCount) => {
        if (redactedCount > 0) {
          this.logger.log(`Redacted personal data for ${redactedCount} expired checkouts.`);
        }
      })
      .catch((error: unknown) => {
        const errorType = error instanceof Error ? error.name : 'UnknownError';
        this.logger.error(
          `Checkout personal-data redaction failed (${errorType}); it will retry later.`,
        );
      })
      .finally(() => {
        this.activeRun = undefined;
      });
  }
}
