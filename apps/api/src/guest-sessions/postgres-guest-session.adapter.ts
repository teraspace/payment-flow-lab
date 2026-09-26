import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { GuestSessionPersistencePort, GuestSessionRecord } from './guest-session-persistence.port';

@Injectable()
export class PostgresGuestSessionAdapter implements GuestSessionPersistencePort {
  constructor(private readonly database: DatabaseService) {}

  async deleteExpiredSessionsWithoutCheckouts(): Promise<void> {
    await this.database.query(`
      DELETE FROM guest_sessions AS session
      WHERE session.expires_at <= now()
        AND NOT EXISTS (SELECT 1 FROM checkouts WHERE guest_session_id = session.id)
    `);
  }

  async findActiveByTokenHash(tokenHash: string): Promise<GuestSessionRecord | null> {
    const result = await this.database.query<{ id: string; expires_at: Date }>(
      `SELECT id, expires_at FROM guest_sessions WHERE token_hash = $1 AND expires_at > now()`,
      [tokenHash],
    );
    const row = result.rows[0];
    return row ? { id: row.id, expiresAt: row.expires_at } : null;
  }

  async create(tokenHash: string, ttlDays: number): Promise<GuestSessionRecord | null> {
    const result = await this.database.query<{ id: string; expires_at: Date }>(
      `INSERT INTO guest_sessions (token_hash, expires_at)
       VALUES ($1, now() + ($2 * interval '1 day')) RETURNING id, expires_at`,
      [tokenHash, ttlDays],
    );
    const row = result.rows[0];
    return row ? { id: row.id, expiresAt: row.expires_at } : null;
  }
}
