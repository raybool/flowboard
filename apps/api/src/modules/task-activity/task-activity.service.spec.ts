import { BadRequestException, NotFoundException } from '@nestjs/common';

import type { PrismaService } from '../../database/prisma.service';
import type { WorkspaceMembersService } from '../workspaces/workspace-members.service';

import { TaskActivityService } from './task-activity.service';

describe('TaskActivityService', () => {
  const requireMembership = vi.fn();
  const taskFindFirst = vi.fn();
  const activityFindMany = vi.fn();
  const service = new TaskActivityService(
    {
      task: { findFirst: taskFindFirst },
      taskActivity: { findMany: activityFindMany },
    } as unknown as PrismaService,
    { requireMembership } as unknown as WorkspaceMembersService,
  );

  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const projectId = '22222222-2222-4222-8222-222222222222';
  const taskId = '33333333-3333-4333-8333-333333333333';
  const userId = '44444444-4444-4444-8444-444444444444';
  const first = {
    id: '55555555-5555-4555-8555-555555555555',
    workspaceId,
    taskId,
    actorId: userId,
    actorDisplayName: 'Ada',
    type: 'TASK_CREATED',
    eventVersion: 1,
    payload: {
      schemaVersion: 1,
      entity: 'task',
      snapshot: { taskId, taskNumber: 'FLOW-1' },
    },
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    requireMembership.mockResolvedValue({ userId });
    taskFindFirst.mockResolvedValue({ id: taskId });
    activityFindMany.mockResolvedValue([first]);
  });

  it('reads archived-task history with stable cursor ordering and explicit select', async () => {
    await expect(
      service.findAll(workspaceId, projectId, taskId, userId, { limit: 1 }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({ id: first.id, payload: first.payload }),
      ],
      nextCursor: null,
    });
    expect(taskFindFirst).toHaveBeenCalledWith({
      where: { workspaceId, projectId, id: taskId },
      select: { id: true },
    });
    expect(activityFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId, taskId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 2,
        select: expect.any(Object),
      }),
    );
  });

  it('hides cross-scope tasks and rejects malformed cursors', async () => {
    taskFindFirst.mockResolvedValueOnce(null);
    await expect(
      service.findAll(workspaceId, projectId, taskId, userId),
    ).rejects.toBeInstanceOf(NotFoundException);

    taskFindFirst.mockResolvedValue({ id: taskId });
    await expect(
      service.findAll(workspaceId, projectId, taskId, userId, {
        cursor: 'invalid',
      }),
    ).rejects.toEqual(new BadRequestException('Invalid cursor'));
    expect(activityFindMany).not.toHaveBeenCalled();
  });
});
