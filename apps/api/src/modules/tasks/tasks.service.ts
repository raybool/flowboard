import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvConfig } from '../../config/env.schema';
import {
  cursorWhere,
  decodePaginationCursor,
  encodePaginationCursor,
} from '../../common/pagination';
import { runSerializableTransaction } from '../../database/serializable-transaction';
import {
  Prisma,
  TaskPriority,
  WorkspaceRole,
} from '../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import type { AssigneeActivitySnapshot } from '../task-activity/task-activity.writer';
import { ActivityWriterService } from '../task-activity/task-activity.writer';
import { WorkspaceMembersService } from '../workspaces/workspace-members.service';

import { CreateTaskDto } from './dto/create-task.dto';
import { AssignTaskDto } from './dto/assign-task.dto';
import { FindTasksDto } from './dto/find-tasks.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { UpdateTaskStatusDto } from './dto/update-task-status.dto';

const managerRoles = [WorkspaceRole.OWNER, WorkspaceRole.ADMIN] as const;

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceMembersService: WorkspaceMembersService,
    private readonly activityWriter: ActivityWriterService,
    private readonly config?: ConfigService<EnvConfig, true>,
  ) {}

  private get transactionMaxAttempts(): number {
    return (
      this.config?.get('WORKSPACE_TRANSACTION_MAX_ATTEMPTS', {
        infer: true,
      }) ?? 3
    );
  }

  private withTaskNumber<T extends { sequence: number }>(
    task: T,
    projectKey: string,
  ) {
    return {
      ...task,
      taskNumber: `${projectKey}-${task.sequence}`,
    };
  }

  private toAssigneeSnapshot(
    assignee: {
      id: string;
      userId: string;
      user?: { name: string | null } | null;
    } | null,
  ): AssigneeActivitySnapshot | null {
    if (!assignee) {
      return null;
    }

    return {
      memberId: assignee.id,
      userId: assignee.userId,
      displayName: assignee.user?.name?.trim() || 'Workspace member',
    };
  }

  private async getAssigneeSnapshot(
    transaction: Prisma.TransactionClient,
    assignee: { id: string; userId: string } | null,
  ): Promise<AssigneeActivitySnapshot | null> {
    if (!assignee) {
      return null;
    }

    const user = transaction.user
      ? await transaction.user.findUnique({
          where: { id: assignee.userId },
          select: { name: true },
        })
      : null;

    return this.toAssigneeSnapshot({ ...assignee, user });
  }

  async create(
    workspaceId: string,
    projectId: string,
    userId: string,
    dto: CreateTaskDto,
  ) {
    return runSerializableTransaction(
      this.prisma,
      async (transaction) => {
        await this.workspaceMembersService.requireMembership(
          workspaceId,
          userId,
          transaction.workspaceMember,
        );

        const project = await transaction.project.findFirst({
          where: { id: projectId, workspaceId },
        });

        if (!project) {
          throw new NotFoundException('Project not found');
        }

        if (project.archivedAt) {
          throw new ConflictException('Project is archived');
        }

        let assigneeMemberId: string | null = null;
        let assigneeSnapshot: AssigneeActivitySnapshot | null = null;
        if (dto.assigneeId !== undefined) {
          const assignee = await transaction.workspaceMember.findUnique({
            where: {
              workspaceId_userId: {
                workspaceId,
                userId: dto.assigneeId,
              },
            },
          });

          if (!assignee) {
            throw new NotFoundException('Assignee not found in workspace');
          }

          assigneeMemberId = assignee.id;
          assigneeSnapshot = await this.getAssigneeSnapshot(
            transaction,
            assignee,
          );
        }

        const allocatedProject = await transaction.project.update({
          where: {
            workspaceId_id: {
              workspaceId,
              id: projectId,
            },
          },
          data: {
            nextTaskSequence: { increment: 1 },
          },
        });

        const task = await transaction.task.create({
          data: {
            workspaceId,
            projectId,
            sequence: allocatedProject.nextTaskSequence - 1,
            title: dto.title.trim(),
            description: dto.description?.trim() ?? null,
            priority: dto.priority ?? TaskPriority.NONE,
            creatorId: userId,
            assigneeMemberId,
          },
        });

        await this.activityWriter.write(transaction, {
          workspaceId,
          taskId: task.id,
          actorId: userId,
          type: 'TASK_CREATED',
          payload: {
            schemaVersion: 1,
            entity: 'task',
            snapshot: {
              taskId: task.id,
              taskNumber: `${project.key}-${task.sequence}`,
              title: task.title,
              status: task.status,
              priority: task.priority,
              assignee: assigneeSnapshot,
            },
          },
        });

        return this.withTaskNumber(task, project.key);
      },
      this.transactionMaxAttempts,
    );
  }

  async findAll(
    workspaceId: string,
    projectId: string,
    userId: string,
    query: FindTasksDto = {},
  ) {
    await this.workspaceMembersService.requireMembership(workspaceId, userId);

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, workspaceId },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const labelIds = query.labelIds ? [...new Set(query.labelIds)] : [];
    if (labelIds.length > 0) {
      const labels = await this.prisma.label.findMany({
        where: { workspaceId, id: { in: labelIds } },
        select: { id: true },
      });

      if (labels.length !== labelIds.length) {
        throw new NotFoundException('Label not found');
      }
    }

    const limit = query.limit ?? 50;
    const cursor = query.cursor
      ? decodePaginationCursor(query.cursor)
      : undefined;
    const tasks = await this.prisma.task.findMany({
      where: {
        workspaceId,
        projectId,
        ...(query.includeArchived === true ? {} : { archivedAt: null }),
        ...(query.status ? { status: query.status } : {}),
        ...(query.priority ? { priority: query.priority } : {}),
        ...(query.assigneeId
          ? { assigneeMember: { userId: query.assigneeId } }
          : {}),
        ...(labelIds.length > 0
          ? {
              AND: labelIds.map((labelId) => ({
                labels: { some: { workspaceId, labelId } },
              })),
            }
          : {}),
        workspace: { members: { some: { userId } } },
        ...(cursor ? cursorWhere(cursor) : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        workspaceId: true,
        projectId: true,
        sequence: true,
        title: true,
        description: true,
        status: true,
        priority: true,
        creatorId: true,
        assigneeMemberId: true,
        archivedAt: true,
        createdAt: true,
        updatedAt: true,
        project: { select: { key: true } },
      },
    });

    const hasNextPage = tasks.length > limit;
    const items = (hasNextPage ? tasks.slice(0, limit) : tasks).map(
      ({ project: taskProject, ...task }) =>
        this.withTaskNumber(task, taskProject.key),
    );

    return {
      items,
      nextCursor: hasNextPage
        ? encodePaginationCursor(items[items.length - 1])
        : null,
    };
  }

  async findOne(
    workspaceId: string,
    projectId: string,
    taskId: string,
    userId: string,
  ) {
    await this.workspaceMembersService.requireMembership(workspaceId, userId);

    const task = await this.prisma.task.findFirst({
      where: { id: taskId, workspaceId, projectId },
      include: { project: { select: { key: true } } },
    });

    if (!task) {
      throw new NotFoundException('Task not found');
    }

    return this.withTaskNumber(task, task.project.key);
  }

  async update(
    workspaceId: string,
    projectId: string,
    taskId: string,
    userId: string,
    dto: UpdateTaskDto,
  ) {
    return runSerializableTransaction(
      this.prisma,
      async (transaction) => {
        const membership = await this.workspaceMembersService.requireMembership(
          workspaceId,
          userId,
          transaction.workspaceMember,
        );

        const task = await transaction.task.findFirst({
          where: { id: taskId, workspaceId, projectId },
          include: {
            project: { select: { key: true, archivedAt: true } },
            assigneeMember: {
              select: {
                id: true,
                userId: true,
                user: { select: { name: true } },
              },
            },
          },
        });

        if (!task) {
          throw new NotFoundException('Task not found');
        }

        if (task.archivedAt) {
          throw new ConflictException('Task is archived');
        }

        if (task.project.archivedAt) {
          throw new ConflictException('Project is archived');
        }

        const isManager = managerRoles.some((role) => role === membership.role);
        const ownsTask =
          task.creatorId === userId || task.assigneeMember?.userId === userId;
        if (!isManager && !ownsTask) {
          throw new ForbiddenException('Insufficient permissions');
        }

        const data: Prisma.TaskUpdateInput = {};
        const changes: {
          title?: { from: string; to: string };
          descriptionChanged?: true;
        } = {};
        if (dto.title !== undefined) {
          const title = dto.title.trim();
          if (title !== task.title) {
            data.title = title;
            changes.title = { from: task.title, to: title };
          }
        }
        if (dto.description !== undefined) {
          const description = dto.description?.trim() ?? null;
          if (description !== task.description) {
            data.description = description;
            changes.descriptionChanged = true;
          }
        }
        if (dto.priority !== undefined) {
          if (dto.priority !== task.priority) {
            data.priority = dto.priority;
          }
        }

        const updatedTask = await transaction.task.update({
          where: { id: taskId },
          data,
        });

        const taskNumber = `${task.project.key}-${task.sequence}`;
        if (Object.keys(changes).length > 0) {
          await this.activityWriter.write(transaction, {
            workspaceId,
            taskId,
            actorId: userId,
            type: 'TASK_UPDATED',
            payload: {
              schemaVersion: 1,
              entity: 'task',
              snapshot: { taskId, taskNumber },
              changes,
            },
          });
        }
        if (dto.priority !== undefined && dto.priority !== task.priority) {
          await this.activityWriter.write(transaction, {
            workspaceId,
            taskId,
            actorId: userId,
            type: 'TASK_PRIORITY_CHANGED',
            payload: {
              schemaVersion: 1,
              entity: 'task',
              snapshot: { taskId, taskNumber },
              changes: { priority: { from: task.priority, to: dto.priority } },
            },
          });
        }

        return this.withTaskNumber(updatedTask, task.project.key);
      },
      this.transactionMaxAttempts,
    );
  }

  async updateStatus(
    workspaceId: string,
    projectId: string,
    taskId: string,
    userId: string,
    dto: UpdateTaskStatusDto,
  ) {
    return runSerializableTransaction(
      this.prisma,
      async (transaction) => {
        const membership = await this.workspaceMembersService.requireMembership(
          workspaceId,
          userId,
          transaction.workspaceMember,
        );

        const task = await transaction.task.findFirst({
          where: { id: taskId, workspaceId, projectId },
          include: {
            project: { select: { key: true, archivedAt: true } },
            assigneeMember: { select: { userId: true } },
          },
        });

        if (!task) {
          throw new NotFoundException('Task not found');
        }

        if (task.archivedAt) {
          throw new ConflictException('Task is archived');
        }

        if (task.project.archivedAt) {
          throw new ConflictException('Project is archived');
        }

        const isManager = managerRoles.some((role) => role === membership.role);
        const ownsTask =
          task.creatorId === userId || task.assigneeMember?.userId === userId;
        if (!isManager && !ownsTask) {
          throw new ForbiddenException('Insufficient permissions');
        }

        if (dto.status === task.status) {
          return this.withTaskNumber(task, task.project.key);
        }

        const updatedTask = await transaction.task.update({
          where: { id: taskId },
          data: { status: dto.status },
        });

        await this.activityWriter.write(transaction, {
          workspaceId,
          taskId,
          actorId: userId,
          type: 'TASK_STATUS_CHANGED',
          payload: {
            schemaVersion: 1,
            entity: 'task',
            snapshot: {
              taskId,
              taskNumber: `${task.project.key}-${task.sequence}`,
            },
            changes: { status: { from: task.status, to: dto.status } },
          },
        });

        return this.withTaskNumber(updatedTask, task.project.key);
      },
      this.transactionMaxAttempts,
    );
  }

  async assign(
    workspaceId: string,
    projectId: string,
    taskId: string,
    userId: string,
    dto: AssignTaskDto,
  ) {
    return runSerializableTransaction(
      this.prisma,
      async (transaction) => {
        const membership = await this.workspaceMembersService.requireMembership(
          workspaceId,
          userId,
          transaction.workspaceMember,
        );

        const task = await transaction.task.findFirst({
          where: { id: taskId, workspaceId, projectId },
          include: {
            project: { select: { key: true, archivedAt: true } },
            assigneeMember: {
              select: {
                id: true,
                userId: true,
                user: { select: { name: true } },
              },
            },
          },
        });

        if (!task) {
          throw new NotFoundException('Task not found');
        }

        if (task.archivedAt) {
          throw new ConflictException('Task is archived');
        }

        if (task.project.archivedAt) {
          throw new ConflictException('Project is archived');
        }

        const isManager = managerRoles.some((role) => role === membership.role);
        if (!isManager) {
          if (dto.assigneeId !== null && dto.assigneeId !== userId) {
            throw new ForbiddenException('Members can only assign themselves');
          }

          if (
            dto.assigneeId === null &&
            task.assigneeMember?.userId !== userId
          ) {
            throw new ForbiddenException(
              'Members can only remove their own assignment',
            );
          }
        }

        let assigneeMemberId: string | null = null;
        let newAssignee: {
          id: string;
          userId: string;
          user?: { name: string | null } | null;
        } | null = null;
        if (dto.assigneeId !== null) {
          const assignee =
            dto.assigneeId === userId
              ? await transaction.workspaceMember.findUnique({
                  where: {
                    workspaceId_userId: { workspaceId, userId },
                  },
                })
              : await transaction.workspaceMember.findUnique({
                  where: {
                    workspaceId_userId: {
                      workspaceId,
                      userId: dto.assigneeId,
                    },
                  },
                });

          if (!assignee) {
            throw new NotFoundException('Assignee not found in workspace');
          }

          assigneeMemberId = assignee.id;
          newAssignee = assignee;
        }

        const previousAssignee = this.toAssigneeSnapshot(task.assigneeMember);
        const nextAssignee = await this.getAssigneeSnapshot(
          transaction,
          newAssignee,
        );
        if (task.assigneeMemberId === assigneeMemberId) {
          return this.withTaskNumber(task, task.project.key);
        }

        const updatedTask = await transaction.task.update({
          where: { id: taskId },
          data: { assigneeMemberId },
        });

        await this.activityWriter.write(transaction, {
          workspaceId,
          taskId,
          actorId: userId,
          type: 'TASK_ASSIGNEE_CHANGED',
          payload: {
            schemaVersion: 1,
            entity: 'task',
            snapshot: {
              taskId,
              taskNumber: `${task.project.key}-${task.sequence}`,
            },
            changes: {
              assignee: { from: previousAssignee, to: nextAssignee },
            },
          },
        });

        return this.withTaskNumber(updatedTask, task.project.key);
      },
      this.transactionMaxAttempts,
    );
  }

  async archive(
    workspaceId: string,
    projectId: string,
    taskId: string,
    userId: string,
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

        const task = await transaction.task.findFirst({
          where: { id: taskId, workspaceId, projectId },
          include: { project: { select: { key: true } } },
        });

        if (!task) {
          throw new NotFoundException('Task not found');
        }

        if (task.archivedAt) {
          throw new ConflictException('Task is already archived');
        }

        const archivedTask = await transaction.task.update({
          where: { id: taskId },
          data: { archivedAt: new Date() },
        });

        await this.activityWriter.write(transaction, {
          workspaceId,
          taskId,
          actorId: userId,
          type: 'TASK_ARCHIVED',
          payload: {
            schemaVersion: 1,
            entity: 'task',
            snapshot: {
              taskId,
              taskNumber: `${task.project.key}-${task.sequence}`,
            },
            changes: {
              archivedAt: {
                from: null,
                to: archivedTask.archivedAt?.toISOString() ?? null,
              },
            },
          },
        });

        return this.withTaskNumber(archivedTask, task.project.key);
      },
      this.transactionMaxAttempts,
    );
  }
}
