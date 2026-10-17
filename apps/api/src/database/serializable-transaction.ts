import { Logger, ServiceUnavailableException } from '@nestjs/common';

import { Prisma } from '../generated/prisma/client';
import type { PrismaService } from './prisma.service';

export const DEFAULT_SERIALIZABLE_TRANSACTION_ATTEMPTS = 3;

type TransactionRunner = Pick<PrismaService, '$transaction'>;

export function isRetryablePrismaTransactionError(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2034'
  );
}

export async function runSerializableTransaction<T>(
  prisma: TransactionRunner,
  callback: (transaction: Prisma.TransactionClient) => Promise<T>,
  maxAttempts = DEFAULT_SERIALIZABLE_TRANSACTION_ATTEMPTS,
): Promise<T> {
  const attempts = Math.max(1, Math.trunc(maxAttempts));
  const logger = new Logger('SerializableTransaction');

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await prisma.$transaction(callback, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!isRetryablePrismaTransactionError(error)) {
        throw error;
      }

      if (attempt === attempts) {
        logger.error(
          `Serializable transaction failed after ${attempts} attempt(s)`,
        );
        throw new ServiceUnavailableException(
          'Workspace operation temporarily unavailable',
        );
      }
    }
  }

  throw new ServiceUnavailableException(
    'Workspace operation temporarily unavailable',
  );
}
