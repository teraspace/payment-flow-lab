export type ProviderTransactionStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'DECLINED'
  | 'VOIDED'
  | 'ERROR';

export interface CreateProviderTransaction {
  acceptanceToken: string;
  personalDataAuthorizationToken: string;
  amountCop: number;
  currency: 'COP';
  customerEmail: string;
  installments: number;
  paymentToken: string;
  reference: string;
}

export interface ProviderTransaction {
  id: string;
  reference: string;
  amountInCents: number;
  currency: string;
  status: ProviderTransactionStatus;
}

export interface ProviderAcceptanceDocuments {
  acceptanceToken: string;
  acceptanceUrl: string;
  personalDataAuthorizationToken: string;
  personalDataAuthorizationUrl: string;
}

export interface VerifiedProviderEvent {
  fingerprint: string;
  transactionId: string;
  reference: string;
  amountInCents: number;
  currency: string;
  status: ProviderTransactionStatus;
  occurredAt: Date;
}

export interface PaymentGateway {
  getAcceptanceDocuments(): Promise<ProviderAcceptanceDocuments>;
  getTokenizationPublicKey(): Promise<string>;
  tokenizeEncryptedCard(payload: string): Promise<string>;
  createTransaction(
    input: CreateProviderTransaction,
  ): Promise<ProviderTransaction>;
  getTransaction(transactionId: string): Promise<ProviderTransaction>;
}

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
