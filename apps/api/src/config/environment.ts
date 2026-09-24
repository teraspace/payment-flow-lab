import { z } from 'zod';

const environmentSchema = z.object({
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  WEB_ORIGIN: z.url().default('http://localhost:5173'),
  DATABASE_URL: z.url(),
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
