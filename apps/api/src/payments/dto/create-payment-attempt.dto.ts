import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreatePaymentAttemptDto {
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
