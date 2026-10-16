import type { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import {
  ThrottlerGuard,
  ThrottlerStorageService,
} from '@nestjs/throttler';
import { AuthController } from './auth.controller';
import { AUTH_RATE_LIMIT } from './auth.module';

function contextFor(
  handler: AuthController['login'] | AuthController['register'] | AuthController['refresh'],
  ip: string,
): ExecutionContext {
  return {
    getClass: () => AuthController,
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: () => ({ ip, headers: {} }),
      getResponse: () => ({ setHeader: vi.fn() }),
    }),
  } as unknown as ExecutionContext;
}

describe('Auth route rate limiting', () => {
  it('uses the socket IP by default and the forwarded IP for one trusted hop', () => {
    const adapter = new ExpressAdapter();
    const app = adapter.getInstance();
    const request = Object.create(app.request) as {
      socket: { remoteAddress: string };
      headers: Record<string, string>;
      ip: string;
    };
    request.socket = { remoteAddress: '198.51.100.10' };
    request.headers = { 'x-forwarded-for': '203.0.113.20' };

    app.set('trust proxy', 0);
    expect(request.ip).toBe('198.51.100.10');

    app.set('trust proxy', 1);
    expect(request.ip).toBe('203.0.113.20');
  });

  it.each(['login', 'register'] as const)
    ('returns 429 after the limit on %s', async (route) => {
      const handler = AuthController.prototype[route];
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(ThrottlerGuard);

      const storage = new ThrottlerStorageService();
      const guard = new ThrottlerGuard(
        [AUTH_RATE_LIMIT],
        storage,
        new Reflector(),
      );
      await guard.onModuleInit();
      const context = contextFor(handler, '192.0.2.1');

      try {
        for (let request = 0; request < AUTH_RATE_LIMIT.limit; request++) {
          await expect(guard.canActivate(context)).resolves.toBe(true);
        }
        await expect(guard.canActivate(context)).rejects.toMatchObject({
          status: 429,
        });
      } finally {
        storage.onApplicationShutdown();
      }
    });

  it('returns 429 on the 31st refresh request', async () => {
    const handler = AuthController.prototype['refresh'];
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(ThrottlerGuard);
    const storage = new ThrottlerStorageService();
    const guard = new ThrottlerGuard([AUTH_RATE_LIMIT], storage, new Reflector());
    await guard.onModuleInit();
    const context = contextFor(handler, '192.0.2.2');

    try {
      for (let request = 0; request < 30; request++) {
        await expect(guard.canActivate(context)).resolves.toBe(true);
      }
      await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 429 });
    } finally {
      storage.onApplicationShutdown();
    }
  });
});
