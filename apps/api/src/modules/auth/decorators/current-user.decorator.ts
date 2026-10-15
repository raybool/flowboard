import {
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';

import type { AuthUser } from '../types/auth.types';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser => {
    const request = context.switchToHttp().getRequest();

    return request.user as AuthUser;
  },
);
