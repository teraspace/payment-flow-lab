import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class TokenizeSandboxCardDto {
  @ApiProperty({
    description: 'Compact JWE encrypted in the browser; plaintext card data is not accepted.',
    maxLength: 8192,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(8192)
  @Matches(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){4}$/)
  payload!: string;
}
