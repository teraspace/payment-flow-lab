import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
if (process.env.NODE_ENV !== 'production') {
  const { default: dotenv } = await import('dotenv');
  dotenv.config({ path: resolve(repositoryRoot, '.env'), quiet: true });
}

function getDatabaseConnection() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const required = [
    'DATABASE_HOST',
    'DATABASE_NAME',
    'DATABASE_USER',
    'DATABASE_PASSWORD',
  ];
  const missing = required.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    throw new Error(
      `Set DATABASE_URL or the connection fields: ${required.join(', ')}.`,
    );
  }

  const connection = {
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT ?? '5432'),
    database: process.env.DATABASE_NAME,
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
  };

  if (process.env.DATABASE_SSL === 'true') {
    connection.ssl = {
      rejectUnauthorized: true,
      ...(process.env.DATABASE_SSL_CA_FILE
        ? { ca: readFileSync(process.env.DATABASE_SSL_CA_FILE, 'utf8') }
        : {}),
    };
  }

  return connection;
}

let databaseConnection;
try {
  databaseConnection = getDatabaseConnection();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const direction = process.argv[2] ?? 'up';
if (!['up', 'down'].includes(direction)) {
  console.error(`Unsupported migration direction: ${direction}`);
  process.exit(1);
}

try {
  await runner({
    databaseUrl: databaseConnection,
    dir: resolve(repositoryRoot, 'apps/api/migrations'),
    direction,
    migrationsTable: 'pgmigrations',
  });
} catch (error) {
  console.error('Database migration failed.', error);
  process.exitCode = 1;
}
