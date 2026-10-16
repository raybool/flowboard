import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import type { JwtModuleOptions } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';

import { DatabaseModule } from '../../database/database.module';
import type { EnvConfig } from '../../config/env.schema';

import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { ExpiredSessionsCleanupService } from './expired-sessions-cleanup.service';
import { AccessTokenGuard } from './guards/access-token.guard';

export const AUTH_RATE_LIMIT = { ttl: 60_000, limit: 5 };

export function authJwtOptions(
  config: ConfigService<EnvConfig, true>,
): JwtModuleOptions {
  return {
    secret: config.get('JWT_ACCESS_SECRET', { infer: true }),
    signOptions: {
      expiresIn: config.get('JWT_ACCESS_EXPIRES_IN', { infer: true }),
      issuer: 'flowboard-api',
      audience: 'flowboard-web',
      algorithm: 'HS256',
    },
    verifyOptions: {
      issuer: 'flowboard-api',
      audience: 'flowboard-web',
      algorithms: ['HS256'],
    },
  };
}

@Module({
  imports: [
    DatabaseModule,
    ThrottlerModule.forRoot([AUTH_RATE_LIMIT]),

    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: authJwtOptions,
    }),
  ],

  controllers: [AuthController],
  providers: [
    AuthService,
    ExpiredSessionsCleanupService,
    AccessTokenGuard,
    {
      provide: APP_GUARD,
      useExisting: AccessTokenGuard,
    },
  ],
  exports: [AuthService, AccessTokenGuard],
})

export class AuthModule {}
