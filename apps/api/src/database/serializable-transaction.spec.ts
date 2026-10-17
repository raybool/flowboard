import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { Prisma } from '../generated/prisma/client';

import {
  isRetryablePrismaTransactionError,
  runSerializableTransaction,
} from './serializable-transaction';

describe('serializable transaction runner', () => {
  const transaction = vi.fn();
  const prisma = { $transaction: transaction };
  const callback = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
  });

  function p2034Error(): Prisma.PrismaClientKnownRequestError {
    return Object.assign(
      Object.create(Prisma.PrismaClientKnownRequestError.prototype),
      { code: 'P2034' },
    ) as Prisma.PrismaClientKnownRequestError;
  }

  it('retries only P2034 and runs the full callback again', async () => {
    transaction
      .mockImplementationOnce(async (run: (tx: unknown) => Promise<string>) => {
        await run({ attempt: 1 });
        throw p2034Error();
      })
      .mockImplementationOnce(async (run: (tx: unknown) => Promise<string>) =>
        run({ attempt: 2 }),
      );
    const roleLookup = vi.fn();
    let callbackAttempt = 0;
    callback.mockImplementation(async () => {
      callbackAttempt += 1;
      await roleLookup();
      return callbackAttempt === 1 ? 'discarded' : 'ok';
    });

    await expect(runSerializableTransaction(prisma, callback, 2)).resolves.toBe(
      'ok',
    );

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenNthCalledWith(1, { attempt: 1 });
    expect(callback).toHaveBeenNthCalledWith(2, { attempt: 2 });
    expect(roleLookup).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenLastCalledWith(
      callback,
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
  });

  it('does not retry domain errors', async () => {
    const error = new ForbiddenException();
    transaction.mockImplementation(
      async (run: (tx: unknown) => Promise<never>) => run({}),
    );
    callback.mockRejectedValue(error);

    await expect(runSerializableTransaction(prisma, callback, 3)).rejects.toBe(
      error,
    );
    expect(transaction).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledOnce();
  });

  it('does not transform unknown infrastructure errors', async () => {
    const error = new Error('unexpected database failure');
    transaction.mockImplementation(
      async (run: (tx: unknown) => Promise<never>) => run({}),
    );
    callback.mockRejectedValue(error);

    await expect(runSerializableTransaction(prisma, callback, 3)).rejects.toBe(
      error,
    );
    expect(transaction).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledOnce();
  });

  it('maps exhausted P2034 retries to a generic 503', async () => {
    transaction.mockImplementation(
      async (run: (tx: unknown) => Promise<string>) => {
        await run({});
        throw p2034Error();
      },
    );
    callback.mockResolvedValue('discarded');

    const error = (await runSerializableTransaction(prisma, callback, 2).catch(
      (reason: unknown) => reason,
    )) as ServiceUnavailableException;

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toBe('Workspace operation temporarily unavailable');
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('recognizes only Prisma P2034 as retryable', () => {
    expect(isRetryablePrismaTransactionError(p2034Error())).toBe(true);
    expect(isRetryablePrismaTransactionError(new Error('P2034'))).toBe(false);
  });
});
