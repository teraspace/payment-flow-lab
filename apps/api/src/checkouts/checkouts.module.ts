import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { GuestSessionsModule } from '../guest-sessions/guest-sessions.module';
import { InventoryModule } from '../inventory/inventory.module';
import { CheckoutsController } from './checkouts.controller';
import { CheckoutsService } from './checkouts.service';

@Module({
  imports: [DatabaseModule, GuestSessionsModule, InventoryModule],
  controllers: [CheckoutsController],
  providers: [CheckoutsService],
})
export class CheckoutsModule {}
