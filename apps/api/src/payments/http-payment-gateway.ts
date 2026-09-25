import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreateProviderTransaction,
  PaymentGateway,
  ProviderTransaction,
  ProviderTransactionStatus,
} from './payment-gateway.contract';
import {
  PaymentGatewayConfigurationError,
  PaymentGatewayOutcomeUnknownError,
  PaymentGatewayRejectedError,
  PaymentGatewayUnavailableError,
} from './payment-gateway.errors';
import { createIntegritySignature } from './payment-signatures';

export const PAYMENT_GATEWAY_FETCH = Symbol('PAYMENT_GATEWAY_FETCH');

type FetchFunction = typeof fetch;

const TRANSACTION_STATUSES = new Set<ProviderTransactionStatus>([
  'PENDING',
  'APPROVED',
  'DECLINED',
  'VOIDED',
  'ERROR',
]);

@Injectable()
export class HttpPaymentGateway implements PaymentGateway {
  constructor(
    private readonly config: ConfigService,
    @Inject(PAYMENT_GATEWAY_FETCH) private readonly fetcher: FetchFunction,
  ) {}

  async createTransaction(
    input: CreateProviderTransaction,
  ): Promise<ProviderTransaction> {
    const configuration = this.configuration(true);
    if (!Number.isSafeInteger(input.amountCop) || input.amountCop < 0) {
      throw new PaymentGatewayConfigurationError();
    }
    const amountInCents = input.amountCop * 100;
    if (!Number.isSafeInteger(amountInCents) || amountInCents < 0) {
      throw new PaymentGatewayConfigurationError();
    }
    const body = {
      acceptance_token: input.acceptanceToken,
      accept_personal_auth: input.personalDataAuthorizationToken,
      amount_in_cents: amountInCents,
      currency: input.currency,
      customer_email: input.customerEmail,
      payment_method: {
        type: 'CARD',
        token: input.paymentToken,
        installments: input.installments,
      },
      payment_method_type: 'CARD',
      reference: input.reference,
      signature: createIntegritySignature(
        input.reference,
        amountInCents,
        input.currency,
        configuration.integritySecret,
      ),
    };

    let response: Response;
    try {
      response = await this.fetcher(this.endpoint(configuration.baseUrl, 'transactions'), {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${configuration.privateKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch {
      // Once fetch is entered, transport failure cannot prove the request was
      // not delivered. The application must reconcile instead of retrying it.
      throw new PaymentGatewayOutcomeUnknownError();
    }

    if (response.status < 200 || response.status >= 300) {
      // Only explicit authentication/payload validation responses prove that
      // this request was rejected before a transaction was created. Other
      // errors can include a duplicate-reference response after an earlier
      // accepted request, so they remain unknown and require reconciliation.
      if (response.status === 400 || response.status === 401) {
        throw new PaymentGatewayRejectedError(response.status);
      }
      throw new PaymentGatewayOutcomeUnknownError();
    }

    try {
      const payload: unknown = await response.json();
      return this.parseTransaction(payload);
    } catch {
      // A malformed or unreadable POST response may follow a successful charge.
      throw new PaymentGatewayOutcomeUnknownError();
    }
  }

  async getTransaction(transactionId: string): Promise<ProviderTransaction> {
    const configuration = this.configuration(false);
    let response: Response;
    try {
      response = await this.fetcher(
        this.endpoint(configuration.baseUrl, `transactions/${encodeURIComponent(transactionId)}`),
        {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${configuration.privateKey}`,
          },
        },
      );
    } catch {
      throw new PaymentGatewayUnavailableError();
    }

    if (!response.ok) throw new PaymentGatewayUnavailableError();
    try {
      return this.parseTransaction(await response.json());
    } catch {
      throw new PaymentGatewayUnavailableError();
    }
  }

  private configuration(requireIntegritySecret: boolean): {
    baseUrl: string;
    privateKey: string;
    integritySecret: string;
  } {
    const baseUrl = this.config.get<string>('PAYMENT_GATEWAY_BASE_URL')?.trim();
    const privateKey = this.config.get<string>('PAYMENT_GATEWAY_PRIVATE_KEY')?.trim();
    const integritySecret = this.config
      .get<string>('PAYMENT_GATEWAY_INTEGRITY_SECRET')
      ?.trim();
    if (!baseUrl || !privateKey || (requireIntegritySecret && !integritySecret)) {
      throw new PaymentGatewayConfigurationError();
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(baseUrl);
    } catch {
      throw new PaymentGatewayConfigurationError();
    }
    if (
      parsedUrl.protocol !== 'https:' ||
      parsedUrl.username !== '' ||
      parsedUrl.password !== '' ||
      parsedUrl.search !== '' ||
      parsedUrl.hash !== ''
    ) {
      throw new PaymentGatewayConfigurationError();
    }

    return {
      baseUrl: parsedUrl.toString().replace(/\/+$/, ''),
      privateKey,
      integritySecret: integritySecret ?? '',
    };
  }

  private endpoint(baseUrl: string, path: string): string {
    return `${baseUrl}/${path}`;
  }

  private parseTransaction(payload: unknown): ProviderTransaction {
    if (!isRecord(payload) || !isRecord(payload.data)) {
      throw new Error('Missing transaction response data.');
    }
    const transaction = payload.data;
    if (
      typeof transaction.id !== 'string' ||
      transaction.id.length < 1 ||
      transaction.id.length > 255 ||
      typeof transaction.reference !== 'string' ||
      transaction.reference.length < 1 ||
      transaction.reference.length > 255 ||
      typeof transaction.amount_in_cents !== 'number' ||
      !Number.isSafeInteger(transaction.amount_in_cents) ||
      transaction.amount_in_cents < 0 ||
      typeof transaction.currency !== 'string' ||
      transaction.currency.length !== 3 ||
      typeof transaction.status !== 'string' ||
      !TRANSACTION_STATUSES.has(transaction.status as ProviderTransactionStatus)
    ) {
      throw new Error('Invalid transaction response fields.');
    }
    return {
      id: transaction.id,
      reference: transaction.reference,
      amountInCents: transaction.amount_in_cents,
      currency: transaction.currency,
      status: transaction.status as ProviderTransactionStatus,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
