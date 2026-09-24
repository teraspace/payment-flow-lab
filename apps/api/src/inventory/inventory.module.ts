import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ReservationExpirationService } from './reservation-expiration.service';

@Module({
  imports: [DatabaseModule],
  providers: [ReservationExpirationService],
  exports: [ReservationExpirationService],
})
export class InventoryModule {}
