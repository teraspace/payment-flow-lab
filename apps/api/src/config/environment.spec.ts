import { validateEnvironment } from './environment';

describe('validateEnvironment', () => {
  it('uses the approved demo checkout charges when the environment omits them', () => {
    const environment = validateEnvironment({
      DATABASE_URL: 'postgresql://postgres@127.0.0.1:5432/payment_flow_lab',
    });

    expect(environment).toMatchObject({
      CHECKOUT_BASE_FEE_MINOR: 5_000,
      CHECKOUT_DELIVERY_FEE_MINOR: 8_000,
      GUEST_SESSION_TTL_DAYS: 30,
      PAYMENT_GATEWAY_ENVIRONMENT: 'test',
      PAYMENT_UNRESOLVED_REVIEW_THRESHOLD_SECONDS: 1800,
      PAYMENT_EVENT_RECEIPT_RETENTION_DAYS: 365,
    });
  });

  it('keeps an unconfigured payment gateway optional for local development', () => {
    const environment = validateEnvironment({
      DATABASE_URL: 'postgresql://postgres@127.0.0.1:5432/payment_flow_lab',
      PAYMENT_GATEWAY_BASE_URL: '',
      PAYMENT_GATEWAY_PRIVATE_KEY: '',
      PAYMENT_GATEWAY_INTEGRITY_SECRET: '',
    });

    expect(environment.PAYMENT_GATEWAY_BASE_URL).toBeUndefined();
    expect(environment.PAYMENT_GATEWAY_PRIVATE_KEY).toBeUndefined();
    expect(environment.PAYMENT_GATEWAY_INTEGRITY_SECRET).toBeUndefined();
  });

  it('rejects an invalid payment gateway base URL when configured', () => {
    expect(() =>
      validateEnvironment({
        DATABASE_URL: 'postgresql://postgres@127.0.0.1:5432/payment_flow_lab',
        PAYMENT_GATEWAY_BASE_URL: 'not-a-url',
      }),
    ).toThrow(/PAYMENT_GATEWAY_BASE_URL/);
  });

  it('allows disabling automatic unresolved-payment review escalation with zero', () => {
    const environment = validateEnvironment({
      DATABASE_URL: 'postgresql://postgres@127.0.0.1:5432/payment_flow_lab',
      PAYMENT_UNRESOLVED_REVIEW_THRESHOLD_SECONDS: '0',
    });

    expect(environment.PAYMENT_UNRESOLVED_REVIEW_THRESHOLD_SECONDS).toBe(0);
  });
});
