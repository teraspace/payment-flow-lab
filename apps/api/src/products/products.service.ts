import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import { ReservationExpirationService } from '../inventory/reservation-expiration.service';

interface ProductRow extends QueryResultRow {
  id: string;
  sku: string;
  name: string;
  description: string;
  image_url: string;
  price_minor: string;
  currency: string;
  physical_quantity: number;
  reserved_quantity: number;
}

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
  constructor(
    private readonly database: DatabaseService,
    private readonly reservationExpiration: ReservationExpirationService,
  ) {}

  async list(): Promise<ProductView[]> {
    return this.database.transaction(async (client) => {
      await this.reservationExpiration.releaseExpired(client);
      const result = await client.query<ProductRow>(`
        SELECT id, sku, name, description, image_url, price_minor, currency,
               physical_quantity, reserved_quantity
        FROM products
        WHERE active = true
        ORDER BY sku
      `);

      return result.rows.map((row) => this.toView(row));
    });
  }

  async get(id: string): Promise<ProductView> {
    return this.database.transaction(async (client) => {
      await this.reservationExpiration.releaseExpired(client);
      const result = await client.query<ProductRow>(
        `
          SELECT id, sku, name, description, image_url, price_minor, currency,
                 physical_quantity, reserved_quantity
          FROM products
          WHERE id = $1 AND active = true
        `,
        [id],
      );

      const product = result.rows[0];
      if (!product) throw new NotFoundException('Product not found.');
      return this.toView(product);
    });
  }

  private toView(row: ProductRow): ProductView {
    const unitPriceMinor = Number(row.price_minor);
    if (!Number.isSafeInteger(unitPriceMinor)) {
      throw new InternalServerErrorException(
        'Product price exceeds the supported integer range.',
      );
    }

    return {
      id: row.id,
      sku: row.sku,
      name: row.name,
      description: row.description,
      imageUrl: row.image_url,
      unitPriceMinor,
      currency: row.currency.trim(),
      physicalQuantity: row.physical_quantity,
      reservedQuantity: row.reserved_quantity,
      availableQuantity: row.physical_quantity - row.reserved_quantity,
    };
  }
}
