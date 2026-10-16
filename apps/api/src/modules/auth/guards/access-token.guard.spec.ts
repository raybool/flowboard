import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import {
  JsonWebTokenError,
  JwtService,
  TokenExpiredError,
} from '@nestjs/jwt';
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

  it.each([
    new JsonWebTokenError('malformed'),
    new TokenExpiredError('expired', new Date()),
  ])('returns 401 for invalid JWTs', async (error) => {
    jwt.verifyAsync.mockRejectedValue(error);
    const context = createContext(TestController.prototype.protectedRoute, {
      headers: { authorization: 'Bearer invalid' },
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(authService.validateAccess).not.toHaveBeenCalled();
  });

  it('preserves infrastructure errors from JWT verification', async () => {
    const error = new ServiceUnavailableException();
    jwt.verifyAsync.mockRejectedValue(error);
    const context = createContext(TestController.prototype.protectedRoute, {
      headers: { authorization: 'Bearer token' },
    });

    await expect(guard.canActivate(context)).rejects.toBe(error);
  });

  it.each([null, 'text', { sub: 'user-id', type: 'access' }])
    ('rejects malformed JWT payloads with 401', async (payload) => {
      jwt.verifyAsync.mockResolvedValue(payload);
      const context = createContext(TestController.prototype.protectedRoute, {
        headers: { authorization: 'Bearer token' },
      });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(authService.validateAccess).not.toHaveBeenCalled();
    });

  it.each([
    new UnauthorizedException('Session expired'),
    new ForbiddenException('Insufficient permissions'),
    new ServiceUnavailableException(),
  ])('preserves session validation errors', async (error) => {
    jwt.verifyAsync.mockResolvedValue({
      sub: 'user-id',
      sid: 'session-id',
      type: 'access',
    });
    authService.validateAccess.mockRejectedValue(error);
    const context = createContext(TestController.prototype.protectedRoute, {
      headers: { authorization: 'Bearer token' },
    });

    await expect(guard.canActivate(context)).rejects.toBe(error);
  });
});
