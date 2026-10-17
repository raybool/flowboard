import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Prisma, WorkspaceRole } from '../../generated/prisma/client';

import { PrismaService } from '../../database/prisma.service';
import { runSerializableTransaction } from '../../database/serializable-transaction';
import type { EnvConfig } from '../../config/env.schema';

import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { AddMemberDto } from './dto/add-member.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { WorkspaceMembersService } from './workspace-members.service';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceMembersService: WorkspaceMembersService,
    private readonly config?: ConfigService<EnvConfig, true>,
  ) {}

  private get transactionMaxAttempts(): number {
    return (
      this.config?.get('WORKSPACE_TRANSACTION_MAX_ATTEMPTS', {
        infer: true,
      }) ?? 3
    );
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
        throw new ConflictException('Workspace slug already exists');
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
    const workspace = await this.prisma.workspace.findFirst({
      where: {
        id: workspaceId,
        members: { some: { userId } },
      },
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

  async update(workspaceId: string, userId: string, dto: UpdateWorkspaceDto) {
    return runSerializableTransaction(
      this.prisma,
      async (transaction) => {
        await this.workspaceMembersService.requireRole(
          workspaceId,
          userId,
          [WorkspaceRole.OWNER, WorkspaceRole.ADMIN],
          transaction.workspaceMember,
        );

        return transaction.workspace.update({
          where: { id: workspaceId },
          data: { name: dto.name.trim() },
        });
      },
      this.transactionMaxAttempts,
    );
  }

  async getMembers(workspaceId: string, userId: string) {
    const workspace = await this.prisma.workspace.findFirst({
      where: {
        id: workspaceId,
        members: { some: { userId } },
      },
      select: {
        members: {
          select: memberSelect,
          orderBy: { joinedAt: 'asc' },
        },
      },
    });

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    return workspace.members;
  }

  async addMember(workspaceId: string, actorId: string, dto: AddMemberDto) {
    return runSerializableTransaction(
      this.prisma,
      async (transaction) => {
        const actor = await this.workspaceMembersService.requireRole(
          workspaceId,
          actorId,
          [WorkspaceRole.OWNER, WorkspaceRole.ADMIN],
          transaction.workspaceMember,
        );

        if (dto.role === WorkspaceRole.OWNER) {
          throw new BadRequestException('Cannot assign OWNER role');
        }

        if (
          dto.role === WorkspaceRole.ADMIN &&
          actor.role !== WorkspaceRole.OWNER
        ) {
          throw new ForbiddenException('Only owner can assign admins');
        }

        const user = await transaction.user.findUnique({
          where: {
            email: dto.email.trim().toLowerCase(),
          },
          select: { id: true },
        });

        if (!user) {
          throw new NotFoundException('User not found');
        }

        try {
          return await transaction.workspaceMember.create({
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
            throw new ConflictException('User is already a workspace member');
          }

          throw error;
        }
      },
      this.transactionMaxAttempts,
    );
  }

  async updateMemberRole(
    workspaceId: string,
    actorId: string,
    memberId: string,
    dto: UpdateMemberRoleDto,
  ) {
    return runSerializableTransaction(
      this.prisma,
      async (transaction) => {
        await this.workspaceMembersService.requireRole(
          workspaceId,
          actorId,
          [WorkspaceRole.OWNER],
          transaction.workspaceMember,
        );

        if (dto.role === WorkspaceRole.OWNER) {
          throw new BadRequestException(
            'Use ownership transfer to assign OWNER',
          );
        }

        const target = await transaction.workspaceMember.findFirst({
          where: {
            id: memberId,
            workspaceId,
          },
        });

        if (!target) {
          throw new NotFoundException('Member not found');
        }

        if (target.role === WorkspaceRole.OWNER) {
          throw new ForbiddenException('Cannot change owner role');
        }

        return transaction.workspaceMember.update({
          where: { id: target.id },
          data: { role: dto.role },
          select: memberSelect,
        });
      },
      this.transactionMaxAttempts,
    );
  }

  async removeMember(
    workspaceId: string,
    actorId: string,
    memberId: string,
  ): Promise<void> {
    await runSerializableTransaction(
      this.prisma,
      async (transaction) => {
        const actor = await this.workspaceMembersService.requireRole(
          workspaceId,
          actorId,
          [WorkspaceRole.OWNER, WorkspaceRole.ADMIN],
          transaction.workspaceMember,
        );

        const target = await transaction.workspaceMember.findFirst({
          where: {
            id: memberId,
            workspaceId,
          },
        });

        if (!target) {
          throw new NotFoundException('Member not found');
        }

        if (target.role === WorkspaceRole.OWNER) {
          throw new ForbiddenException('Cannot remove workspace owner');
        }

        if (
          target.role === WorkspaceRole.ADMIN &&
          actor.role !== WorkspaceRole.OWNER
        ) {
          throw new ForbiddenException('Only owner can remove admins');
        }

        await transaction.task.updateMany({
          where: {
            workspaceId,
            assigneeMemberId: target.id,
          },
          data: { assigneeMemberId: null },
        });

        await transaction.workspaceMember.delete({
          where: { id: target.id },
        });
      },
      this.transactionMaxAttempts,
    );
  }
}
