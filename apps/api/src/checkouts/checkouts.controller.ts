import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import {
  GUEST_SESSION_COOKIE,
  GuestSessionsService,
} from '../guest-sessions/guest-sessions.service';
import { CheckoutsService, CheckoutView } from './checkouts.service';
import { CreateCheckoutDto } from './dto/create-checkout.dto';

class CheckoutCustomerResponse {
  @ApiProperty({ type: String, nullable: true })
  fullName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  email!: string | null;
}

class CheckoutDeliveryResponse {
  @ApiProperty({ type: String, nullable: true })
  recipient!: string | null;

  @ApiProperty({ type: String, nullable: true })
  address!: string | null;
}

class CheckoutItemResponse {
  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty()
  sku!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ minimum: 1 })
  quantity!: number;

  @ApiProperty({ minimum: 0 })
  unitPriceMinor!: number;

  @ApiProperty({ minimum: 0 })
  lineTotalMinor!: number;
}

class CheckoutReservationResponse {
  @ApiProperty({ enum: ['HELD', 'RELEASED', 'COMMITTED'] })
  state!: 'HELD' | 'RELEASED' | 'COMMITTED';

  @ApiProperty()
  expiresAt!: Date;
}

class CheckoutResponse implements CheckoutView {
  @ApiProperty({ format: 'uuid' })
  checkoutId!: string;

  @ApiProperty({
    enum: [
      'RESERVED',
      'PAYMENT_PENDING',
      'UNKNOWN_OUTCOME',
      'PAYMENT_FAILED',
      'PAID',
      'CANCEL_PENDING',
      'CANCELLED',
      'EXPIRED',
      'FULFILLMENT_EXCEPTION',
    ],
  })
  state!: CheckoutView['state'];

  @ApiProperty({ type: CheckoutCustomerResponse })
  customer!: CheckoutCustomerResponse;

  @ApiProperty({ type: CheckoutDeliveryResponse })
  delivery!: CheckoutDeliveryResponse;

  @ApiProperty({ type: CheckoutItemResponse })
  item!: CheckoutItemResponse;

  @ApiProperty({ minimum: 0 })
  subtotalMinor!: number;

  @ApiProperty({ minimum: 0 })
  baseFeeMinor!: number;

  @ApiProperty({ minimum: 0 })
  deliveryFeeMinor!: number;

  @ApiProperty({ minimum: 0 })
  totalAmountInMinorUnits!: number;

  @ApiProperty({ example: 'COP' })
  currency!: string;

  @ApiProperty({ type: CheckoutReservationResponse })
  reservation!: CheckoutReservationResponse;

  @ApiProperty()
  createdAt!: Date;
}

@ApiTags('checkouts')
@Controller('checkouts')
export class CheckoutsController {
  constructor(
    private readonly checkouts: CheckoutsService,
    private readonly sessions: GuestSessionsService,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Create a checkout and atomically reserve available stock',
  })
  @ApiCookieAuth('guest-session')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', minLength: 16, maxLength: 128 },
  })
  @ApiResponse({
    status: 410,
    description: 'The checkout replay window expired after personal-data redaction.',
  })
  @ApiCreatedResponse({ type: CheckoutResponse })
  @ApiOkResponse({ description: 'Replay of the existing checkout.', type: CheckoutResponse })
  @ApiUnauthorizedResponse({ description: 'Guest session cookie is missing or expired.' })
  async create(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateCheckoutDto,
  ): Promise<CheckoutResponse> {
    const sessionId = await this.sessions.requireSessionId(
      request.cookies?.[GUEST_SESSION_COOKIE],
    );
    const result = await this.checkouts.create(sessionId, idempotencyKey, dto);
    response.status(result.replayed ? 200 : 201);
    return result.checkout;
  }

  @Get(':checkoutId')
  @ApiOperation({ summary: 'Read a checkout owned by the current guest session' })
  @ApiCookieAuth('guest-session')
  @ApiOkResponse({ type: CheckoutResponse })
  @ApiNotFoundResponse({ description: 'Checkout does not exist in this session.' })
  @ApiUnauthorizedResponse({ description: 'Guest session cookie is missing or expired.' })
  async get(
    @Req() request: Request,
    @Param('checkoutId', new ParseUUIDPipe({ version: '4' })) checkoutId: string,
  ): Promise<CheckoutResponse> {
    const sessionId = await this.sessions.requireSessionId(
      request.cookies?.[GUEST_SESSION_COOKIE],
    );
    return this.checkouts.get(sessionId, checkoutId);
  }
}
