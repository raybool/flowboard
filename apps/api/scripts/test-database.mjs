import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadDotenv } from 'dotenv';
import pg from 'pg';

const { Client } = pg;
const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DATABASE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*_test$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

loadDotenv({ path: join(API_ROOT, '.env'), quiet: true });
loadDotenv({ path: join(API_ROOT, '.env.test.local'), quiet: true });

function parseDatabaseUrl(raw, label) {
  if (!raw) {
    throw new Error(`${label} is not configured`);
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} is not a valid PostgreSQL URL`);
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`${label} must use the PostgreSQL protocol`);
  }

  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (!databaseName) {
    throw new Error(`${label} must contain a database name`);
  }

  return { parsed, databaseName };
}

function getDevelopmentUrl(env = process.env) {
  const raw = env.DATABASE_URL;
  return raw ? parseDatabaseUrl(raw, 'DATABASE_URL') : null;
}

function getTestUrl(env = process.env) {
  const explicit = env.TEST_DATABASE_URL;
  if (explicit) {
    return parseDatabaseUrl(explicit, 'TEST_DATABASE_URL');
  }

  const development = getDevelopmentUrl(env);
  if (!development) {
    throw new Error(
      'TEST_DATABASE_URL is required when DATABASE_URL is not configured',
    );
  }

  const derived = new URL(development.parsed.href);
  const configuredName = env.TEST_DATABASE_NAME?.trim();
  const databaseName = configuredName || `${development.databaseName}_test`;
  derived.pathname = `/${databaseName}`;
  return { parsed: derived, databaseName };
}

function databaseIdentity(database) {
  const host = database.parsed.hostname.toLowerCase();
  const normalizedHost = LOCAL_HOSTS.has(host) ? '<local>' : host;
  const port = database.parsed.port || '5432';
  return `${normalizedHost}:${port}/${database.databaseName}`;
}

function assertTestDatabase(testDatabase, development = getDevelopmentUrl()) {
  if (!LOCAL_HOSTS.has(testDatabase.parsed.hostname.toLowerCase())) {
    throw new Error(
      'TEST_DATABASE_URL must point to a local PostgreSQL server',
    );
  }

  if (!TEST_DATABASE_NAME_PATTERN.test(testDatabase.databaseName)) {
    throw new Error(
      'TEST_DATABASE_URL must target a dedicated local database ending in _test',
    );
  }

  if (
    development &&
    databaseIdentity(development) === databaseIdentity(testDatabase)
  ) {
    throw new Error(
      'Refusing to use the development database for PostgreSQL tests or migrations',
    );
  }
}

function getValidatedTestDatabase(env = process.env) {
  const testDatabase = getTestUrl(env);
  assertTestDatabase(testDatabase, getDevelopmentUrl(env));
  return testDatabase;
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function getAdminUrl(testDatabase) {
  const admin = new URL(testDatabase.parsed.href);
  admin.pathname = '/postgres';
  admin.search = '';
  return admin.href;
}

async function withClient(connectionString, callback) {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
  });

  try {
    await client.connect();
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? ` (code ${error.code})`
        : '';
    throw new Error(
      `PostgreSQL connection failed${code}. Ensure the local server is running and the local credentials are valid.`,
    );
  }

  try {
    return await callback(client);
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? ` (code ${error.code})`
        : '';
    if (error && typeof error === 'object' && error.code === '42501') {
      throw new Error(
        'PostgreSQL denied database administration. Grant CREATEDB to the local role or ask a PostgreSQL administrator to create the dedicated local test database.',
      );
    }
    throw new Error(`PostgreSQL command failed${code}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function ensureDatabase(testDatabase) {
  const adminUrl = getAdminUrl(testDatabase);
  await withClient(adminUrl, async (client) => {
    const result = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [testDatabase.databaseName],
    );

    if (result.rowCount === 0) {
      await client.query(
        `CREATE DATABASE ${quoteIdentifier(testDatabase.databaseName)}`,
      );
      console.log(
        `Created local PostgreSQL database ${testDatabase.databaseName}`,
      );
    } else {
      console.log(
        `Local PostgreSQL database ${testDatabase.databaseName} already exists`,
      );
    }
  });
}

async function checkDatabase(testDatabase) {
  const result = await withClient(testDatabase.parsed.href, (client) =>
    client.query(
      'SELECT current_database() AS database_name, version() AS server_version',
    ),
  );
  const serverVersion = String(result.rows[0]?.server_version ?? '')
    .split('\n', 1)[0]
    .replace(/^PostgreSQL\s+/i, '');
  console.log(
    `Connected to ${testDatabase.databaseName} (PostgreSQL ${serverVersion})`,
  );
}

function runPrisma(testDatabase, command) {
  const result = spawnSync('pnpm', ['exec', 'prisma', ...command], {
    cwd: API_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: testDatabase.parsed.href,
      TEST_DATABASE_URL: testDatabase.parsed.href,
    },
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return false;
  }
  return true;
}

function runVitest(testDatabase, files = []) {
  const result = spawnSync(
    'pnpm',
    [
      'exec',
      'vitest',
      'run',
      '--config',
      './vitest.config.postgres.ts',
      ...files,
    ],
    {
      cwd: API_ROOT,
      env: {
        ...process.env,
        TEST_DATABASE_URL: testDatabase.parsed.href,
      },
      stdio: 'inherit',
    },
  );

  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
}

function getHttpPostgresFiles() {
  return readdirSync(join(API_ROOT, 'test'))
    .filter((file) => file.endsWith('.http.postgres.spec.ts'))
    .map((file) => `test/${file}`);
}

async function main() {
  const action = process.argv[2] ?? 'help';

  if (action === 'help') {
    console.log(
      'Usage: node scripts/test-database.mjs <check|create|migrate|status|test|test-http>',
    );
    return;
  }

  const testDatabase = getValidatedTestDatabase();

  if (action === 'check') {
    await checkDatabase(testDatabase);
    return;
  }

  if (action === 'create') {
    await ensureDatabase(testDatabase);
    return;
  }

  if (action === 'migrate' || action === 'status') {
    await ensureDatabase(testDatabase);
    runPrisma(testDatabase, [
      'migrate',
      action === 'migrate' ? 'deploy' : 'status',
    ]);
    return;
  }

  if (action === 'test' || action === 'test-http') {
    await ensureDatabase(testDatabase);
    if (!runPrisma(testDatabase, ['migrate', 'deploy'])) return;
    runVitest(
      testDatabase,
      action === 'test-http' ? getHttpPostgresFiles() : [],
    );
    return;
  }

  throw new Error(`Unknown test database action: ${action}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : 'Test database command failed',
    );
    process.exitCode = 1;
  });
}

export {
  assertTestDatabase,
  getTestUrl,
  getValidatedTestDatabase,
  parseDatabaseUrl,
};
