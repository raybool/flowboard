import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  Prisma,
  WorkspaceRole,
} from '../../generated/prisma/client';

import { PrismaService } from '../../database/prisma.service';

import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { AddMemberDto } from './dto/add-member.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';

const memberSelect = {
  id: true,
  role: true,
  joinedAt: true,
  user: {
    select: {
      id: true,
      name: true,
      email: true,
    },
  },
} satisfies Prisma.WorkspaceMemberSelect;

@Injectable()
export class WorkspacesService {
  constructor(private readonly prisma: PrismaService) {}

  private async getMembership(
    workspaceId: string,
    userId: string,
  ) {
    const membership =
      await this.prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId,
            userId,
          },
        },
      });

    if (!membership) {
      throw new NotFoundException('Workspace not found');
    }

    return membership;
  }

  private async requireRole(
    workspaceId: string,
    userId: string,
    allowedRoles: WorkspaceRole[],
  ) {
    const membership = await this.getMembership(
      workspaceId,
      userId,
    );

    if (!allowedRoles.includes(membership.role)) {
      throw new ForbiddenException('Insufficient permissions');
    }

    return membership;
  }

  async create(userId: string, dto: CreateWorkspaceDto) {
    try {
      return await this.prisma.workspace.create({
        data: {
          name: dto.name.trim(),
          slug: dto.slug,

          members: {
            create: {
              userId,
              role: WorkspaceRole.OWNER,
            },
          },
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Workspace slug already exists',
        );
      }

      throw error;
    }
  }

  async findAll(userId: string) {
    return this.prisma.workspace.findMany({
      where: {
        members: {
          some: { userId },
        },
      },
      include: {
        members: {
          where: { userId },
          select: { role: true },
        },
        _count: {
          select: { members: true },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findOne(workspaceId: string, userId: string) {
    await this.getMembership(workspaceId, userId);

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        _count: {
          select: { members: true },
        },
      },
    });

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    return workspace;
  }

  async update(
    workspaceId: string,
    userId: string,
    dto: UpdateWorkspaceDto,
  ) {
    await this.requireRole(workspaceId, userId, [
      WorkspaceRole.OWNER,
      WorkspaceRole.ADMIN,
    ]);

    return this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { name: dto.name.trim() },
    });
  }

  async getMembers(workspaceId: string, userId: string) {
    await this.getMembership(workspaceId, userId);

    return this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      select: memberSelect,
      orderBy: { joinedAt: 'asc' },
    });
  }

  async addMember(
    workspaceId: string,
    actorId: string,
    dto: AddMemberDto,
  ) {
    const actor = await this.requireRole(
      workspaceId,
      actorId,
      [WorkspaceRole.OWNER, WorkspaceRole.ADMIN],
    );

    if (dto.role === WorkspaceRole.OWNER) {
      throw new BadRequestException(
        'Cannot assign OWNER role',
      );
    }

    if (
      dto.role === WorkspaceRole.ADMIN &&
      actor.role !== WorkspaceRole.OWNER
    ) {
      throw new ForbiddenException(
        'Only owner can assign admins',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: {
        email: dto.email.trim().toLowerCase(),
      },
      select: { id: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    try {
      return await this.prisma.workspaceMember.create({
        data: {
          workspaceId,
          userId: user.id,
          role: dto.role,
        },
        select: memberSelect,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'User is already a workspace member',
        );
      }

      throw error;
    }
  }

  async updateMemberRole(
    workspaceId: string,
    actorId: string,
    memberId: string,
    dto: UpdateMemberRoleDto,
  ) {
    await this.requireRole(workspaceId, actorId, [
      WorkspaceRole.OWNER,
    ]);

    if (dto.role === WorkspaceRole.OWNER) {
      throw new BadRequestException(
        'Use ownership transfer to assign OWNER',
      );
    }

    const target = await this.prisma.workspaceMember.findFirst({
      where: {
        id: memberId,
        workspaceId,
      },
    });

    if (!target) {
      throw new NotFoundException('Member not found');
    }

    if (target.role === WorkspaceRole.OWNER) {
      throw new ForbiddenException(
        'Cannot change owner role',
      );
    }

    return this.prisma.workspaceMember.update({
      where: { id: target.id },
      data: { role: dto.role },
      select: memberSelect,
    });
  }

  async removeMember(
    workspaceId: string,
    actorId: string,
    memberId: string,
  ): Promise<void> {
    const actor = await this.requireRole(
      workspaceId,
      actorId,
      [WorkspaceRole.OWNER, WorkspaceRole.ADMIN],
    );

    const target = await this.prisma.workspaceMember.findFirst({
      where: {
        id: memberId,
        workspaceId,
      },
    });

    if (!target) {
      throw new NotFoundException('Member not found');
    }

    if (target.role === WorkspaceRole.OWNER) {
      throw new ForbiddenException(
        'Cannot remove workspace owner',
      );
    }

    if (
      target.role === WorkspaceRole.ADMIN &&
      actor.role !== WorkspaceRole.OWNER
    ) {
      throw new ForbiddenException(
        'Only owner can remove admins',
      );
    }

    await this.prisma.workspaceMember.delete({
      where: { id: target.id },
    });
  }
}