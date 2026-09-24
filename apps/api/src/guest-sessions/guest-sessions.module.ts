import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { GuestSessionsController } from './guest-sessions.controller';
import { GuestSessionsService } from './guest-sessions.service';

@Module({
  imports: [DatabaseModule],
  controllers: [GuestSessionsController],
  providers: [GuestSessionsService],
  exports: [GuestSessionsService],
})
export class GuestSessionsModule {}
