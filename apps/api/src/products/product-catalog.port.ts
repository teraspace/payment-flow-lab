export const PRODUCT_CATALOG = Symbol('PRODUCT_CATALOG');

export interface ProductRecord {
  id: string;
  sku: string;
  name: string;
  description: string;
  imageUrl: string;
  priceMinor: string;
  currency: string;
  physicalQuantity: number;
  reservedQuantity: number;
}

export interface ProductCatalogPort {
  list(): Promise<ProductRecord[]>;
  findById(id: string): Promise<ProductRecord | null>;
}
