import { InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ReservationExpirationService } from '../inventory/reservation-expiration.service';
import { ProductsService } from './products.service';

const productRow = {
  id: 'product-1',
  sku: 'desk-notebook',
  name: 'Cuaderno',
  description: 'Cuaderno de notas.',
  image_url: '/catalog/notebook.svg',
  price_minor: '29000',
  currency: ' COP ',
  physical_quantity: 7,
  reserved_quantity: 2,
};

function makeService(rows: unknown[]) {
  const client = { query: jest.fn().mockResolvedValue({ rows, rowCount: rows.length }) };
  const database = {
    transaction: jest.fn((work: (client: unknown) => Promise<unknown>) => work(client)),
  } as unknown as DatabaseService;
  const reservationExpiration = { releaseExpired: jest.fn().mockResolvedValue(0) } as unknown as ReservationExpirationService;
  return { service: new ProductsService(database, reservationExpiration), client, database, reservationExpiration };
}

describe('ProductsService', () => {
  it('maps product snapshots to server-calculated available quantities', async () => {
    const { service, client, reservationExpiration } = makeService([productRow]);
    await expect(service.list()).resolves.toEqual([{
      id: 'product-1', sku: 'desk-notebook', name: 'Cuaderno',
      description: 'Cuaderno de notas.', imageUrl: '/catalog/notebook.svg',
      unitPriceMinor: 29000, currency: 'COP', physicalQuantity: 7,
      reservedQuantity: 2, availableQuantity: 5,
    }]);
    expect(reservationExpiration.releaseExpired).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('returns an active product by ID and rejects an absent product', async () => {
    const found = makeService([productRow]);
    await expect(found.service.get('product-1')).resolves.toMatchObject({ id: 'product-1' });
    expect(found.client.query).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1 AND active = true'), ['product-1']);

    const missing = makeService([]);
    await expect(missing.service.get('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a stored price outside JavaScript safe-integer range', async () => {
    const { service } = makeService([{ ...productRow, price_minor: '9007199254740992' }]);
    await expect(service.list()).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
