import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { resolve } from 'node:path';
import { validateEnvironment } from './config/environment';
import { CheckoutsModule } from './checkouts/checkouts.module';
import { DatabaseModule } from './database/database.module';
import { GuestSessionsModule } from './guest-sessions/guest-sessions.module';
import { HealthModule } from './health/health.module';
import { ProductsModule } from './products/products.module';
import { PaymentsModule } from './payments/payments.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: resolve(process.cwd(), '../../.env'),
      validate: validateEnvironment,
    }),
    DatabaseModule,
    HealthModule,
    GuestSessionsModule,
    ProductsModule,
    CheckoutsModule,
    PaymentsModule,
  ],
})
export class AppModule {}
