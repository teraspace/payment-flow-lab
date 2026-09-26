import { Logger } from '@nestjs/common';
import { PersonalDataRetentionPort } from './personal-data-retention.port';
import { CheckoutPiiRetentionService } from './checkout-pii-retention.service';

function serviceFor(results: number[]) {
  const retention: jest.Mocked<PersonalDataRetentionPort> = {
    redactExpiredCheckoutBatch: jest.fn().mockImplementation(async () => results.shift() ?? 0),
  };
  return { service: new CheckoutPiiRetentionService(retention), retention };
}

describe('CheckoutPiiRetentionService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns zero when no expired checkout needs redaction', async () => {
    const { service, retention } = serviceFor([0]);
    await expect(service.redactExpiredPersonalData()).resolves.toBe(0);
    expect(retention.redactExpiredCheckoutBatch).toHaveBeenCalledWith(500);
  });

  it('continues in bounded batches until fewer than 500 records are returned', async () => {
    const { service, retention } = serviceFor([500, 3]);
    await expect(service.redactExpiredPersonalData()).resolves.toBe(503);
    expect(retention.redactExpiredCheckoutBatch).toHaveBeenCalledTimes(2);
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
    const retention: jest.Mocked<PersonalDataRetentionPort> = {
      redactExpiredCheckoutBatch: jest.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(0),
    };
    const service = new CheckoutPiiRetentionService(retention);

    service.onModuleInit();
    expect(setInterval).toHaveBeenCalledTimes(1);
    expect(timer.unref).toHaveBeenCalledTimes(1);
    tick?.();
    tick?.();
    expect(retention.redactExpiredCheckoutBatch).toHaveBeenCalledTimes(1);
    finishFirst(500);
    await service.onModuleDestroy();
    expect(retention.redactExpiredCheckoutBatch).toHaveBeenCalledTimes(2);
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
    const retention = {
      redactExpiredCheckoutBatch: jest.fn().mockRejectedValue(error),
    } as unknown as PersonalDataRetentionPort;
    const service = new CheckoutPiiRetentionService(retention);
    service.onModuleInit();
    tick?.();
    await service.onModuleDestroy();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining(`(${errorType})`));
  });
});
