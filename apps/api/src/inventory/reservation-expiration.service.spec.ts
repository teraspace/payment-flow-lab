import { InternalServerErrorException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { ReservationExpirationService } from './reservation-expiration.service';

const candidate = {
  id: 'reservation-1',
  checkout_id: 'checkout-1',
  product_id: 'product-1',
  quantity: 2,
};

function queryResult(rows: unknown[] = [], rowCount = rows.length) {
  return { rows, rowCount };
}

describe('ReservationExpirationService', () => {
  const service = new ReservationExpirationService();

  it('does no work when no held reservation has expired', async () => {
    const client = { query: jest.fn().mockResolvedValue(queryResult()) } as unknown as PoolClient;
    await expect(service.releaseExpired(client)).resolves.toBe(0);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['checkout was already transitioned', queryResult(), queryResult([], 0)],
    ['reservation was already released', queryResult([candidate], 1), queryResult([], 1)],
  ])('skips stale candidates when %s', async (_description, checkoutResult, reservationResult) => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce(queryResult([candidate], 1))
        .mockResolvedValueOnce(checkoutResult)
        .mockResolvedValueOnce(reservationResult),
    } as unknown as PoolClient;
    await expect(service.releaseExpired(client)).resolves.toBe(0);
    expect(client.query).toHaveBeenCalledTimes(checkoutResult.rows.length === 0 ? 2 : 3);
  });

  it('does not decrement stock when the guarded release update no longer matches', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce(queryResult([candidate], 1))
        .mockResolvedValueOnce(queryResult([{ id: 'checkout-1' }], 1))
        .mockResolvedValueOnce(queryResult([candidate], 1))
        .mockResolvedValueOnce(queryResult()),
    } as unknown as PoolClient;
    await expect(service.releaseExpired(client)).resolves.toBe(0);
    expect(client.query).toHaveBeenCalledTimes(4);
  });

  it('rolls back and reports an inconsistent reserved-stock counter', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce(queryResult([candidate], 1))
        .mockResolvedValueOnce(queryResult([{ id: 'checkout-1' }], 1))
        .mockResolvedValueOnce(queryResult([candidate], 1))
        .mockResolvedValueOnce(queryResult([candidate], 1))
        .mockResolvedValueOnce(queryResult([], 0)),
    } as unknown as PoolClient;
    await expect(service.releaseExpired(client)).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(client.query).toHaveBeenCalledTimes(5);
  });

  it('releases inventory and expires the checkout once all guarded writes succeed', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce(queryResult([candidate], 1))
        .mockResolvedValueOnce(queryResult([{ id: 'checkout-1' }], 1))
        .mockResolvedValueOnce(queryResult([candidate], 1))
        .mockResolvedValueOnce(queryResult([candidate], 1))
        .mockResolvedValueOnce(queryResult([{ id: 'product-1' }], 1))
        .mockResolvedValueOnce(queryResult([{ id: 'checkout-1' }], 1)),
    } as unknown as PoolClient;
    await expect(service.releaseExpired(client)).resolves.toBe(1);
    expect(client.query).toHaveBeenCalledTimes(6);
  });
});
