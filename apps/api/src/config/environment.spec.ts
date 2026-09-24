import { validateEnvironment } from './environment';

describe('validateEnvironment', () => {
  it('uses the approved demo checkout charges when the environment omits them', () => {
    const environment = validateEnvironment({
      DATABASE_URL: 'postgresql://postgres@127.0.0.1:5432/payment_flow_lab',
    });

    expect(environment).toMatchObject({
      CHECKOUT_BASE_FEE_MINOR: 5_000,
      CHECKOUT_DELIVERY_FEE_MINOR: 8_000,
    });
  });
});
