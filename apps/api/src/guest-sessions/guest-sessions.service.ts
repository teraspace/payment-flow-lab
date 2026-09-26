import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GUEST_SESSION_PERSISTENCE, GuestSessionPersistencePort } from './guest-session-persistence.port';

export const GUEST_SESSION_COOKIE = 'checkout_session';

export interface GuestSessionInitialization {
  id: string;
  expiresAt: Date;
  cookieToken: string | null;
}

@Injectable()
export class GuestSessionsService {
  constructor(
    @Inject(GUEST_SESSION_PERSISTENCE) private readonly persistence: GuestSessionPersistencePort,
    private readonly config: ConfigService,
  ) {}

  async initialize(cookieToken?: string): Promise<GuestSessionInitialization> {
    await this.persistence.deleteExpiredSessionsWithoutCheckouts();

    const existing = cookieToken ? await this.findActive(cookieToken) : null;
    if (existing) {
      return {
        id: existing.id,
        expiresAt: existing.expiresAt,
        cookieToken: null,
      };
    }

    const token = randomBytes(32).toString('base64url');
    const ttlDays = this.config.getOrThrow<number>('GUEST_SESSION_TTL_DAYS');
    const created = await this.persistence.create(this.hash(token), ttlDays);
    if (!created) throw new Error('Guest session was not created.');

    return {
      id: created.id,
      expiresAt: created.expiresAt,
      cookieToken: token,
    };
  }

  async requireSessionId(cookieToken?: string): Promise<string> {
    if (!cookieToken) throw new UnauthorizedException('Guest session required.');

    const session = await this.findActive(cookieToken);
    if (!session) throw new UnauthorizedException('Guest session is invalid or expired.');
    return session.id;
  }

  private async findActive(cookieToken: string): Promise<{ id: string; expiresAt: Date } | null> {
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(cookieToken)) return null;

    return this.persistence.findActiveByTokenHash(this.hash(cookieToken));
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
