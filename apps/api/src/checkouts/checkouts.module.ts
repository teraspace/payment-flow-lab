import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { GuestSessionsModule } from '../guest-sessions/guest-sessions.module';
import { InventoryModule } from '../inventory/inventory.module';
import { CheckoutsController } from './checkouts.controller';
import { CheckoutsService } from './checkouts.service';
import { CheckoutPiiRetentionService } from './checkout-pii-retention.service';

@Module({
  imports: [DatabaseModule, GuestSessionsModule, InventoryModule],
  controllers: [CheckoutsController],
  providers: [CheckoutsService, CheckoutPiiRetentionService],
})
export class CheckoutsModule {}
