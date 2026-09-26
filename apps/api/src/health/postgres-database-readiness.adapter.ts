import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { DatabaseReadinessPort } from './database-readiness.port';

@Injectable()
export class PostgresDatabaseReadinessAdapter implements DatabaseReadinessPort {
  constructor(private readonly database: DatabaseService) {}
  ping(): Promise<void> { return this.database.ping(); }
}
