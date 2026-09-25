import { Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { CheckoutPiiRetentionService } from './checkout-pii-retention.service';

function serviceFor(results: unknown[]) {
  const client = { query: jest.fn().mockImplementation(() => Promise.resolve(results.shift())) };
  const database = {
    transaction: jest.fn((work: (client: unknown) => Promise<unknown>) => work(client)),
  } as unknown as DatabaseService;
  return { service: new CheckoutPiiRetentionService(database), client, database };
}

describe('CheckoutPiiRetentionService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns zero when no expired checkout needs redaction', async () => {
    const { service, client } = serviceFor([{ rows: [], rowCount: 0 }]);
    await expect(service.redactExpiredPersonalData()).resolves.toBe(0);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('continues in bounded batches until fewer than 500 records are returned', async () => {
    const { service, client } = serviceFor([
      { rows: [{ redacted_count: 500 }], rowCount: 1 },
      { rows: [{ redacted_count: 3 }], rowCount: 1 },
    ]);
    await expect(service.redactExpiredPersonalData()).resolves.toBe(503);
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it('runs one redaction at a time, logs completed work, and clears its interval', async () => {
    let tick: (() => void) | undefined;
    let finishFirst!: (count: number) => void;
    const pending = new Promise<number>((resolve) => { finishFirst = resolve; });
    const timer = { unref: jest.fn() } as unknown as NodeJS.Timeout;
    const setInterval = jest.spyOn(global, 'setInterval').mockImplementation(((callback: () => void) => {
      tick = callback;
      return timer;
    }) as unknown as typeof global.setInterval);
    const clearInterval = jest.spyOn(global, 'clearInterval').mockImplementation(() => undefined);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const database = {
      transaction: jest.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(0),
    } as unknown as DatabaseService;
    const service = new CheckoutPiiRetentionService(database);

    service.onModuleInit();
    expect(setInterval).toHaveBeenCalledTimes(1);
    expect(timer.unref).toHaveBeenCalledTimes(1);
    tick?.();
    tick?.();
    expect(database.transaction).toHaveBeenCalledTimes(1);
    finishFirst(500);
    await service.onModuleDestroy();
    expect(database.transaction).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('500 expired checkouts'));
    expect(clearInterval).toHaveBeenCalledWith(timer);
  });

  it.each([
    [new Error('database unavailable'), 'Error'],
    ['unexpected rejection', 'UnknownError'],
  ])('logs a failed retention pass as %s', async (error, errorType) => {
    let tick: (() => void) | undefined;
    const timer = { unref: jest.fn() } as unknown as NodeJS.Timeout;
    jest.spyOn(global, 'setInterval').mockImplementation(((callback: () => void) => {
      tick = callback;
      return timer;
    }) as unknown as typeof global.setInterval);
    jest.spyOn(global, 'clearInterval').mockImplementation(() => undefined);
    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const database = { transaction: jest.fn().mockRejectedValue(error) } as unknown as DatabaseService;
    const service = new CheckoutPiiRetentionService(database);
    service.onModuleInit();
    tick?.();
    await service.onModuleDestroy();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining(`(${errorType})`));
  });
});
