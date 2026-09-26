import { Inject, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { PRODUCT_CATALOG, ProductCatalogPort, ProductRecord } from './product-catalog.port';

export interface ProductView {
  id: string;
  sku: string;
  name: string;
  description: string;
  imageUrl: string;
  unitPriceMinor: number;
  currency: string;
  physicalQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
}

@Injectable()
export class ProductsService {
  constructor(@Inject(PRODUCT_CATALOG) private readonly catalog: ProductCatalogPort) {}

  async list(): Promise<ProductView[]> {
    return (await this.catalog.list()).map((record) => this.toView(record));
  }

  async get(id: string): Promise<ProductView> {
    const record = await this.catalog.findById(id);
    if (!record) throw new NotFoundException('Product not found.');
    return this.toView(record);
  }

  private toView(row: ProductRecord): ProductView {
    const unitPriceMinor = Number(row.priceMinor);
    if (!Number.isSafeInteger(unitPriceMinor)) {
      throw new InternalServerErrorException('Product price exceeds the supported integer range.');
    }
    return {
      id: row.id, sku: row.sku, name: row.name, description: row.description,
      imageUrl: row.imageUrl, unitPriceMinor, currency: row.currency.trim(),
      physicalQuantity: row.physicalQuantity, reservedQuantity: row.reservedQuantity,
      availableQuantity: row.physicalQuantity - row.reservedQuantity,
    };
  }
}
