import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GuestSessionPersistencePort } from './guest-session-persistence.port';
import { GuestSessionsService } from './guest-sessions.service';

const activeSession = { id: 'guest-1', expiresAt: new Date('2026-10-01T00:00:00Z') };
const validCookieToken = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLM';

function makePersistence() {
  const persistence: jest.Mocked<GuestSessionPersistencePort> = {
    deleteExpiredSessionsWithoutCheckouts: jest.fn().mockResolvedValue(undefined),
    findActiveByTokenHash: jest.fn().mockResolvedValue(activeSession),
    create: jest.fn().mockResolvedValue(activeSession),
  };
  return persistence;
}

describe('GuestSessionsService', () => {
  const config = { getOrThrow: jest.fn().mockReturnValue(30) } as unknown as ConfigService;

  it('creates a hashed 30-day guest session when no cookie exists', async () => {
    const persistence = makePersistence();
    const service = new GuestSessionsService(persistence, config);
    const result = await service.initialize();
    expect(result).toMatchObject({ id: 'guest-1', cookieToken: expect.any(String) });
    expect(result.cookieToken).toHaveLength(43);
    expect(persistence.deleteExpiredSessionsWithoutCheckouts).toHaveBeenCalledTimes(1);
    const createCall = persistence.create.mock.calls[0];
    expect(createCall).toBeDefined();
    const [tokenHash, ttlDays] = createCall!;
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ttlDays).toBe(30);
  });

  it('reuses a valid, unexpired guest cookie without issuing a replacement', async () => {
    const persistence = makePersistence();
    const service = new GuestSessionsService(persistence, config);
    await expect(service.initialize(validCookieToken)).resolves.toEqual({
      id: 'guest-1', expiresAt: activeSession.expiresAt, cookieToken: null,
    });
    expect(persistence.create).not.toHaveBeenCalled();
    expect(persistence.findActiveByTokenHash).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/));
  });

  it('replaces malformed and expired guest cookies with a new session', async () => {
    const persistence = makePersistence();
    persistence.findActiveByTokenHash.mockResolvedValueOnce(null);
    const service = new GuestSessionsService(persistence, config);
    await expect(service.initialize('invalid')).resolves.toMatchObject({ cookieToken: expect.any(String) });
    await expect(service.initialize(validCookieToken)).resolves.toMatchObject({ cookieToken: expect.any(String) });
    expect(persistence.create).toHaveBeenCalledTimes(2);
    expect(persistence.findActiveByTokenHash).toHaveBeenCalledTimes(1);
  });

  it('rejects missing or inactive cookies and accepts an active one', async () => {
    const persistence = makePersistence();
    persistence.findActiveByTokenHash.mockResolvedValueOnce(null);
    const service = new GuestSessionsService(persistence, config);
    await expect(service.requireSessionId()).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.requireSessionId('malformed')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.requireSessionId(validCookieToken)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.requireSessionId(validCookieToken)).resolves.toBe('guest-1');
  });

  it('fails loudly when persistence does not return the inserted session', async () => {
    const persistence = makePersistence();
    persistence.create.mockResolvedValue(null);
    const service = new GuestSessionsService(persistence, config);
    await expect(service.initialize()).rejects.toThrow('Guest session was not created.');
  });
});
