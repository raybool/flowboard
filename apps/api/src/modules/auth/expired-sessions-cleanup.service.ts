import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';

const BATCH_SIZE = 200;
const MAX_BATCHES = 10;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

@Injectable()
export class ExpiredSessionsCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExpiredSessionsCleanupService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.cleanupExpiredSessions();
    this.timer = setInterval(() => {
      void this.cleanupExpiredSessions();
    }, CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async cleanupExpiredSessions(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const cutoff = new Date();

    try {
      for (let batch = 0; batch < MAX_BATCHES; batch++) {
        const sessions = await this.prisma.session.findMany({
          where: { expiresAt: { lte: cutoff } },
          select: { id: true },
          orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
          take: BATCH_SIZE,
        });
        if (sessions.length === 0) break;

        await this.prisma.session.deleteMany({
          where: {
            id: { in: sessions.map((session) => session.id) },
            expiresAt: { lte: cutoff },
          },
        });
        if (sessions.length < BATCH_SIZE) break;
      }
    } catch (error) {
      this.logger.error('Expired session cleanup failed; retrying on next interval', error);
    } finally {
      this.running = false;
    }
  }
}
