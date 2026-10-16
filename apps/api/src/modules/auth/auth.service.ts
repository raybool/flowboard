import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '../../generated/prisma/client';
import {
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import * as argon2 from 'argon2';

import { PrismaService } from '../../database/prisma.service';
import type { EnvConfig } from '../../config/env.schema';

import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import type {
  AccessTokenPayload,
  AuthResult,
  AuthTokens,
  AuthUser,
} from './types/auth.types';

const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  private hashToken(token: string): string {
    return createHash('sha256')
      .update(token)
      .digest('hex');
  }

  private generateRefreshToken(): string {
    return randomBytes(48).toString('base64url');
  }

  private async signAccessToken(
    userId: string,
    sessionId: string,
  ): Promise<string> {
    const payload: AccessTokenPayload = {
      sub: userId,
      sid: sessionId,
      type: 'access',
    };

    return this.jwt.signAsync(payload);
  }

  private async createSession(
    userId: string,
  ): Promise<AuthTokens> {
    const sessionId = randomUUID();
    const refreshToken = this.generateRefreshToken();
    const accessToken = await this.signAccessToken(userId, sessionId);

    await this.prisma.session.create({
      data: {
        id: sessionId,
        userId,
        refreshTokenHash: this.hashToken(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });

    return { accessToken, refreshToken };
  }

  async register(dto: RegisterDto): Promise<AuthResult> {
    const email = dto.email.trim().toLowerCase();

    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
    });

    const userId = randomUUID();
    const sessionId = randomUUID();
    const refreshToken = this.generateRefreshToken();
    const accessToken = await this.signAccessToken(userId, sessionId);

    let user;

    try {
      user = await this.prisma.user.create({
        data: {
          id: userId,
          email,
          name: dto.name.trim(),
          passwordHash,
          sessions: {
            create: {
              id: sessionId,
              refreshTokenHash: this.hashToken(refreshToken),
              expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
            },
          },
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Email already registered');
      }

      throw error;
    }

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
      accessToken,
      refreshToken,
    };
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const email = dto.email.trim().toLowerCase();

    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new UnauthorizedException(
        'Invalid email or password',
      );
    }

    const valid = await argon2.verify(
      user.passwordHash,
      dto.password,
    );

    if (!valid) {
      throw new UnauthorizedException(
        'Invalid email or password',
      );
    }

    const tokens = await this.createSession(user.id);

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
      ...tokens,
    };
  }

  async refresh(refreshToken?: string): Promise<AuthTokens> {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token missing');
    }

    const tokenHash = this.hashToken(refreshToken);

    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: tokenHash },
    });

    if (!session) {
      await this.revokeReplayedSession(tokenHash);
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (
      session.revokedAt ||
      session.expiresAt <= new Date()
    ) {
      throw new UnauthorizedException(
        'Invalid or expired refresh token',
      );
    }

    const newRefreshToken = this.generateRefreshToken();
    const accessToken = await this.signAccessToken(
      session.userId,
      session.id,
    );

    // The old hash and the replacement must commit together. A failed history
    // insert rolls the session update back, so a client can retry safely.
    const rotated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.session.updateMany({
        where: {
          id: session.id,
          refreshTokenHash: tokenHash,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: {
          refreshTokenHash: this.hashToken(newRefreshToken),
        },
      });

      if (result.count !== 1) return false;

      await tx.usedRefreshToken.create({
        data: { tokenHash, sessionId: session.id },
      });

      return true;
    });

    if (!rotated) {
      await this.revokeReplayedSession(tokenHash);
      throw new UnauthorizedException(
        'Refresh token already used',
      );
    }

    return {
      accessToken,
      refreshToken: newRefreshToken,
    };
  }

  private async revokeReplayedSession(tokenHash: string): Promise<void> {
    const used = await this.prisma.usedRefreshToken.findUnique({
      where: { tokenHash },
      select: { sessionId: true },
    });

    if (used) {
      await this.prisma.session.updateMany({
        where: { id: used.sessionId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
  }

  async logout(refreshToken?: string): Promise<void> {
    if (!refreshToken) return;

    await this.prisma.session.updateMany({
      where: {
        refreshTokenHash: this.hashToken(refreshToken),
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
  }

  async validateAccess(
    payload: AccessTokenPayload,
  ): Promise<AuthUser> {
    const session = await this.prisma.session.findFirst({
      where: {
        id: payload.sid,
        userId: payload.sub,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { user: true },
    });

    if (!session) {
      throw new UnauthorizedException('Session expired');
    }

    return {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    };
  }
}
