export class PaymentGatewayConfigurationError extends Error {
  constructor() {
    super('Payment gateway configuration is incomplete.');
    this.name = 'PaymentGatewayConfigurationError';
  }
}

export class PaymentGatewayRejectedError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly providerCode?: string,
  ) {
    super('The payment gateway rejected the transaction request.');
    this.name = 'PaymentGatewayRejectedError';
  }
}

export class PaymentGatewayOutcomeUnknownError extends Error {
  constructor() {
    super('The payment gateway outcome could not be established.');
    this.name = 'PaymentGatewayOutcomeUnknownError';
  }
}

export class PaymentGatewayUnavailableError extends Error {
  constructor() {
    super('The payment gateway could not be queried.');
    this.name = 'PaymentGatewayUnavailableError';
  }
}
