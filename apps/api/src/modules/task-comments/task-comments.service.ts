import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  cursorWhere,
  decodePaginationCursor,
  encodePaginationCursor,
} from '../../common/pagination';
import { runSerializableTransaction } from '../../database/serializable-transaction';
import { PrismaService } from '../../database/prisma.service';
import type { EnvConfig } from '../../config/env.schema';
import { Prisma, WorkspaceRole } from '../../generated/prisma/client';
import { ActivityWriterService } from '../task-activity/task-activity.writer';
import type { AuthUser } from '../auth/types/auth.types';
import { WorkspaceMembersService } from '../workspaces/workspace-members.service';

import { CreateTaskCommentDto } from './dto/create-task-comment.dto';
import { ListTaskCommentsDto } from './dto/list-task-comments.dto';
import { UpdateTaskCommentDto } from './dto/update-task-comment.dto';

const commentSelect = {
  id: true,
  workspaceId: true,
  taskId: true,
  authorId: true,
  authorDisplayName: true,
  content: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.TaskCommentSelect;

type SelectedComment = Prisma.TaskCommentGetPayload<{
  select: typeof commentSelect;
}>;

@Injectable()
export class TaskCommentsService {
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

  private getAuthorDisplayName(user: AuthUser): string {
    return user.name?.trim() || 'Workspace member';
  }

  private serializeComment(comment: SelectedComment) {
    return {
      id: comment.id,
      workspaceId: comment.workspaceId,
      taskId: comment.taskId,
      author: {
        id: comment.authorId,
        displayName: comment.authorDisplayName,
      },
      content: comment.deletedAt ? null : comment.content,
      deletedAt: comment.deletedAt,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    };
  }

  private async findTask(
    workspaceId: string,
    projectId: string,
    taskId: string,
    client: PrismaService | Prisma.TransactionClient,
  ) {
    const task = await client.task.findFirst({
      where: {
        id: taskId,
        projectId,
        workspaceId,
      },
      select: {
        id: true,
        archivedAt: true,
      },
    });

    if (!task) {
      throw new NotFoundException('Task not found');
    }

    return task;
  }

  async create(
    workspaceId: string,
    projectId: string,
    taskId: string,
    user: AuthUser,
    dto: CreateTaskCommentDto,
  ) {
    return runSerializableTransaction(
      this.prisma,
      async (transaction) => {
        await this.workspaceMembersService.requireMembership(
          workspaceId,
          user.id,
          transaction.workspaceMember,
        );

        const task = await this.findTask(
          workspaceId,
          projectId,
          taskId,
          transaction,
        );

        if (task.archivedAt) {
          throw new ConflictException('Task is archived');
        }

        const comment = await transaction.taskComment.create({
          data: {
            workspaceId,
            taskId,
            authorId: user.id,
            authorDisplayName: this.getAuthorDisplayName(user),
            content: dto.content.trim(),
          },
          select: commentSelect,
        });

        await this.activityWriter.write(transaction, {
          workspaceId,
          taskId,
          actorId: user.id,
          type: 'COMMENT_CREATED',
          payload: {
            schemaVersion: 1,
            entity: 'comment',
            snapshot: {
              commentId: comment.id,
              contentLength: dto.content.trim().length,
            },
          },
        });

        return this.serializeComment(comment);
      },
      this.transactionMaxAttempts,
    );
  }

  async findAll(
    workspaceId: string,
    projectId: string,
    taskId: string,
    userId: string,
    query: ListTaskCommentsDto = {},
  ) {
    await this.workspaceMembersService.requireMembership(workspaceId, userId);
    await this.findTask(workspaceId, projectId, taskId, this.prisma);

    const limit = query.limit ?? 50;
    const cursor = query.cursor
      ? decodePaginationCursor(query.cursor)
      : undefined;
    const comments = await this.prisma.taskComment.findMany({
      where: {
        workspaceId,
        taskId,
        ...(cursor ? cursorWhere(cursor) : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: commentSelect,
    });

    const hasNextPage = comments.length > limit;
    const items = (hasNextPage ? comments.slice(0, limit) : comments).map(
      (comment) => this.serializeComment(comment),
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
    projectId: string,
    taskId: string,
    commentId: string,
    userId: string,
    dto: UpdateTaskCommentDto,
  ) {
    return runSerializableTransaction(
      this.prisma,
      async (transaction) => {
        await this.workspaceMembersService.requireMembership(
          workspaceId,
          userId,
          transaction.workspaceMember,
        );

        const task = await this.findTask(
          workspaceId,
          projectId,
          taskId,
          transaction,
        );

        if (task.archivedAt) {
          throw new ConflictException('Task is archived');
        }

        const comment = await transaction.taskComment.findFirst({
          where: {
            id: commentId,
            taskId,
            workspaceId,
          },
          select: commentSelect,
        });

        if (!comment) {
          throw new NotFoundException('Comment not found');
        }

        if (comment.deletedAt) {
          throw new ConflictException('Comment is deleted');
        }

        if (comment.authorId !== userId) {
          throw new ForbiddenException('Only the author can edit a comment');
        }

        const content = dto.content.trim();
        if (comment.content === content) {
          return this.serializeComment(comment);
        }

        const updated = await transaction.taskComment.update({
          where: {
            workspaceId_id: {
              workspaceId,
              id: commentId,
            },
          },
          data: { content },
          select: commentSelect,
        });

        await this.activityWriter.write(transaction, {
          workspaceId,
          taskId,
          actorId: userId,
          type: 'COMMENT_UPDATED',
          payload: {
            schemaVersion: 1,
            entity: 'comment',
            snapshot: { commentId },
            changes: {
              contentLength: {
                from: comment.content?.length ?? 0,
                to: content.length,
              },
            },
          },
        });

        return this.serializeComment(updated);
      },
      this.transactionMaxAttempts,
    );
  }

  async remove(
    workspaceId: string,
    projectId: string,
    taskId: string,
    commentId: string,
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
        const task = await this.findTask(
          workspaceId,
          projectId,
          taskId,
          transaction,
        );
        const comment = await transaction.taskComment.findFirst({
          where: {
            id: commentId,
            taskId,
            workspaceId,
          },
          select: {
            authorId: true,
            deletedAt: true,
            content: true,
          },
        });

        if (!comment) {
          throw new NotFoundException('Comment not found');
        }

        const isManager =
          membership.role === WorkspaceRole.OWNER ||
          membership.role === WorkspaceRole.ADMIN;
        const isAuthor = comment.authorId === userId;
        if (!isAuthor && !isManager) {
          throw new ForbiddenException(
            'Only the author or a workspace manager can delete a comment',
          );
        }

        if (task.archivedAt && !isManager) {
          throw new ConflictException('Task is archived');
        }

        if (comment.deletedAt) {
          return;
        }

        await transaction.taskComment.update({
          where: {
            workspaceId_id: {
              workspaceId,
              id: commentId,
            },
          },
          data: {
            content: null,
            deletedAt: new Date(),
            deletedById: userId,
          },
        });

        await this.activityWriter.write(transaction, {
          workspaceId,
          taskId,
          actorId: userId,
          type: 'COMMENT_DELETED',
          payload: {
            schemaVersion: 1,
            entity: 'comment',
            snapshot: {
              commentId,
              contentLength: comment.content?.length ?? 0,
              deleted: true,
            },
          },
        });
      },
      this.transactionMaxAttempts,
    );
  }
}
