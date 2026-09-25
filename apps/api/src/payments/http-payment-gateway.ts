import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreateProviderTransaction,
  PaymentGateway,
  ProviderAcceptanceDocuments,
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

const TEST_INTEGRATION_PROFILE = {
  publicKeyPrefix: 'pub_test_',
  privateKeyPrefix: 'prv_test_',
  integritySecretPrefix: 'test_integrity_',
  eventsSecretPrefix: 'test_events_',
};

const STAGING_TEST_INTEGRATION_PROFILE = {
  publicKeyPrefix: 'pub_stagtest_',
  privateKeyPrefix: 'prv_stagtest_',
  integritySecretPrefix: 'stagtest_integrity_',
  eventsSecretPrefix: 'stagtest_events_',
};

@Injectable()
export class HttpPaymentGateway implements PaymentGateway {
  constructor(
    private readonly config: ConfigService,
    @Inject(PAYMENT_GATEWAY_FETCH) private readonly fetcher: FetchFunction,
  ) {}

  async getAcceptanceDocuments(): Promise<ProviderAcceptanceDocuments> {
    const configuration = this.configuration(false, false);
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint(configuration.baseUrl, 'merchants/info'), {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          accept: 'application/json',
          'x-merchant-public-key': configuration.publicKey,
        },
      });
    } catch {
      throw new PaymentGatewayUnavailableError();
    }

    if (!response.ok) throw new PaymentGatewayUnavailableError();
    try {
      const payload: unknown = await response.json();
      if (!isRecord(payload) || !isRecord(payload.data)) {
        throw new Error('Missing merchant data.');
      }
      const acceptance = payload.data.presigned_acceptance;
      const personalData = payload.data.presigned_personal_data_auth;
      if (!isRecord(acceptance) || !isRecord(personalData)) {
        throw new Error('Missing acceptance documents.');
      }
      const acceptanceToken = readNonEmptyString(acceptance.acceptance_token);
      const acceptanceUrl = readHttpsUrl(acceptance.permalink);
      const personalDataAuthorizationToken = readNonEmptyString(
        personalData.acceptance_token,
      );
      const personalDataAuthorizationUrl = readHttpsUrl(personalData.permalink);
      if (
        !acceptanceToken ||
        !acceptanceUrl ||
        !personalDataAuthorizationToken ||
        !personalDataAuthorizationUrl
      ) {
        throw new Error('Invalid acceptance document fields.');
      }
      return {
        acceptanceToken,
        acceptanceUrl,
        personalDataAuthorizationToken,
        personalDataAuthorizationUrl,
      };
    } catch {
      throw new PaymentGatewayUnavailableError();
    }
  }

  async getTokenizationPublicKey(): Promise<string> {
    const configuration = this.configuration(false, false);
    let response: Response;
    try {
      response = await this.fetcher(
        this.endpoint(configuration.baseUrl, 'tokens/keys/tokenization'),
        {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${configuration.publicKey}`,
          },
        },
      );
    } catch {
      throw new PaymentGatewayUnavailableError();
    }

    if (!response.ok) throw new PaymentGatewayUnavailableError();
    try {
      const payload: unknown = await response.json();
      if (!isRecord(payload) || !isRecord(payload.data)) {
        throw new Error('Missing tokenization key data.');
      }
      const publicKey = readNonEmptyString(payload.data.publicKey);
      if (!publicKey) throw new Error('Missing tokenization public key.');
      return publicKey;
    } catch {
      throw new PaymentGatewayUnavailableError();
    }
  }

  async tokenizeEncryptedCard(payload: string): Promise<string> {
    const configuration = this.configuration(false, false);
    let response: Response;
    try {
      response = await this.fetcher(
        this.endpoint(configuration.baseUrl, 'tokens/cards'),
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(20_000),
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${configuration.publicKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ payload }),
        },
      );
    } catch {
      // Tokenization can leave an unused provider token, but it cannot charge.
      throw new PaymentGatewayUnavailableError();
    }

    if (response.status >= 400 && response.status < 500) {
      throw new PaymentGatewayRejectedError(response.status);
    }
    if (!response.ok) throw new PaymentGatewayUnavailableError();
    try {
      const responseBody: unknown = await response.json();
      if (!isRecord(responseBody) || !isRecord(responseBody.data)) {
        throw new Error('Missing card token data.');
      }
      const paymentToken = readNonEmptyString(responseBody.data.id);
      const expectedPrefix = configuration.publicKey.startsWith('pub_stagtest_')
        ? 'tok_stagtest_'
        : 'tok_test_';
      if (!paymentToken?.startsWith(expectedPrefix)) {
        throw new Error('Provider did not return a sandbox card token.');
      }
      return paymentToken;
    } catch {
      throw new PaymentGatewayUnavailableError();
    }
  }

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

  private configuration(
    requireIntegritySecret: boolean,
    requirePrivateKey = true,
  ): {
    baseUrl: string;
    publicKey: string;
    privateKey: string;
    integritySecret: string;
  } {
    const baseUrl = this.config.get<string>('PAYMENT_GATEWAY_BASE_URL')?.trim();
    const publicKey = this.config.get<string>('PAYMENT_GATEWAY_PUBLIC_KEY')?.trim();
    const privateKey = this.config.get<string>('PAYMENT_GATEWAY_PRIVATE_KEY')?.trim();
    const integritySecret = this.config
      .get<string>('PAYMENT_GATEWAY_INTEGRITY_SECRET')
      ?.trim();
    const eventsSecret = this.config.get<string>('PAYMENT_GATEWAY_EVENTS_SECRET')?.trim();
    if (
      !baseUrl ||
      !publicKey ||
      (requirePrivateKey && !privateKey) ||
      (requireIntegritySecret && !integritySecret)
    ) {
      throw new PaymentGatewayConfigurationError();
    }

    const environment = this.config.get<string>('PAYMENT_GATEWAY_ENVIRONMENT') ?? 'test';
    if (environment !== 'test') {
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
      parsedUrl.hash !== '' ||
      !/(sandbox|test)/i.test(parsedUrl.hostname)
    ) {
      throw new PaymentGatewayConfigurationError();
    }

    const isStagingSandboxHost = isChallengeStagingSandboxHost(parsedUrl.hostname);
    const profile = isStagingSandboxHost
      ? STAGING_TEST_INTEGRATION_PROFILE
      : TEST_INTEGRATION_PROFILE;
    if (
      !publicKey.startsWith(profile.publicKeyPrefix) ||
      (privateKey !== undefined && !privateKey.startsWith(profile.privateKeyPrefix)) ||
      (integritySecret !== undefined &&
        !integritySecret.startsWith(profile.integritySecretPrefix)) ||
      (eventsSecret !== undefined && !eventsSecret.startsWith(profile.eventsSecretPrefix))
    ) {
      throw new PaymentGatewayConfigurationError();
    }

    return {
      baseUrl: parsedUrl.toString().replace(/\/+$/, ''),
      publicKey,
      privateKey: privateKey ?? '',
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

function isChallengeStagingSandboxHost(hostname: string): boolean {
  const labels = hostname.toLowerCase().split('.');
  return (
    labels.length === 5 &&
    labels[0] === 'api-sandbox' &&
    labels[1] === 'co' &&
    labels[2] === 'uat' &&
    labels[4] === 'dev'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readHttpsUrl(value: unknown): string | null {
  const candidate = readNonEmptyString(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
