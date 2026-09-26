import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { GuestSessionsController } from './guest-sessions.controller';
import { GuestSessionsService } from './guest-sessions.service';
import { GUEST_SESSION_PERSISTENCE } from './guest-session-persistence.port';
import { PostgresGuestSessionAdapter } from './postgres-guest-session.adapter';

@Module({
  imports: [DatabaseModule],
  controllers: [GuestSessionsController],
  providers: [
    GuestSessionsService,
    PostgresGuestSessionAdapter,
    { provide: GUEST_SESSION_PERSISTENCE, useExisting: PostgresGuestSessionAdapter },
  ],
  exports: [GuestSessionsService],
})
export class GuestSessionsModule {}
