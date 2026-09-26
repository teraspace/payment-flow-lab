export const GUEST_SESSION_PERSISTENCE = Symbol('GUEST_SESSION_PERSISTENCE');

export interface GuestSessionRecord {
  id: string;
  expiresAt: Date;
}

export interface GuestSessionPersistencePort {
  deleteExpiredSessionsWithoutCheckouts(): Promise<void>;
  findActiveByTokenHash(tokenHash: string): Promise<GuestSessionRecord | null>;
  create(tokenHash: string, ttlDays: number): Promise<GuestSessionRecord | null>;
}
