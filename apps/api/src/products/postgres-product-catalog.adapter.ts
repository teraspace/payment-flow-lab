import { Injectable } from '@nestjs/common';
import { QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import { PostgresReservationExpirationAdapter } from '../inventory/postgres-reservation-expiration.adapter';
import { ProductCatalogPort, ProductRecord } from './product-catalog.port';

interface ProductRow extends QueryResultRow {
  id: string; sku: string; name: string; description: string; image_url: string;
  price_minor: string; currency: string; physical_quantity: number; reserved_quantity: number;
}

@Injectable()
export class PostgresProductCatalogAdapter implements ProductCatalogPort {
  constructor(
    private readonly database: DatabaseService,
    private readonly expiration: PostgresReservationExpirationAdapter,
  ) {}

  list(): Promise<ProductRecord[]> {
    return this.database.transaction(async (client) => {
      await this.expiration.releaseExpired(client);
      const result = await client.query<ProductRow>(
        `SELECT id, sku, name, description, image_url, price_minor, currency,
                physical_quantity, reserved_quantity
         FROM products WHERE active = true ORDER BY sku`,
      );
      return result.rows.map((row) => this.toRecord(row));
    });
  }

  findById(id: string): Promise<ProductRecord | null> {
    return this.database.transaction(async (client) => {
      await this.expiration.releaseExpired(client);
      const result = await client.query<ProductRow>(
        `SELECT id, sku, name, description, image_url, price_minor, currency,
                physical_quantity, reserved_quantity
         FROM products WHERE id = $1 AND active = true`,
        [id],
      );
      return result.rows[0] ? this.toRecord(result.rows[0]) : null;
    });
  }

  private toRecord(row: ProductRow): ProductRecord {
    return {
      id: row.id, sku: row.sku, name: row.name, description: row.description,
      imageUrl: row.image_url, priceMinor: row.price_minor, currency: row.currency,
      physicalQuantity: row.physical_quantity, reservedQuantity: row.reserved_quantity,
    };
  }
}
