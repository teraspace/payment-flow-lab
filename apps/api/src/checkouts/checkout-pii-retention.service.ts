import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { PERSONAL_DATA_RETENTION, PersonalDataRetentionPort } from './personal-data-retention.port';

const PII_RETENTION_BATCH_SIZE = 500;
const PII_RETENTION_INTERVAL_MS = 5 * 60 * 1000;

@Injectable()
export class CheckoutPiiRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CheckoutPiiRetentionService.name);
  private timer?: NodeJS.Timeout;
  private activeRun?: Promise<void>;

  constructor(@Inject(PERSONAL_DATA_RETENTION) private readonly retention: PersonalDataRetentionPort) {}

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
      const batchCount = await this.retention.redactExpiredCheckoutBatch(PII_RETENTION_BATCH_SIZE);

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
