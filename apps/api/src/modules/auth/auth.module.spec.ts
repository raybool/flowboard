import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { envSchema, type EnvConfig } from '../../config/env.schema';
import { authJwtOptions } from './auth.module';

describe('Auth JWT configuration', () => {
  it('signs an access token with the configured lifetime in seconds', async () => {
    const config = new ConfigService<EnvConfig, true>(envSchema.parse({
      DATABASE_URL: 'postgresql://example.invalid/test',
      JWT_ACCESS_SECRET: 'a'.repeat(32),
      JWT_ACCESS_EXPIRES_IN: '2h',
    }));
    const jwt = new JwtService(authJwtOptions(config));

    const token = await jwt.signAsync({ sub: 'user-id', sid: 'session-id', type: 'access' });
    const payload = await jwt.verifyAsync<{ iat: number; exp: number }>(token);

    expect(payload.exp - payload.iat).toBe(7200);
  });
});
