import { createHash, randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '../src/generated/prisma/client';
import type { PrismaService } from '../src/database/prisma.service';
import type { EnvConfig } from '../src/config/env.schema';
import { AuthService } from '../src/modules/auth/auth.service';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.runIf(Boolean(databaseUrl))('Auth PostgreSQL rollback', () => {
  let prisma: PrismaClient;
  let service: AuthService;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    const parsed = new URL(databaseUrl!);
    const name = decodeURIComponent(parsed.pathname.slice(1));
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) ||
        !name.endsWith('_test')) {
      throw new Error('TEST_DATABASE_URL must point to a local database ending in _test');
    }

    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    await prisma.$connect();
    service = new AuthService(
      prisma as unknown as PrismaService,
      { signAsync: async () => 'signed-access' } as unknown as JwtService,
      {} as ConfigService<EnvConfig, true>,
    );
  });

  afterAll(async () => {
    vi.mocked(randomUUID).mockReset();
    if (prisma) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      await prisma.$disconnect();
    }
  });

  it('rolls back a new user when nested initial session insert fails', async () => {
    const existingUserId = randomUUID();
    const existingSessionId = randomUUID();
    const newUserId = randomUUID();
    const email = `rollback-${newUserId}@example.test`;
    createdUserIds.push(existingUserId, newUserId);
    await prisma.user.create({
      data: {
        id: existingUserId,
        email: `fixture-${existingUserId}@example.test`,
        passwordHash: 'fixture',
        sessions: {
          create: {
            id: existingSessionId,
            refreshTokenHash: `fixture-${existingSessionId}`,
            expiresAt: new Date(Date.now() + 60_000),
          },
        },
      },
    });

    vi.mocked(randomUUID)
      .mockReturnValueOnce(newUserId)
      .mockReturnValueOnce(existingSessionId);
    await expect(service.register({
      email,
      name: 'Rollback',
      password: 'long-password',
    })).rejects.toThrow();

    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    expect(await prisma.session.findUnique({ where: { id: existingSessionId } }))
      .toMatchObject({ userId: existingUserId });
  });

  it('rolls back rotation when history insertion violates a unique constraint', async () => {
    const userId = randomUUID();
    const sessionId = randomUUID();
    const token = `current-${randomUUID()}`;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    createdUserIds.push(userId);
    await prisma.user.create({
      data: {
        id: userId,
        email: `rotation-${userId}@example.test`,
        passwordHash: 'fixture',
        sessions: {
          create: {
            id: sessionId,
            refreshTokenHash: tokenHash,
            expiresAt: new Date(Date.now() + 60_000),
            usedRefreshTokens: { create: { tokenHash } },
          },
        },
      },
    });

    await expect(service.refresh(token)).rejects.toThrow();
    expect(await prisma.session.findUnique({ where: { id: sessionId } }))
      .toMatchObject({ refreshTokenHash: tokenHash, revokedAt: null });
  });
});
