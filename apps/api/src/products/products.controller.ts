import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { ProductView, ProductsService } from './products.service';

class ProductResponse implements ProductView {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  sku!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty({ format: 'uri-reference' })
  imageUrl!: string;

  @ApiProperty({ minimum: 0, example: 29000 })
  unitPriceMinor!: number;

  @ApiProperty({ example: 'COP' })
  currency!: string;

  @ApiProperty({ minimum: 0 })
  physicalQuantity!: number;

  @ApiProperty({ minimum: 0 })
  reservedQuantity!: number;

  @ApiProperty({ minimum: 0 })
  availableQuantity!: number;
}

@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @ApiOperation({ summary: 'List active seeded products and available stock' })
  @ApiOkResponse({ type: ProductResponse, isArray: true })
  list(): Promise<ProductView[]> {
    return this.products.list();
  }

  @Get(':productId')
  @ApiOperation({ summary: 'Read an active product by identifier' })
  @ApiOkResponse({ type: ProductResponse })
  @ApiNotFoundResponse({ description: 'Product does not exist or is inactive.' })
  get(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
  ): Promise<ProductView> {
    return this.products.get(productId);
  }
}
