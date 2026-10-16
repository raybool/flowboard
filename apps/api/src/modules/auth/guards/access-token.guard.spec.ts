import type { ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';

import { AuthService } from '../auth.service';
import { Public } from '../decorators/public.decorator';

import { AccessTokenGuard } from './access-token.guard';

class TestController {
  @Public()
  publicRoute(this: void): void {}

  protectedRoute(this: void): void {}
}

function createContext(
  handler: () => void,
  request: { headers: { authorization?: string }; user?: unknown },
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => TestController,
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('AccessTokenGuard', () => {
  const jwt = {
    verifyAsync: vi.fn(),
  };
  const authService = {
    validateAccess: vi.fn(),
  };
  const guard = new AccessTokenGuard(
    jwt as unknown as JwtService,
    authService as unknown as AuthService,
    new Reflector(),
  );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows routes decorated with Public without a token', async () => {
    const context = createContext(TestController.prototype.publicRoute, {
      headers: {},
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(jwt.verifyAsync).not.toHaveBeenCalled();
  });

  it('validates the access token for protected routes', async () => {
    const payload = {
      sub: 'user-id',
      sid: 'session-id',
      type: 'access' as const,
    };
    const user = {
      id: 'user-id',
      email: 'user@example.com',
      name: 'User',
    };
    const request = {
      headers: { authorization: 'Bearer access-token' },
      user: undefined as unknown,
    };

    jwt.verifyAsync.mockResolvedValue(payload);
    authService.validateAccess.mockResolvedValue(user);

    const context = createContext(
      TestController.prototype.protectedRoute,
      request,
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(authService.validateAccess).toHaveBeenCalledWith(payload);
    expect(request.user).toEqual(user);
  });
});
