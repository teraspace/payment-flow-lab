import { InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ProductCatalogPort } from './product-catalog.port';
import { ProductsService } from './products.service';

const productRow = {
  id: 'product-1',
  sku: 'desk-notebook',
  name: 'Cuaderno',
  description: 'Cuaderno de notas.',
  imageUrl: '/catalog/notebook.svg',
  priceMinor: '29000',
  currency: ' COP ',
  physicalQuantity: 7,
  reservedQuantity: 2,
};

function makeService(records: Array<typeof productRow>) {
  const catalog: jest.Mocked<ProductCatalogPort> = {
    list: jest.fn().mockResolvedValue(records),
    findById: jest.fn().mockImplementation(async (id) => records.find((row) => row.id === id) ?? null),
  };
  return { service: new ProductsService(catalog), catalog };
}

describe('ProductsService', () => {
  it('maps product snapshots to server-calculated available quantities', async () => {
    const { service, catalog } = makeService([productRow]);
    await expect(service.list()).resolves.toEqual([{
      id: 'product-1', sku: 'desk-notebook', name: 'Cuaderno',
      description: 'Cuaderno de notas.', imageUrl: '/catalog/notebook.svg',
      unitPriceMinor: 29000, currency: 'COP', physicalQuantity: 7,
      reservedQuantity: 2, availableQuantity: 5,
    }]);
    expect(catalog.list).toHaveBeenCalledTimes(1);
  });

  it('returns an active product by ID and rejects an absent product', async () => {
    const found = makeService([productRow]);
    await expect(found.service.get('product-1')).resolves.toMatchObject({ id: 'product-1' });
    expect(found.catalog.findById).toHaveBeenCalledWith('product-1');

    const missing = makeService([]);
    await expect(missing.service.get('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a stored price outside JavaScript safe-integer range', async () => {
    const { service } = makeService([{ ...productRow, priceMinor: '9007199254740992' }]);
    await expect(service.list()).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
