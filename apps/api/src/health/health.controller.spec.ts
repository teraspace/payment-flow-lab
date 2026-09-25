import { ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('returns liveness without contacting the database', () => {
    const database = { ping: jest.fn() } as unknown as DatabaseService;
    const controller = new HealthController(database);
    expect(controller.live()).toEqual({ status: 'ok' });
    expect(database.ping).not.toHaveBeenCalled();
  });

  it('reports readiness after a successful database ping', async () => {
    const database = { ping: jest.fn().mockResolvedValue(undefined) } as unknown as DatabaseService;
    const controller = new HealthController(database);
    await expect(controller.ready()).resolves.toEqual({
      status: 'ok', checks: { database: 'ok' },
    });
    expect(database.ping).toHaveBeenCalledTimes(1);
  });

  it('marks the service unavailable when its database check fails', async () => {
    const database = { ping: jest.fn().mockRejectedValue(new Error('database down')) } as unknown as DatabaseService;
    const controller = new HealthController(database);
    await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
