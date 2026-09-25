import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';
import { GuestSessionsService } from './guest-sessions.service';

const activeSession = { id: 'guest-1', expires_at: new Date('2026-10-01T00:00:00Z') };
const validCookieToken = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLM';

describe('GuestSessionsService', () => {
  const config = { getOrThrow: jest.fn().mockReturnValue(30) } as unknown as ConfigService;

  it('creates a hashed 30-day guest session when no cookie exists', async () => {
    const database = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [activeSession], rowCount: 1 }),
    } as unknown as DatabaseService;
    const service = new GuestSessionsService(database, config);
    const result = await service.initialize();
    expect(result).toMatchObject({ id: 'guest-1', cookieToken: expect.any(String) });
    expect(result.cookieToken).toHaveLength(43);
    const insert = (database.query as jest.Mock).mock.calls[1];
    expect(insert[1][0]).toMatch(/^[0-9a-f]{64}$/);
    expect(insert[1][1]).toBe(30);
  });

  it('reuses a valid, unexpired guest cookie without issuing a replacement', async () => {
    const database = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [activeSession], rowCount: 1 }),
    } as unknown as DatabaseService;
    const service = new GuestSessionsService(database, config);
    await expect(service.initialize(validCookieToken)).resolves.toEqual({
      id: 'guest-1', expiresAt: activeSession.expires_at, cookieToken: null,
    });
    expect(database.query).toHaveBeenCalledTimes(2);
  });

  it('replaces malformed and expired guest cookies with a new session', async () => {
    const database = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [activeSession], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [activeSession], rowCount: 1 }),
    } as unknown as DatabaseService;
    const service = new GuestSessionsService(database, config);
    await expect(service.initialize('invalid')).resolves.toMatchObject({ cookieToken: expect.any(String) });
    await expect(service.initialize(validCookieToken)).resolves.toMatchObject({ cookieToken: expect.any(String) });
    expect(database.query).toHaveBeenCalledTimes(5);
  });

  it('rejects missing or inactive cookies and accepts an active one', async () => {
    const database = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [activeSession], rowCount: 1 }),
    } as unknown as DatabaseService;
    const service = new GuestSessionsService(database, config);
    await expect(service.requireSessionId()).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.requireSessionId('malformed')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.requireSessionId(validCookieToken)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.requireSessionId(validCookieToken)).resolves.toBe('guest-1');
    expect(database.query).toHaveBeenCalledTimes(2);
  });

  it('fails loudly when the session insert returns no row', async () => {
    const database = {
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    } as unknown as DatabaseService;
    const service = new GuestSessionsService(database, config);
    await expect(service.initialize()).rejects.toThrow('Guest session was not created.');
  });
});
