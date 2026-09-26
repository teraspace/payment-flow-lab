import { ServiceUnavailableException } from '@nestjs/common';
import { DatabaseReadinessPort } from './database-readiness.port';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('returns liveness without contacting the database', () => {
    const readiness = { ping: jest.fn() } as unknown as DatabaseReadinessPort;
    const controller = new HealthController(readiness);
    expect(controller.live()).toEqual({ status: 'ok' });
    expect(readiness.ping).not.toHaveBeenCalled();
  });

  it('reports readiness after a successful database ping', async () => {
    const readiness = { ping: jest.fn().mockResolvedValue(undefined) } as unknown as DatabaseReadinessPort;
    const controller = new HealthController(readiness);
    await expect(controller.ready()).resolves.toEqual({
      status: 'ok', checks: { database: 'ok' },
    });
    expect(readiness.ping).toHaveBeenCalledTimes(1);
  });

  it('marks the service unavailable when its database check fails', async () => {
    const readiness = { ping: jest.fn().mockRejectedValue(new Error('database down')) } as unknown as DatabaseReadinessPort;
    const controller = new HealthController(readiness);
    await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
