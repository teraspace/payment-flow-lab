import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  GoneException,
  Injectable,
  Inject,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import {
  CHECKOUT_PERSISTENCE,
  CheckoutPersistencePort,
  CheckoutView,
} from './checkout-persistence.port';
import { andThen, andThenAsync, err, ok, Result } from '../core/result';
import { UseCaseError, useCaseError } from '../core/use-case-error';

export { CheckoutView } from './checkout-persistence.port';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const MAX_SAFE_MINOR_UNITS = BigInt(Number.MAX_SAFE_INTEGER);

export interface CreateCheckoutResult {
  checkout: CheckoutView;
  replayed: boolean;
}

interface CanonicalCheckoutInput {
  productId: string;
  quantity: number;
  customer: { fullName: string; email: string };
  delivery: { recipient: string; address: string };
}

@Injectable()
export class CheckoutsService {
  constructor(
    @Inject(CHECKOUT_PERSISTENCE) private readonly persistence: CheckoutPersistencePort,
    private readonly config: ConfigService,
  ) {}

  async create(
    sessionId: string,
    idempotencyKey: string | undefined,
    dto: CreateCheckoutDto,
  ): Promise<Result<CreateCheckoutResult, UseCaseError>> {
    const validKey = this.validateIdempotencyKey(idempotencyKey);
    const preparedInput = andThen(validKey, (validIdempotencyKey) => {
      const input = this.canonicalize(dto);
      return ok({
        input,
        idempotencyKeyHash: this.hash(validIdempotencyKey),
        fingerprintHash: this.hash(JSON.stringify(input)),
      });
    });

    return andThenAsync<
      { input: CanonicalCheckoutInput; idempotencyKeyHash: string; fingerprintHash: string },
      UseCaseError,
      CreateCheckoutResult,
      UseCaseError
    >(preparedInput, async ({ input, idempotencyKeyHash, fingerprintHash }) =>
      this.persistence.transactionResult<CreateCheckoutResult, UseCaseError>(async (unitOfWork) => {
        await unitOfWork.releaseExpiredReservations();
        const checkoutId = randomUUID();
        const claim = await unitOfWork.claimIdempotencyRecord({
          sessionId,
          keyHash: idempotencyKeyHash,
          fingerprintHash,
          checkoutId,
        });

        if (!claim.claimed) {
          const prior = claim.existing;
          if (!prior) throw new InternalServerErrorException('The idempotency record could not be recovered.');
          if (prior.fingerprintHash === null) {
            return err(useCaseError(
              'IDEMPOTENCY_REPLAY_EXPIRED',
              'This checkout replay window has expired. Start a new guest session.',
            ));
          }
          if (prior.fingerprintHash.trim() !== fingerprintHash) {
            return err(useCaseError(
              'IDEMPOTENCY_PAYLOAD_CONFLICT',
              'Idempotency-Key was already used with a different checkout request.',
            ));
          }
          const checkout = await unitOfWork.getCheckout(sessionId, prior.checkoutId);
          if (!checkout) throw new InternalServerErrorException('The idempotent checkout could not be recovered.');
          return ok({ checkout, replayed: true });
        }

        const reservation = await unitOfWork.reserveProduct(input.productId, input.quantity);
        if (reservation.kind === 'not-found') {
          return err(useCaseError('PRODUCT_NOT_FOUND', 'Product not found.'));
        }
        if (reservation.kind === 'insufficient-inventory') {
          return err(useCaseError('INSUFFICIENT_INVENTORY', 'Not enough product units are available.'));
        }

        const baseFeeMinor = this.config.getOrThrow<number>('CHECKOUT_BASE_FEE_MINOR');
        const deliveryFeeMinor = this.config.getOrThrow<number>('CHECKOUT_DELIVERY_FEE_MINOR');
        const reservationTtlSeconds = this.config.getOrThrow<number>('CHECKOUT_RESERVATION_TTL_SECONDS');
        const unitPriceMinor = BigInt(reservation.product.priceMinor);
        const subtotalMinor = unitPriceMinor * BigInt(input.quantity);
        const totalMinor = subtotalMinor + BigInt(baseFeeMinor) + BigInt(deliveryFeeMinor);
        if (!this.isSafeAmount(subtotalMinor) || !this.isSafeAmount(totalMinor)) {
          return err(useCaseError(
            'CHECKOUT_AMOUNT_OUT_OF_RANGE',
            'Checkout total exceeds the supported integer range.',
          ));
        }

        await unitOfWork.persistCheckoutSnapshot({
          checkoutId,
          sessionId,
          product: {
            id: reservation.product.id,
            sku: reservation.product.sku,
            name: reservation.product.name,
            currency: reservation.product.currency,
          },
          quantity: input.quantity,
          unitPriceMinor,
          subtotalMinor,
          baseFeeMinor,
          deliveryFeeMinor,
          totalMinor,
          reservationTtlSeconds,
          customer: input.customer,
          delivery: input.delivery,
        });
        const checkout = await unitOfWork.getCheckout(sessionId, checkoutId);
        if (!checkout) throw new InternalServerErrorException('Checkout snapshot was not created.');
        return ok({ checkout, replayed: false });
      }),
    );
  }

  async get(sessionId: string, checkoutId: string): Promise<CheckoutView> {
    return this.persistence.transaction(async (unitOfWork) => {
      await unitOfWork.releaseExpiredReservations();
      const checkout = await unitOfWork.getCheckout(sessionId, checkoutId);
      if (!checkout) throw new NotFoundException('Checkout not found.');
      return checkout;
    });
  }

  async recover(sessionId: string, idempotencyKey: string | undefined): Promise<CheckoutView> {
    if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new BadRequestException('Idempotency-Key must contain 16 to 128 permitted characters.');
    }

    return this.persistence.transaction(async (unitOfWork) => {
      await unitOfWork.releaseExpiredReservations();
      const record = await unitOfWork.findIdempotencyRecord(sessionId, this.hash(idempotencyKey));
      if (!record) throw new NotFoundException('Checkout not found for this command.');
      if (record.fingerprintHash === null) throw new GoneException('This checkout replay window has expired.');
      const checkout = await unitOfWork.getCheckout(sessionId, record.checkoutId);
      if (!checkout) throw new NotFoundException('Checkout not found for this command.');
      return checkout;
    });
  }

  private validateIdempotencyKey(idempotencyKey: string | undefined): Result<string, UseCaseError> {
    if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      return err(useCaseError('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must contain 16 to 128 permitted characters.'));
    }
    return ok(idempotencyKey);
  }

  private canonicalize(dto: CreateCheckoutDto): CanonicalCheckoutInput {
    return {
      productId: dto.productId.toLowerCase(),
      quantity: dto.quantity,
      customer: { fullName: dto.customer.fullName.trim(), email: dto.customer.email.trim().toLowerCase() },
      delivery: { recipient: dto.delivery.recipient.trim(), address: dto.delivery.address.trim() },
    };
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private isSafeAmount(amount: bigint): boolean {
    return amount >= 0n && amount <= MAX_SAFE_MINOR_UNITS;
  }
}
