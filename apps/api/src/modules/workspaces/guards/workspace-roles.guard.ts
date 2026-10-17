import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { isUUID } from 'class-validator';

import type { AuthUser } from '../../auth/types/auth.types';
import { WorkspaceRole } from '../../../generated/prisma/client';

import { WORKSPACE_ROLES_KEY } from '../decorators/workspace-roles.decorator';
import { WorkspaceMembersService } from '../workspace-members.service';

type WorkspaceRequest = Request & {
  user?: AuthUser;
  workspaceMembership?: Awaited<
    ReturnType<WorkspaceMembersService['requireMembership']>
  >;
};

@Injectable()
export class WorkspaceRolesGuard implements CanActivate {
  private readonly logger = new Logger(WorkspaceRolesGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly workspaceMembersService: WorkspaceMembersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<WorkspaceRequest>();

    if (!request.user) {
      throw new UnauthorizedException('Authentication required');
    }

    const workspaceId = request.params?.workspaceId;
    if (typeof workspaceId !== 'string' || !isUUID(workspaceId)) {
      throw new BadRequestException('Invalid workspaceId');
    }

    const allowedRoles = this.reflector.getAllAndOverride<
      WorkspaceRole[] | undefined
    >(WORKSPACE_ROLES_KEY, [context.getHandler(), context.getClass()]);

    if (allowedRoles === undefined) {
      this.logger.error(
        `Workspace roles metadata is missing for ${context.getClass().name}.${context.getHandler().name}`,
      );
      throw new InternalServerErrorException(
        'Unable to authorize workspace request',
      );
    }

    const membership =
      allowedRoles.length === 0
        ? await this.workspaceMembersService.requireMembership(
            workspaceId,
            request.user.id,
          )
        : await this.workspaceMembersService.requireRole(
            workspaceId,
            request.user.id,
            allowedRoles,
          );

    request.workspaceMembership = membership;
    return true;
  }
}
