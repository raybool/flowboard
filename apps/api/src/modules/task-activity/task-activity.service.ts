import { Injectable, NotFoundException } from '@nestjs/common';

import {
  cursorWhere,
  decodePaginationCursor,
  encodePaginationCursor,
} from '../../common/pagination';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { WorkspaceMembersService } from '../workspaces/workspace-members.service';

import { ListTaskActivityDto } from './dto/list-task-activity.dto';

const activitySelect = {
  id: true,
  workspaceId: true,
  taskId: true,
  actorId: true,
  actorDisplayName: true,
  type: true,
  eventVersion: true,
  payload: true,
  createdAt: true,
} satisfies Prisma.TaskActivitySelect;

type SelectedActivity = Prisma.TaskActivityGetPayload<{
  select: typeof activitySelect;
}>;

@Injectable()
export class TaskActivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceMembersService: WorkspaceMembersService,
  ) {}

  private serialize(activity: SelectedActivity) {
    return {
      id: activity.id,
      workspaceId: activity.workspaceId,
      taskId: activity.taskId,
      actorId: activity.actorId,
      actorDisplayName: activity.actorDisplayName,
      type: activity.type,
      eventVersion: activity.eventVersion,
      payload: activity.payload,
      createdAt: activity.createdAt,
    };
  }

  async findAll(
    workspaceId: string,
    projectId: string,
    taskId: string,
    userId: string,
    query: ListTaskActivityDto = {},
  ) {
    await this.workspaceMembersService.requireMembership(workspaceId, userId);

    const task = await this.prisma.task.findFirst({
      where: { workspaceId, projectId, id: taskId },
      select: { id: true },
    });

    if (!task) {
      throw new NotFoundException('Task not found');
    }

    const limit = query.limit ?? 50;
    const cursor = query.cursor
      ? decodePaginationCursor(query.cursor)
      : undefined;
    const activities = await this.prisma.taskActivity.findMany({
      where: {
        workspaceId,
        taskId,
        ...(cursor ? cursorWhere(cursor) : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: activitySelect,
    });

    const hasNextPage = activities.length > limit;
    const items = (hasNextPage ? activities.slice(0, limit) : activities).map(
      (activity) => this.serialize(activity),
    );

    return {
      items,
      nextCursor: hasNextPage
        ? encodePaginationCursor(items[items.length - 1])
        : null,
    };
  }
}
