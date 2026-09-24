import { z } from 'zod';

const environmentSchema = z.object({
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
