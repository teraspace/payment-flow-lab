import {
  BadRequestException,
  ConflictException,
  GoneException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Result } from '../core/result';
import { UseCaseError, UseCaseErrorCode } from '../core/use-case-error';

const httpExceptionFor: Record<UseCaseErrorCode, (message: string) => Error> = {
  INVALID_IDEMPOTENCY_KEY: (message) => new BadRequestException(message),
  IDEMPOTENCY_REPLAY_EXPIRED: (message) => new GoneException(message),
  IDEMPOTENCY_PAYLOAD_CONFLICT: (message) => new ConflictException(message),
  CHECKOUT_NOT_FOUND: (message) => new NotFoundException(message),
  PRODUCT_NOT_FOUND: (message) => new NotFoundException(message),
  INSUFFICIENT_INVENTORY: (message) => new ConflictException(message),
  CHECKOUT_AMOUNT_OUT_OF_RANGE: (message) => new UnprocessableEntityException(message),
  CHECKOUT_NOT_ELIGIBLE: (message) => new ConflictException(message),
  RESERVATION_EXPIRED: (message) => new ConflictException(message),
  CHECKOUT_DATA_EXPIRED: (message) => new GoneException(message),
  PAYMENT_RECONCILIATION_REQUIRED: (message) => new ConflictException(message),
  PAYMENT_RETRY_LIMIT_REACHED: (message) => new ConflictException(message),
  CHECKOUT_PAYMENT_CLOSED: (message) => new ConflictException(message),
  PAYMENT_ATTEMPT_LIMIT_REACHED: (message) => new ConflictException(message),
};

/** Translate application failures to HTTP only at the Nest adapter boundary. */
export function unwrapUseCaseResult<Value>(result: Result<Value, UseCaseError>): Value {
  if (result.ok) return result.value;
  throw httpExceptionFor[result.error.code](result.error.message);
}
