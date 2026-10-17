import { Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client';
import type { TaskPriority, TaskStatus } from '../../generated/prisma/client';

export type AssigneeActivitySnapshot = {
  memberId: string;
  userId: string;
  displayName: string;
};

type Change<T> = { from: T; to: T };

type ActivityEnvelope<Entity extends string, Snapshot> = {
  schemaVersion: 1;
  entity: Entity;
  snapshot: Snapshot;
};

export type TaskCreatedPayload = ActivityEnvelope<
  'task',
  {
    taskId: string;
    taskNumber: string;
    title: string;
    status: TaskStatus;
    priority: TaskPriority;
    assignee: AssigneeActivitySnapshot | null;
  }
>;

export type TaskUpdatedPayload = ActivityEnvelope<
  'task',
  { taskId: string; taskNumber: string }
> & {
  changes: {
    title?: Change<string>;
    descriptionChanged?: true;
  };
};

export type TaskStatusChangedPayload = ActivityEnvelope<
  'task',
  { taskId: string; taskNumber: string }
> & { changes: { status: Change<TaskStatus> } };

export type TaskPriorityChangedPayload = ActivityEnvelope<
  'task',
  { taskId: string; taskNumber: string }
> & { changes: { priority: Change<TaskPriority> } };

export type TaskAssigneeChangedPayload = ActivityEnvelope<
  'task',
  { taskId: string; taskNumber: string }
> & { changes: { assignee: Change<AssigneeActivitySnapshot | null> } };

export type TaskArchivedPayload = ActivityEnvelope<
  'task',
  { taskId: string; taskNumber: string }
> & { changes: { archivedAt: Change<string | null> } };

export type CommentActivityPayload = ActivityEnvelope<
  'comment',
  { commentId: string; contentLength: number }
>;

export type CommentUpdatedPayload = ActivityEnvelope<
  'comment',
  { commentId: string }
> & { changes: { contentLength: Change<number> } };

export type CommentDeletedPayload = ActivityEnvelope<
  'comment',
  { commentId: string; contentLength: number; deleted: true }
>;

export type LabelActivityPayload = ActivityEnvelope<
  'label',
  { labelId: string; name: string; color: string }
>;

export type ActivityEvent =
  | { type: 'TASK_CREATED'; payload: TaskCreatedPayload }
  | { type: 'TASK_UPDATED'; payload: TaskUpdatedPayload }
  | {
      type: 'TASK_STATUS_CHANGED';
      payload: TaskStatusChangedPayload;
    }
  | {
      type: 'TASK_PRIORITY_CHANGED';
      payload: TaskPriorityChangedPayload;
    }
  | {
      type: 'TASK_ASSIGNEE_CHANGED';
      payload: TaskAssigneeChangedPayload;
    }
  | { type: 'TASK_ARCHIVED'; payload: TaskArchivedPayload }
  | {
      type: 'COMMENT_CREATED';
      payload: CommentActivityPayload;
    }
  | {
      type: 'COMMENT_UPDATED';
      payload: CommentUpdatedPayload;
    }
  | {
      type: 'COMMENT_DELETED';
      payload: CommentDeletedPayload;
    }
  | { type: 'LABEL_ADDED'; payload: LabelActivityPayload }
  | { type: 'LABEL_REMOVED'; payload: LabelActivityPayload };

export type ActivityWriteInput = ActivityEvent & {
  workspaceId: string;
  taskId: string;
  actorId: string;
  correlationId?: string;
  requestId?: string;
};

@Injectable()
export class ActivityWriterService {
  private activityData(
    input: ActivityWriteInput,
    actorDisplayName: string,
  ): Prisma.TaskActivityCreateManyInput {
    return {
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      actorId: input.actorId,
      actorDisplayName,
      type: input.type,
      eventVersion: input.payload.schemaVersion,
      payload: input.payload as Prisma.InputJsonValue,
      correlationId: input.correlationId,
      requestId: input.requestId,
    };
  }

  async write(
    transaction: Prisma.TransactionClient,
    input: ActivityWriteInput,
  ) {
    const actor = await transaction.user.findUnique({
      where: { id: input.actorId },
      select: { name: true },
    });

    return transaction.taskActivity.create({
      data: this.activityData(input, actor?.name?.trim() || 'Workspace member'),
    });
  }

  async writeMany(
    transaction: Prisma.TransactionClient,
    inputs: ActivityWriteInput[],
  ) {
    if (inputs.length === 0) {
      return { count: 0 };
    }

    const actorIds = [...new Set(inputs.map((input) => input.actorId))];
    const actors = await transaction.user.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, name: true },
    });
    const actorNames = new Map(
      actors.map((actor) => [
        actor.id,
        actor.name?.trim() || 'Workspace member',
      ]),
    );

    return transaction.taskActivity.createMany({
      data: inputs.map((input) =>
        this.activityData(
          input,
          actorNames.get(input.actorId) || 'Workspace member',
        ),
      ),
    });
  }
}
