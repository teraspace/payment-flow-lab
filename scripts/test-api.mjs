import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const apiRoot = resolve(repositoryRoot, 'apps/api');
const requireApi = createRequire(resolve(apiRoot, 'package.json'));
const { Pool } = requireApi('pg');
const { runner } = requireApi('node-pg-migrate');
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:54329/payment_flow_lab_test';
const testUrl = new URL(testDatabaseUrl);
const databaseName = decodeURIComponent(testUrl.pathname.slice(1));

if (!/^[A-Za-z0-9_]+_test$/.test(databaseName)) {
  throw new Error('TEST_DATABASE_URL must target a database ending in _test.');
}
if (!['localhost', '127.0.0.1', '::1', 'postgres'].includes(testUrl.hostname)) {
  throw new Error('API integration tests may only reset a local PostgreSQL database.');
}

const adminUrl = new URL(testUrl);
adminUrl.pathname = '/postgres';
const adminPool = new Pool({ connectionString: adminUrl.toString() });
const quotedDatabaseName = `"${databaseName}"`;

async function resetTestDatabase() {
  await adminPool.query(
    `SELECT pg_terminate_backend(pid)
     FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [databaseName],
  );
  await adminPool.query(`DROP DATABASE IF EXISTS ${quotedDatabaseName}`);
  await adminPool.query(`CREATE DATABASE ${quotedDatabaseName}`);
}

let testExitCode = 1;
try {
  await resetTestDatabase();
  await runner({
    databaseUrl: testDatabaseUrl,
    dir: resolve(apiRoot, 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
  });

  const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(
    npmExecutable,
    [
      'run',
      'test',
      '--workspace',
      '@payment-flow-lab/api',
      '--',
      '--runInBand',
      '--watchman=false',
      ...process.argv.slice(2),
    ],
    {
      cwd: repositoryRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: testDatabaseUrl,
        WEB_ORIGIN: 'http://localhost:5173',
        CHECKOUT_BASE_FEE_MINOR: '5000',
        CHECKOUT_DELIVERY_FEE_MINOR: '8000',
        CHECKOUT_RESERVATION_TTL_SECONDS: '600',
        GUEST_SESSION_TTL_DAYS: '30',
      },
    },
  );
  testExitCode = result.status ?? 1;

  if (testExitCode === 0) {
    const testPool = new Pool({ connectionString: testDatabaseUrl });
    let migrationCount;
    try {
      const applied = await testPool.query('SELECT count(*)::int AS count FROM pgmigrations');
      migrationCount = applied.rows[0].count;
    } finally {
      await testPool.end();
    }

    await runner({
      databaseUrl: testDatabaseUrl,
      dir: resolve(apiRoot, 'migrations'),
      direction: 'down',
      count: migrationCount,
      migrationsTable: 'pgmigrations',
    });
  }
} catch (error) {
  console.error('API integration test setup failed.', error);
} finally {
  try {
    await adminPool.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [databaseName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${quotedDatabaseName}`);
  } finally {
    await adminPool.end();
  }
}

process.exitCode = testExitCode;
