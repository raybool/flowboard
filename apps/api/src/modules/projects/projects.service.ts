import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Prisma, WorkspaceRole } from '../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { runSerializableTransaction } from '../../database/serializable-transaction';
import type { EnvConfig } from '../../config/env.schema';
import {
  cursorWhere,
  decodePaginationCursor,
  encodePaginationCursor,
} from '../../common/pagination';
import { WorkspaceMembersService } from '../workspaces/workspace-members.service';

import { CreateProjectDto } from './dto/create-project.dto';
import { FindProjectsDto } from './dto/find-projects.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

const managerRoles = [WorkspaceRole.OWNER, WorkspaceRole.ADMIN] as const;

@Injectable()
export class ProjectsService {
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

  async create(workspaceId: string, userId: string, dto: CreateProjectDto) {
    return runSerializableTransaction(
      this.prisma,
      async (transaction) => {
        await this.workspaceMembersService.requireRole(
          workspaceId,
          userId,
          managerRoles,
          transaction.workspaceMember,
        );

        try {
          return await transaction.project.create({
            data: {
              workspaceId,
              name: dto.name.trim(),
              key: dto.key,
              description: dto.description?.trim() ?? null,
            },
          });
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          ) {
            throw new ConflictException('Project key already exists');
          }

          throw error;
        }
      },
      this.transactionMaxAttempts,
    );
  }

  async findAll(
    workspaceId: string,
    userId: string,
    query: FindProjectsDto = {},
  ) {
    await this.workspaceMembersService.requireMembership(workspaceId, userId);

    const limit = query.limit ?? 50;
    const cursor = query.cursor
      ? decodePaginationCursor(query.cursor)
      : undefined;
    const projects = await this.prisma.project.findMany({
      where: {
        workspaceId,
        ...(query.includeArchived === true ? {} : { archivedAt: null }),
        workspace: { members: { some: { userId } } },
        ...(cursor ? cursorWhere(cursor) : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        workspaceId: true,
        name: true,
        key: true,
        description: true,
        nextTaskSequence: true,
        archivedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const hasNextPage = projects.length > limit;
    const items = hasNextPage ? projects.slice(0, limit) : projects;

    return {
      items,
      nextCursor: hasNextPage
        ? encodePaginationCursor(items[items.length - 1])
        : null,
    };
  }

  async findOne(workspaceId: string, projectId: string, userId: string) {
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        workspaceId,
        workspace: {
          members: {
            some: { userId },
          },
        },
      },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    return project;
  }

  async update(
    workspaceId: string,
    projectId: string,
    userId: string,
    dto: UpdateProjectDto,
  ) {
    return runSerializableTransaction(
      this.prisma,
      async (transaction) => {
        await this.workspaceMembersService.requireRole(
          workspaceId,
          userId,
          managerRoles,
          transaction.workspaceMember,
        );

        const project = await transaction.project.findFirst({
          where: {
            id: projectId,
            workspaceId,
          },
        });

        if (!project) {
          throw new NotFoundException('Project not found');
        }

        if (project.archivedAt) {
          throw new ConflictException('Project is archived');
        }

        const data: Prisma.ProjectUpdateInput = {};
        if (dto.name !== undefined) {
          data.name = dto.name.trim();
        }
        if (dto.description !== undefined) {
          data.description = dto.description?.trim() ?? null;
        }

        return transaction.project.update({
          where: {
            workspaceId_id: {
              workspaceId,
              id: projectId,
            },
          },
          data,
        });
      },
      this.transactionMaxAttempts,
    );
  }

  async archive(workspaceId: string, projectId: string, userId: string) {
    return runSerializableTransaction(
      this.prisma,
      async (transaction) => {
        await this.workspaceMembersService.requireRole(
          workspaceId,
          userId,
          managerRoles,
          transaction.workspaceMember,
        );

        const project = await transaction.project.findFirst({
          where: {
            id: projectId,
            workspaceId,
          },
        });

        if (!project) {
          throw new NotFoundException('Project not found');
        }

        if (project.archivedAt) {
          throw new ConflictException('Project is already archived');
        }

        return transaction.project.update({
          where: {
            workspaceId_id: {
              workspaceId,
              id: projectId,
            },
          },
          data: {
            archivedAt: new Date(),
          },
        });
      },
      this.transactionMaxAttempts,
    );
  }
}
