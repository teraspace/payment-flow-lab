import { z } from 'zod';

const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional(),
);

const optionalUrl = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.url().optional(),
);

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  WEB_ORIGIN: z.url().default('http://localhost:5173'),
  DATABASE_URL: z.url().optional(),
  DATABASE_HOST: z.string().optional(),
  DATABASE_PORT: z.coerce.number().int().min(1).max(65_535).default(5432),
  DATABASE_NAME: z.string().optional(),
  DATABASE_USER: z.string().optional(),
  DATABASE_PASSWORD: z.string().optional(),
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  DATABASE_SSL_CA_FILE: z.string().optional(),
  CHECKOUT_BASE_FEE_MINOR: z.coerce
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(5_000),
  CHECKOUT_DELIVERY_FEE_MINOR: z.coerce
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(8_000),
  CHECKOUT_RESERVATION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(86_400)
    .default(600),
  GUEST_SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  PAYMENT_GATEWAY_ENVIRONMENT: z.enum(['test', 'prod']).default('test'),
  PAYMENT_GATEWAY_BASE_URL: optionalUrl,
  PAYMENT_GATEWAY_PUBLIC_KEY: optionalNonEmptyString,
  PAYMENT_GATEWAY_PRIVATE_KEY: optionalNonEmptyString,
  PAYMENT_GATEWAY_INTEGRITY_SECRET: optionalNonEmptyString,
  PAYMENT_GATEWAY_EVENTS_SECRET: optionalNonEmptyString,
  PAYMENT_UNRESOLVED_REVIEW_THRESHOLD_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(604_800)
    .default(1_800),
  PAYMENT_EVENT_RECEIPT_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3_650)
    .default(365),
}).superRefine((environment, context) => {
  if (environment.DATABASE_URL) return;

  const hasConnectionFields = [
    environment.DATABASE_HOST,
    environment.DATABASE_NAME,
    environment.DATABASE_USER,
    environment.DATABASE_PASSWORD,
  ].every(Boolean);

  if (!hasConnectionFields) {
    context.addIssue({
      code: 'custom',
      path: ['DATABASE_URL'],
      message:
        'Set DATABASE_URL or provide DATABASE_HOST, DATABASE_NAME, DATABASE_USER, and DATABASE_PASSWORD.',
    });
  }
});

export type AppEnvironment = z.infer<typeof environmentSchema>;

export function validateEnvironment(
  environment: Record<string, unknown>,
): AppEnvironment {
  const result = environmentSchema.safeParse(environment);

  if (!result.success) {
    throw new Error(`Invalid application environment: ${z.prettifyError(result.error)}`);
  }

  return result.data;
}
