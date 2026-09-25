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
import { CreatePaymentAttemptDto } from './dto/create-payment-attempt.dto';
import { PaymentAttemptView } from './payment-attempt.view';
import { PaymentsService } from './payments.service';

class PaymentAttemptResponse implements PaymentAttemptView {
  @ApiProperty({ format: 'uuid' })
  attemptId!: string;

  @ApiProperty({ format: 'uuid' })
  checkoutId!: string;

  @ApiProperty({ minimum: 1, maximum: 10 })
  attemptNumber!: number;

  @ApiProperty({
    enum: [
      'CREATED',
      'DISPATCHING',
      'FAILED_LOCAL',
      'PENDING',
      'UNKNOWN_OUTCOME',
      'APPROVED',
      'DECLINED',
      'ERROR',
      'VOIDED',
    ],
  })
  state!: PaymentAttemptView['state'];

  @ApiProperty({ minimum: 0, description: 'Whole Colombian pesos.' })
  amountCop!: number;

  @ApiProperty({ example: 'COP' })
  currency!: string;

  @ApiProperty({
    description:
      'True after an unresolved payment reaches the configured manual-review threshold.',
  })
  manualReviewRequired!: boolean;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

@ApiTags('payments')
@Controller()
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly sessions: GuestSessionsService,
  ) {}

  @Post('checkouts/:checkoutId/payment-attempts')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Create one durable payment attempt for an eligible checkout',
  })
  @ApiCookieAuth('guest-session')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', minLength: 16, maxLength: 128 },
  })
  @ApiCreatedResponse({ type: PaymentAttemptResponse })
  @ApiOkResponse({
    description: 'Replay of the existing attempt. No second provider request is sent.',
    type: PaymentAttemptResponse,
  })
  @ApiUnauthorizedResponse({ description: 'Guest session is missing or expired.' })
  @ApiResponse({
    status: 409,
    description: 'Checkout is ineligible or the idempotency key conflicts.',
  })
  async create(
    @Req() request: Request,
    @Param('checkoutId', new ParseUUIDPipe({ version: '4' })) checkoutId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreatePaymentAttemptDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PaymentAttemptResponse> {
    const sessionId = await this.sessions.requireSessionId(
      request.cookies?.[GUEST_SESSION_COOKIE],
    );
    const result = await this.payments.createAttempt(
      sessionId,
      checkoutId,
      idempotencyKey,
      dto,
    );
    response.status(result.replayed ? 200 : 201);
    return result.attempt;
  }

  @Get('checkouts/:checkoutId/payment-attempts/:attemptId')
  @ApiOperation({ summary: 'Read and, when possible, reconcile payment status' })
  @ApiCookieAuth('guest-session')
  @ApiOkResponse({ type: PaymentAttemptResponse })
  @ApiUnauthorizedResponse({ description: 'Guest session is missing or expired.' })
  async getAttempt(
    @Req() request: Request,
    @Param('checkoutId', new ParseUUIDPipe({ version: '4' })) checkoutId: string,
    @Param('attemptId', new ParseUUIDPipe({ version: '4' })) attemptId: string,
  ): Promise<PaymentAttemptResponse> {
    const sessionId = await this.sessions.requireSessionId(
      request.cookies?.[GUEST_SESSION_COOKIE],
    );
    return this.payments.getAttempt(sessionId, checkoutId, attemptId);
  }

  @Post('webhooks/payment-events')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Verify, deduplicate, and apply a payment-provider event',
  })
  @ApiHeader({
    name: 'X-Event-Checksum',
    required: false,
    schema: { type: 'string' },
  })
  @ApiOkResponse({ description: 'Verified event accepted for processing.' })
  @ApiResponse({ status: 400, description: 'Malformed or invalidly signed event.' })
  async receiveEvent(
    @Body() event: unknown,
    @Headers('x-event-checksum') headerChecksum: string | undefined,
  ): Promise<{ received: true }> {
    await this.payments.receiveEvent(event, headerChecksum);
    return { received: true };
  }
}
