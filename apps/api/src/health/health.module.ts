import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { HealthController } from './health.controller';
import { DATABASE_READINESS } from './database-readiness.port';
import { PostgresDatabaseReadinessAdapter } from './postgres-database-readiness.adapter';

@Module({
  imports: [DatabaseModule],
  controllers: [HealthController],
  providers: [
    PostgresDatabaseReadinessAdapter,
    { provide: DATABASE_READINESS, useExisting: PostgresDatabaseReadinessAdapter },
  ],
})
export class HealthModule {}
