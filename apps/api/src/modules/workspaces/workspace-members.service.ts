import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { WorkspaceMember, WorkspaceRole } from '../../generated/prisma/client';

import { PrismaService } from '../../database/prisma.service';

type WorkspaceMemberDelegate = PrismaService['workspaceMember'];

@Injectable()
export class WorkspaceMembersService {
  constructor(private readonly prisma: PrismaService) {}

  findMembership(
    workspaceId: string,
    userId: string,
    workspaceMember: WorkspaceMemberDelegate = this.prisma.workspaceMember,
  ): Promise<WorkspaceMember | null> {
    return workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId,
        },
      },
    });
  }

  async requireMembership(
    workspaceId: string,
    userId: string,
    workspaceMember: WorkspaceMemberDelegate = this.prisma.workspaceMember,
  ): Promise<WorkspaceMember> {
    const membership = await this.findMembership(
      workspaceId,
      userId,
      workspaceMember,
    );

    if (!membership) {
      throw new NotFoundException('Workspace not found');
    }

    return membership;
  }

  async requireRole(
    workspaceId: string,
    userId: string,
    allowedRoles: readonly WorkspaceRole[],
    workspaceMember: WorkspaceMemberDelegate = this.prisma.workspaceMember,
  ): Promise<WorkspaceMember> {
    const membership = await this.requireMembership(
      workspaceId,
      userId,
      workspaceMember,
    );

    if (!allowedRoles.includes(membership.role)) {
      throw new ForbiddenException('Insufficient permissions');
    }

    return membership;
  }
}
