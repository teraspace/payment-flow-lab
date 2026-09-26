import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { GuestSessionsModule } from '../guest-sessions/guest-sessions.module';
import { InventoryModule } from '../inventory/inventory.module';
import { CheckoutsController } from './checkouts.controller';
import { CheckoutsService } from './checkouts.service';
import { CheckoutPiiRetentionService } from './checkout-pii-retention.service';
import { CHECKOUT_PERSISTENCE } from './checkout-persistence.port';
import { PostgresCheckoutPersistenceAdapter } from './postgres-checkout-persistence.adapter';
import { PERSONAL_DATA_RETENTION } from './personal-data-retention.port';
import { PostgresPersonalDataRetentionAdapter } from './postgres-personal-data-retention.adapter';

@Module({
  imports: [DatabaseModule, GuestSessionsModule, InventoryModule],
  controllers: [CheckoutsController],
  providers: [
    CheckoutsService,
    CheckoutPiiRetentionService,
    PostgresCheckoutPersistenceAdapter,
    { provide: CHECKOUT_PERSISTENCE, useExisting: PostgresCheckoutPersistenceAdapter },
    PostgresPersonalDataRetentionAdapter,
    { provide: PERSONAL_DATA_RETENTION, useExisting: PostgresPersonalDataRetentionAdapter },
  ],
})
export class CheckoutsModule {}
