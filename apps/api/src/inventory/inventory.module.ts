import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { PostgresReservationExpirationAdapter } from './postgres-reservation-expiration.adapter';

@Module({
  imports: [DatabaseModule],
  providers: [PostgresReservationExpirationAdapter],
  exports: [PostgresReservationExpirationAdapter],
})
export class InventoryModule {}
