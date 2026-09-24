import { Transform, Type } from 'class-transformer';
import {
  Allow,
  IsEmail,
  IsInt,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export class CustomerDto {
  @ApiProperty({ minLength: 1, maxLength: 120 })
  @Transform(trimString)
  @IsString()
  @Length(1, 120)
  fullName!: string;

  @ApiProperty({ maxLength: 254, example: 'buyer@example.test' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class DeliveryDto {
  @ApiProperty({ minLength: 1, maxLength: 120 })
  @Transform(trimString)
  @IsString()
  @Length(1, 120)
  recipient!: string;

  @ApiProperty({ minLength: 5, maxLength: 240 })
  @Transform(trimString)
  @IsString()
  @Length(5, 240)
  address!: string;
}

export class CreateCheckoutDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  productId!: string;

  @ApiProperty({ minimum: 1, maximum: 99, example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  quantity!: number;

  @ApiProperty({ type: CustomerDto })
  @ValidateNested()
  @Type(() => CustomerDto)
  customer!: CustomerDto;

  @ApiProperty({ type: DeliveryDto })
  @ValidateNested()
  @Type(() => DeliveryDto)
  delivery!: DeliveryDto;

  @ApiPropertyOptional({
    description: 'Accepted for compatibility and ignored; totals are server-calculated.',
  })
  @Allow()
  totalAmountInMinorUnits?: unknown;
}
