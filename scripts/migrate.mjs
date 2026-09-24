import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
dotenv.config({ path: resolve(repositoryRoot, '.env'), quiet: true });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required; copy .env.example to .env first.');
  process.exit(1);
}

const direction = process.argv[2] ?? 'up';
if (!['up', 'down'].includes(direction)) {
  console.error(`Unsupported migration direction: ${direction}`);
  process.exit(1);
}

const migrationCli = resolve(
  repositoryRoot,
  'node_modules/node-pg-migrate/bin/node-pg-migrate.js',
);
const migrationProcess = spawn(
  process.execPath,
  [
    migrationCli,
    direction,
    '--migrations-dir',
    'apps/api/migrations',
  ],
  { cwd: repositoryRoot, env: process.env, stdio: 'inherit' },
);

migrationProcess.on('error', (error) => {
  console.error('Unable to start the database migration command.', error);
  process.exitCode = 1;
});

migrationProcess.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
