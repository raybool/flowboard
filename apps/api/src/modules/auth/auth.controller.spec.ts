import { HttpAdapterHost } from '@nestjs/core';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { AuthService } from './auth.service';
import { AuthController } from './auth.controller';

describe('AuthController refresh errors', () => {
  const authService = { refresh: vi.fn() };
  const httpAdapter = { clearCookie: vi.fn(), setCookie: vi.fn() };
  const controller = new AuthController(
    authService as unknown as AuthService,
    { httpAdapter } as unknown as HttpAdapterHost,
  );

  beforeEach(() => vi.resetAllMocks());

  it('clears the cookie on an invalid refresh token', async () => {
    authService.refresh.mockRejectedValue(new UnauthorizedException());

    await expect(controller.refresh('invalid', {})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(httpAdapter.clearCookie).toHaveBeenCalledOnce();
  });

  it('preserves infrastructure errors and the existing cookie', async () => {
    const error = new ServiceUnavailableException();
    authService.refresh.mockRejectedValue(error);

    await expect(controller.refresh('valid', {})).rejects.toBe(error);
    expect(httpAdapter.clearCookie).not.toHaveBeenCalled();
  });
});
