import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreatePaymentAttemptDto {
  @ApiProperty({ minimum: 1, maximum: 12, required: false, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  installments?: number;

  @ApiProperty({
    description:
      'One-time token created in the browser. Raw card data must never be sent to this API.',
    maxLength: 1024,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  paymentToken!: string;

  @ApiProperty({
    description: 'Acceptance token for the current user privacy policy.',
    maxLength: 4096,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  acceptanceToken!: string;

  @ApiProperty({
    description: 'Token confirming acceptance of personal-data processing.',
    maxLength: 4096,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  personalDataAuthorizationToken!: string;
}
