import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Cookies } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { AccessTokenGuard } from './guards/access-token.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import type { AuthUser } from './types/auth.types';

const COOKIE_NAME = 'flowboard_refresh';
const REFRESH_MAX_AGE = 30 * 24 * 60 * 60;

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly adapterHost: HttpAdapterHost,
  ) {}

  private setRefreshCookie(
    response: unknown,
    token: string,
  ): void {
    this.adapterHost.httpAdapter.setCookie(
      response,
      COOKIE_NAME,
      token,
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/api/v1/auth',
        maxAge: REFRESH_MAX_AGE,
      },
    );
  }

  private clearRefreshCookie(response: unknown): void {
    this.adapterHost.httpAdapter.clearCookie(
      response,
      COOKIE_NAME,
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/api/v1/auth',
      },
    );
  }

  @Post('register')
  @ApiOperation({ summary: 'Register user' })
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) response: unknown,
  ) {
    const result = await this.authService.register(dto);

    this.setRefreshCookie(response, result.refreshToken);

    return {
      user: result.user,
      accessToken: result.accessToken,
    };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login user' })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) response: unknown,
  ) {
    const result = await this.authService.login(dto);

    this.setRefreshCookie(response, result.refreshToken);

    return {
      user: result.user,
      accessToken: result.accessToken,
    };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh session' })
  async refresh(
    @Cookies(COOKIE_NAME) refreshToken: string | undefined,
    @Res({ passthrough: true }) response: unknown,
  ) {
    try {
      const tokens =
        await this.authService.refresh(refreshToken);

      this.setRefreshCookie(response, tokens.refreshToken);

      return {
        accessToken: tokens.accessToken,
      };
    } catch {
      this.clearRefreshCookie(response);

      throw new UnauthorizedException(
        'Invalid or expired refresh token',
      );
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Logout' })
  async logout(
    @Cookies(COOKIE_NAME) refreshToken: string | undefined,
    @Res({ passthrough: true }) response: unknown,
  ): Promise<void> {
    try {
      await this.authService.logout(refreshToken);
    } finally {
      this.clearRefreshCookie(response);
    }
  }

  @Get('me')
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Current user' })
  getMe(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }
}
