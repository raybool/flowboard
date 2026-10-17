import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvConfig } from '../../config/env.schema';
import {
  cursorWhere,
  decodePaginationCursor,
  encodePaginationCursor,
} from '../../common/pagination';
import { PrismaService } from '../../database/prisma.service';
import { runSerializableTransaction } from '../../database/serializable-transaction';
import { Prisma, WorkspaceRole } from '../../generated/prisma/client';
import { ActivityWriterService } from '../task-activity/task-activity.writer';
import { WorkspaceMembersService } from '../workspaces/workspace-members.service';

import { CreateLabelDto } from './dto/create-label.dto';
import { ListLabelsDto } from './dto/list-labels.dto';
import { UpdateLabelDto } from './dto/update-label.dto';
import { normalizeLabelNameKey } from './label-name-normalization';

const managerRoles = [WorkspaceRole.OWNER, WorkspaceRole.ADMIN] as const;

/**
 * Temporary compatibility guard while legacy name_key values are still in
 * the database. The extra row makes an oversized scan fail closed instead of
 * allowing a mutation whose legacy-equivalence check was incomplete.
 */
export const MAX_LABEL_NAME_COMPATIBILITY_SCAN = 1_000;

const labelSelect = {
  id: true,
  workspaceId: true,
  name: true,
  color: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.LabelSelect;

type SelectedLabel = Prisma.LabelGetPayload<{ select: typeof labelSelect }>;

@Injectable()
export class LabelsService {
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

  private normalizeName(name: string): string {
    return name.trim().normalize('NFC');
  }

  private normalizeColor(color: string): string {
    return color.trim().toUpperCase();
  }

  private isPrismaError(error: unknown, code: string): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === code
    );
  }

  private serialize(label: SelectedLabel) {
    return { ...label };
  }

  private async lockWorkspaceLabelNames(
    transaction: Prisma.TransactionClient,
    workspaceId: string,
  ): Promise<void> {
    await transaction.$queryRaw(
      Prisma.sql`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`,
    );
  }

  private async assertWorkspaceLabelCountWithinCompatibilityScan(
    transaction: Prisma.TransactionClient,
    workspaceId: string,
  ): Promise<void> {
    const labels = await transaction.label.findMany({
      where: { workspaceId },
      orderBy: { id: 'asc' },
      select: { id: true },
      take: MAX_LABEL_NAME_COMPATIBILITY_SCAN + 1,
    });

    if (labels.length > MAX_LABEL_NAME_COMPATIBILITY_SCAN) {
      throw new ServiceUnavailableException(
        'Label name compatibility check requires a completed name_key backfill',
      );
    }
  }

  private async assertNameAvailableWithLegacyCompatibility(
    transaction: Prisma.TransactionClient,
    workspaceId: string,
    name: string,
    excludedLabelId?: string,
  ): Promise<void> {
    const labels = await transaction.label.findMany({
      where: {
        workspaceId,
        ...(excludedLabelId ? { id: { not: excludedLabelId } } : {}),
      },
      orderBy: { id: 'asc' },
      select: { id: true, name: true },
      take: MAX_LABEL_NAME_COMPATIBILITY_SCAN + 1,
    });

    const normalizedNameKey = normalizeLabelNameKey(name);
    if (
      labels.some(
        (label) => normalizeLabelNameKey(label.name) === normalizedNameKey,
      )
    ) {
      throw new ConflictException('Label name already exists');
    }
  }

  async create(workspaceId: string, userId: string, dto: CreateLabelDto) {
    return runSerializableTransaction(
      this.prisma,
      async (transaction) => {
        await this.workspaceMembersService.requireRole(
          workspaceId,
          userId,
          managerRoles,
          transaction.workspaceMember,
        );

        await this.lockWorkspaceLabelNames(transaction, workspaceId);
        const name = this.normalizeName(dto.name);
        await this.assertWorkspaceLabelCountWithinCompatibilityScan(
          transaction,
          workspaceId,
        );
        await this.assertNameAvailableWithLegacyCompatibility(
          transaction,
          workspaceId,
          name,
        );

        try {
          const label = await transaction.label.create({
            data: {
              workspaceId,
              name,
              nameKey: normalizeLabelNameKey(name),
              color: this.normalizeColor(dto.color),
            },
            select: labelSelect,
          });

          return this.serialize(label);
        } catch (error) {
          if (this.isPrismaError(error, 'P2002')) {
            throw new ConflictException('Label name already exists');
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
    query: ListLabelsDto = {},
  ) {
    await this.workspaceMembersService.requireMembership(workspaceId, userId);

    const limit = query.limit ?? 50;
    const cursor = query.cursor
      ? decodePaginationCursor(query.cursor)
      : undefined;
    const labels = await this.prisma.label.findMany({
      where: {
        workspaceId,
        ...(cursor ? cursorWhere(cursor) : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: labelSelect,
    });

    const hasNextPage = labels.length > limit;
    const items = (hasNextPage ? labels.slice(0, limit) : labels).map((label) =>
      this.serialize(label),
    );

    return {
      items,
      nextCursor: hasNextPage
        ? encodePaginationCursor(items[items.length - 1])
        : null,
    };
  }

  async update(
    workspaceId: string,
    labelId: string,
    userId: string,
    dto: UpdateLabelDto,
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

        await this.lockWorkspaceLabelNames(transaction, workspaceId);

        const label = await transaction.label.findFirst({
          where: { workspaceId, id: labelId },
          select: labelSelect,
        });

        if (!label) {
          throw new NotFoundException('Label not found');
        }

        if (dto.name === undefined && dto.color === undefined) {
          throw new BadRequestException('At least one label field is required');
        }

        const name =
          dto.name === undefined ? label.name : this.normalizeName(dto.name);
        const color =
          dto.color === undefined
            ? label.color
            : this.normalizeColor(dto.color);

        if (dto.name !== undefined) {
          await this.assertWorkspaceLabelCountWithinCompatibilityScan(
            transaction,
            workspaceId,
          );
          await this.assertNameAvailableWithLegacyCompatibility(
            transaction,
            workspaceId,
            name,
            labelId,
          );
        }

        try {
          const updated = await transaction.label.update({
            where: { workspaceId_id: { workspaceId, id: labelId } },
            data: {
              name,
              nameKey: normalizeLabelNameKey(name),
              color,
            },
            select: labelSelect,
          });

          return this.serialize(updated);
        } catch (error) {
          if (this.isPrismaError(error, 'P2002')) {
            throw new ConflictException('Label name already exists');
          }
          if (this.isPrismaError(error, 'P2025')) {
            throw new NotFoundException('Label not found');
          }
          throw error;
        }
      },
      this.transactionMaxAttempts,
    );
  }

  async remove(
    workspaceId: string,
    labelId: string,
    userId: string,
  ): Promise<void> {
    await runSerializableTransaction(
      this.prisma,
      async (transaction) => {
        await this.workspaceMembersService.requireRole(
          workspaceId,
          userId,
          managerRoles,
          transaction.workspaceMember,
        );

        const label = await transaction.label.findFirst({
          where: { workspaceId, id: labelId },
          select: { id: true, name: true, color: true },
        });

        if (!label) {
          throw new NotFoundException('Label not found');
        }

        const taskLabels = await transaction.taskLabel.findMany({
          where: { workspaceId, labelId },
          select: { taskId: true },
        });

        if (taskLabels.length > 0) {
          await this.activityWriter.writeMany(
            transaction,
            taskLabels.map(({ taskId }) => ({
              workspaceId,
              taskId,
              actorId: userId,
              type: 'LABEL_REMOVED' as const,
              payload: {
                schemaVersion: 1 as const,
                entity: 'label' as const,
                snapshot: {
                  labelId: label.id,
                  name: label.name,
                  color: label.color,
                },
              },
            })),
          );
        }

        try {
          await transaction.label.delete({
            where: { workspaceId_id: { workspaceId, id: labelId } },
          });
        } catch (error) {
          if (this.isPrismaError(error, 'P2025')) {
            throw new NotFoundException('Label not found');
          }
          throw error;
        }
      },
      this.transactionMaxAttempts,
    );
  }

  private async findTaskForLabelMutation(
    transaction: Prisma.TransactionClient,
    workspaceId: string,
    projectId: string,
    taskId: string,
  ) {
    const task = await transaction.task.findFirst({
      where: { workspaceId, projectId, id: taskId },
      select: {
        id: true,
        creatorId: true,
        archivedAt: true,
        project: { select: { archivedAt: true } },
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

    return task;
  }

  private assertTaskLabelAccess(
    membership: { role: WorkspaceRole },
    task: { creatorId: string; assigneeMember: { userId: string } | null },
    userId: string,
  ) {
    const isManager = managerRoles.some((role) => role === membership.role);
    const ownsTask =
      task.creatorId === userId || task.assigneeMember?.userId === userId;

    if (!isManager && !ownsTask) {
      throw new ForbiddenException('Insufficient permissions');
    }
  }

  async addToTask(
    workspaceId: string,
    projectId: string,
    taskId: string,
    labelId: string,
    userId: string,
  ): Promise<void> {
    try {
      await runSerializableTransaction(
        this.prisma,
        async (transaction) => {
          const membership =
            await this.workspaceMembersService.requireMembership(
              workspaceId,
              userId,
              transaction.workspaceMember,
            );
          const task = await this.findTaskForLabelMutation(
            transaction,
            workspaceId,
            projectId,
            taskId,
          );
          this.assertTaskLabelAccess(membership, task, userId);

          const label = await transaction.label.findFirst({
            where: { workspaceId, id: labelId },
            select: { id: true, name: true, color: true },
          });

          if (!label) {
            throw new NotFoundException('Label not found');
          }

          const relation = await transaction.taskLabel.findUnique({
            where: {
              workspaceId_taskId_labelId: { workspaceId, taskId, labelId },
            },
            select: { taskId: true },
          });

          if (relation) {
            return;
          }

          await transaction.taskLabel.create({
            data: { workspaceId, taskId, labelId },
          });

          await this.activityWriter.write(transaction, {
            workspaceId,
            taskId,
            actorId: userId,
            type: 'LABEL_ADDED',
            payload: {
              schemaVersion: 1,
              entity: 'label',
              snapshot: {
                labelId: label.id,
                name: label.name,
                color: label.color,
              },
            },
          });
        },
        this.transactionMaxAttempts,
      );
    } catch (error) {
      if (this.isPrismaError(error, 'P2002')) {
        return;
      }
      if (this.isPrismaError(error, 'P2003')) {
        throw new NotFoundException('Task or label not found');
      }
      throw error;
    }
  }

  async removeFromTask(
    workspaceId: string,
    projectId: string,
    taskId: string,
    labelId: string,
    userId: string,
  ): Promise<void> {
    await runSerializableTransaction(
      this.prisma,
      async (transaction) => {
        const membership = await this.workspaceMembersService.requireMembership(
          workspaceId,
          userId,
          transaction.workspaceMember,
        );
        const task = await this.findTaskForLabelMutation(
          transaction,
          workspaceId,
          projectId,
          taskId,
        );
        this.assertTaskLabelAccess(membership, task, userId);

        const label = await transaction.label.findFirst({
          where: { workspaceId, id: labelId },
          select: { id: true, name: true, color: true },
        });

        if (!label) {
          throw new NotFoundException('Label not found');
        }

        const removed = await transaction.taskLabel.deleteMany({
          where: { workspaceId, taskId, labelId },
        });

        if (removed?.count > 0) {
          await this.activityWriter.write(transaction, {
            workspaceId,
            taskId,
            actorId: userId,
            type: 'LABEL_REMOVED',
            payload: {
              schemaVersion: 1,
              entity: 'label',
              snapshot: {
                labelId: label.id,
                name: label.name,
                color: label.color,
              },
            },
          });
        }
      },
      this.transactionMaxAttempts,
    );
  }
}
