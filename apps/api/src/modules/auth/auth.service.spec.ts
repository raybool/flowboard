import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../../database/prisma.service';
import type { EnvConfig } from '../../config/env.schema';
import { AuthService } from './auth.service';

describe('AuthService session writes', () => {
  const prisma = {
    user: { create: vi.fn(), findUnique: vi.fn() },
    session: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    usedRefreshToken: { findUnique: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  };
  const tx = {
    session: { updateMany: vi.fn() },
    usedRefreshToken: { create: vi.fn() },
  };
  const jwt = { signAsync: vi.fn() };
  const service = new AuthService(
    prisma as unknown as PrismaService,
    jwt as unknown as JwtService,
    {} as ConfigService<EnvConfig, true>,
  );

  beforeEach(() => {
    vi.resetAllMocks();
    jwt.signAsync.mockResolvedValue('signed-access');
    prisma.$transaction.mockImplementation(
      async (operation: (client: typeof tx) => Promise<boolean>) => operation(tx),
    );
    prisma.usedRefreshToken.findUnique.mockResolvedValue(null);
    tx.session.updateMany.mockResolvedValue({ count: 1 });
    tx.usedRefreshToken.create.mockResolvedValue({});
  });

  it('registers the user and initial session in one nested write', async () => {
    prisma.user.create.mockImplementation(async ({ data }) => ({
      id: data.id,
      email: data.email,
      name: data.name,
    }));

    const result = await service.register({
      email: ' USER@example.com ',
      name: ' User ',
      password: 'long-password',
    });

    expect(prisma.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: 'user@example.com',
        name: 'User',
        sessions: {
          create: expect.objectContaining({
            id: expect.any(String),
            refreshTokenHash: expect.any(String),
            expiresAt: expect.any(Date),
          }),
        },
      }),
    });
    expect(prisma.session.create).not.toHaveBeenCalled();
    expect(result.accessToken).toBe('signed-access');
  });

  it('does not write a user if signing fails', async () => {
    jwt.signAsync.mockRejectedValue(new Error('signing unavailable'));

    await expect(service.register({
      email: 'user@example.com',
      name: 'User',
      password: 'long-password',
    })).rejects.toThrow('signing unavailable');
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('does not create a standalone session after a failed nested write', async () => {
    prisma.user.create.mockRejectedValue(new Error('session insert failed'));

    await expect(service.register({
      email: 'user@example.com',
      name: 'User',
      password: 'long-password',
    })).rejects.toThrow('session insert failed');
    expect(prisma.session.create).not.toHaveBeenCalled();
  });

  it('signs before changing the refresh hash', async () => {
    prisma.session.findUnique.mockResolvedValue({
      id: 'session-id',
      userId: 'user-id',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    jwt.signAsync.mockRejectedValue(new Error('signing unavailable'));

    await expect(service.refresh('valid-token')).rejects.toThrow('signing unavailable');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rotates the token and records its old hash in one transaction', async () => {
    prisma.session.findUnique.mockResolvedValue({
      id: 'session-id',
      userId: 'user-id',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const tokens = await service.refresh('current-token');

    expect(tokens.accessToken).toBe('signed-access');
    expect(tokens.refreshToken).not.toBe('current-token');
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(tx.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'session-id',
          revokedAt: null,
          expiresAt: { gt: expect.any(Date) },
        }),
      }),
    );
    expect(tx.usedRefreshToken.create).toHaveBeenCalledWith({
      data: {
        tokenHash: expect.any(String),
        sessionId: 'session-id',
      },
    });
  });

  it('revokes the linked session when a rotated token is replayed', async () => {
    prisma.session.findUnique.mockResolvedValue(null);
    prisma.usedRefreshToken.findUnique.mockResolvedValue({ sessionId: 'session-id' });

    await expect(service.refresh('used-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { id: 'session-id', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('revokes the winning session when a concurrent refresh loses CAS', async () => {
    prisma.session.findUnique.mockResolvedValue({
      id: 'session-id',
      userId: 'user-id',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    tx.session.updateMany.mockResolvedValue({ count: 0 });
    prisma.usedRefreshToken.findUnique.mockResolvedValue({ sessionId: 'session-id' });

    await expect(service.refresh('used-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(tx.usedRefreshToken.create).not.toHaveBeenCalled();
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { id: 'session-id', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('does not return tokens if the history write fails', async () => {
    prisma.session.findUnique.mockResolvedValue({
      id: 'session-id',
      userId: 'user-id',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const storageError = new Error('history storage unavailable');
    tx.usedRefreshToken.create.mockRejectedValue(storageError);

    await expect(service.refresh('current-token')).rejects.toBe(storageError);
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(tx.session.updateMany).toHaveBeenCalledOnce();
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    { revokedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) },
    { revokedAt: null, expiresAt: new Date(Date.now() - 60_000) },
  ])('rejects revoked or expired refresh sessions', async (state) => {
    prisma.session.findUnique.mockResolvedValue({
      id: 'session-id',
      userId: 'user-id',
      ...state,
    });

    await expect(service.refresh('token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
