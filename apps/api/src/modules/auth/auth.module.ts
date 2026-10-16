import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';

import { DatabaseModule } from '../../database/database.module';
import type { EnvConfig } from '../../config/env.schema';

import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AccessTokenGuard } from './guards/access-token.guard';

@Module({
  imports: [
    DatabaseModule,

    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (
        config: ConfigService<EnvConfig, true>,
      ) => ({
        secret: config.get('JWT_ACCESS_SECRET', {
          infer: true,
        }),
        signOptions: {
          expiresIn: 15 * 60,
          issuer: 'flowboard-api',
          audience: 'flowboard-web',
          algorithm: 'HS256',
        },
        verifyOptions: {
          issuer: 'flowboard-api',
          audience: 'flowboard-web',
          algorithms: ['HS256'],
        },
      }),
    }),
  ],

  controllers: [AuthController],
  providers: [
    AuthService,
    AccessTokenGuard,
    {
      provide: APP_GUARD,
      useExisting: AccessTokenGuard,
    },
  ],
  exports: [AuthService, AccessTokenGuard],
})

export class AuthModule {}
