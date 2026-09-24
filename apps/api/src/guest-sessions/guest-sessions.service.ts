import { createHash, randomBytes } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';

export const GUEST_SESSION_COOKIE = 'checkout_session';

interface GuestSessionRow {
  id: string;
  expires_at: Date;
}

export interface GuestSessionInitialization {
  id: string;
  expiresAt: Date;
  cookieToken: string | null;
}

@Injectable()
export class GuestSessionsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService,
  ) {}

  async initialize(cookieToken?: string): Promise<GuestSessionInitialization> {
    await this.database.query(`
      DELETE FROM guest_sessions AS session
      WHERE session.expires_at <= now()
        AND NOT EXISTS (
          SELECT 1
          FROM checkouts AS checkout
          WHERE checkout.guest_session_id = session.id
        )
    `);

    const existing = cookieToken ? await this.findActive(cookieToken) : null;
    if (existing) {
      return {
        id: existing.id,
        expiresAt: existing.expires_at,
        cookieToken: null,
      };
    }

    const token = randomBytes(32).toString('base64url');
    const ttlDays = this.config.getOrThrow<number>('GUEST_SESSION_TTL_DAYS');
    const result = await this.database.query<GuestSessionRow>(
      `
        INSERT INTO guest_sessions (token_hash, expires_at)
        VALUES ($1, now() + ($2 * interval '1 day'))
        RETURNING id, expires_at
      `,
      [this.hash(token), ttlDays],
    );
    const created = result.rows[0];
    if (!created) throw new Error('Guest session was not created.');

    return {
      id: created.id,
      expiresAt: created.expires_at,
      cookieToken: token,
    };
  }

  async requireSessionId(cookieToken?: string): Promise<string> {
    if (!cookieToken) throw new UnauthorizedException('Guest session required.');

    const session = await this.findActive(cookieToken);
    if (!session) throw new UnauthorizedException('Guest session is invalid or expired.');
    return session.id;
  }

  private async findActive(cookieToken: string): Promise<GuestSessionRow | null> {
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(cookieToken)) return null;

    const result = await this.database.query<GuestSessionRow>(
      `
        SELECT id, expires_at
        FROM guest_sessions
        WHERE token_hash = $1 AND expires_at > now()
      `,
      [this.hash(cookieToken)],
    );
    return result.rows[0] ?? null;
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
