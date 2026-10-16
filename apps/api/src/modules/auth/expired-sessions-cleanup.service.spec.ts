import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../database/prisma.service';
import { ExpiredSessionsCleanupService } from './expired-sessions-cleanup.service';

describe('ExpiredSessionsCleanupService', () => {
  const session = { findMany: vi.fn(), deleteMany: vi.fn() };
  const service = new ExpiredSessionsCleanupService({ session } as unknown as PrismaService);

  beforeEach(() => vi.resetAllMocks());

  it('deletes expired sessions only and guards deletion by the same cutoff', async () => {
    const stored = [
      { id: 'expired', expiresAt: new Date(Date.now() - 60_000) },
      { id: 'live', expiresAt: new Date(Date.now() + 60_000) },
    ];
    session.findMany.mockImplementation(async ({ where }) =>
      stored.filter(({ expiresAt }) => expiresAt <= where.expiresAt.lte)
        .map(({ id }) => ({ id })),
    );
    session.deleteMany.mockImplementation(async ({ where }) => {
      const ids = new Set(where.id.in);
      const deleted = stored.filter(({ id, expiresAt }) =>
        ids.has(id) && expiresAt <= where.expiresAt.lte,
      );
      for (const item of deleted) stored.splice(stored.indexOf(item), 1);
      return { count: deleted.length };
    });

    await service.cleanupExpiredSessions();

    expect(session.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { expiresAt: { lte: expect.any(Date) } },
      take: 200,
    }));
    expect(session.deleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['expired'] },
        expiresAt: { lte: expect.any(Date) },
      },
    });
    expect(session.findMany.mock.calls[0][0].where.expiresAt.lte)
      .toEqual(session.deleteMany.mock.calls[0][0].where.expiresAt.lte);
    expect(stored.map(({ id }) => id)).toEqual(['live']);
  });

  it('bounds each run to ten batches of 200', async () => {
    session.findMany.mockResolvedValue(Array.from({ length: 200 }, (_, index) => ({ id: `${index}` })));
    session.deleteMany.mockResolvedValue({ count: 200 });

    await service.cleanupExpiredSessions();

    expect(session.findMany).toHaveBeenCalledTimes(10);
    expect(session.deleteMany).toHaveBeenCalledTimes(10);
  });

  it('skips overlap, logs storage errors, and retries on a later run', async () => {
    let release: ((value: { id: string }[]) => void) | undefined;
    session.findMany.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = service.cleanupExpiredSessions();
    await service.cleanupExpiredSessions();
    expect(session.findMany).toHaveBeenCalledOnce();
    release?.([]);
    await first;

    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    session.findMany.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(service.cleanupExpiredSessions()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
    session.findMany.mockResolvedValueOnce([]);
    await expect(service.cleanupExpiredSessions()).resolves.toBeUndefined();
    expect(session.findMany).toHaveBeenCalledTimes(3);
    log.mockRestore();
  });
});
