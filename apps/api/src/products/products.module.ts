import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { PRODUCT_CATALOG } from './product-catalog.port';
import { PostgresProductCatalogAdapter } from './postgres-product-catalog.adapter';

@Module({
  imports: [DatabaseModule, InventoryModule],
  controllers: [ProductsController],
  providers: [
    ProductsService,
    PostgresProductCatalogAdapter,
    { provide: PRODUCT_CATALOG, useExisting: PostgresProductCatalogAdapter },
  ],
})
export class ProductsModule {}
