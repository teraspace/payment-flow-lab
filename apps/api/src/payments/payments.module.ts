import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../database/database.module';
import { GuestSessionsModule } from '../guest-sessions/guest-sessions.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import {
  PAYMENT_GATEWAY,
} from './payment-gateway.contract';
import {
  HttpPaymentGateway,
  PAYMENT_GATEWAY_FETCH,
} from './http-payment-gateway';

@Module({
  imports: [ConfigModule, DatabaseModule, GuestSessionsModule, InventoryModule],
  providers: [
    { provide: PAYMENT_GATEWAY_FETCH, useValue: globalThis.fetch },
    HttpPaymentGateway,
    { provide: PAYMENT_GATEWAY, useExisting: HttpPaymentGateway },
    PaymentsService,
  ],
  controllers: [PaymentsController],
  exports: [PAYMENT_GATEWAY],
})
export class PaymentsModule {}
