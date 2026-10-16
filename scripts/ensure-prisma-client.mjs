import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = path.join(rootDir, 'apps', 'api');
const apiRequire = createRequire(path.join(apiDir, 'package.json'));

function resolveApiPrismaCli() {
  try {
    return apiRequire.resolve('prisma/build/index.js');
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND') {
      return null;
    }

    throw error;
  }
}

export function ensurePrismaClient({
  resolvePrismaCli = resolveApiPrismaCli,
  spawn = spawnSync,
  logger = console,
} = {}) {
  const prismaCli = resolvePrismaCli();

  if (prismaCli === null) {
    logger.log(
      'Skipping Prisma Client generation: apps/api Prisma CLI is not installed.',
    );
    return 0;
  }

  const result = spawn(process.execPath, [prismaCli, 'generate'], {
    cwd: apiDir,
    stdio: 'inherit',
  });

  if (result.error) {
    logger.error('Failed to start Prisma Client generation:', result.error);
    return 1;
  }

  if (result.signal) {
    logger.error(`Prisma Client generation stopped by signal ${result.signal}.`);
    return 1;
  }

  return result.status ?? 1;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  process.exitCode = ensurePrismaClient();
}
