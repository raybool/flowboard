import { ActivityWriterService } from './task-activity.writer';

describe('ActivityWriterService', () => {
  it('writes a server-generated event through the supplied transaction client', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'activity-id' });
    const findUnique = vi.fn().mockResolvedValue({ name: ' Ada ' });
    const transaction = {
      user: { findUnique },
      taskActivity: { create },
    } as never;
    const writer = new ActivityWriterService();

    await writer.write(transaction, {
      workspaceId: 'workspace-id',
      taskId: 'task-id',
      actorId: 'actor-id',
      type: 'COMMENT_CREATED',
      payload: {
        schemaVersion: 1,
        entity: 'comment',
        snapshot: { commentId: 'comment-id', contentLength: 4 },
      },
    });

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'actor-id' },
      select: { name: true },
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 'workspace-id',
        taskId: 'task-id',
        actorId: 'actor-id',
        actorDisplayName: 'Ada',
        type: 'COMMENT_CREATED',
        eventVersion: 1,
        payload: {
          schemaVersion: 1,
          entity: 'comment',
          snapshot: { commentId: 'comment-id', contentLength: 4 },
        },
      }),
    });
  });

  it('propagates activity insert failures for transaction rollback', async () => {
    const error = new Error('activity write failed');
    const transaction = {
      user: { findUnique: vi.fn().mockResolvedValue({ name: null }) },
      taskActivity: { create: vi.fn().mockRejectedValue(error) },
    } as never;

    await expect(
      new ActivityWriterService().write(transaction, {
        workspaceId: 'workspace-id',
        taskId: 'task-id',
        actorId: 'actor-id',
        type: 'TASK_ARCHIVED',
        payload: {
          schemaVersion: 1,
          entity: 'task',
          snapshot: { taskId: 'task-id', taskNumber: 'FLOW-1' },
          changes: {
            archivedAt: { from: null, to: '2026-01-01T00:00:00.000Z' },
          },
        },
      }),
    ).rejects.toBe(error);
  });

  it('writes a batch with one actor lookup and one createMany call', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([{ id: 'actor-id', name: ' Ada ' }]);
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    const transaction = {
      user: { findMany },
      taskActivity: { createMany },
    } as never;
    const writer = new ActivityWriterService();

    const input = (taskId: string) => ({
      workspaceId: 'workspace-id',
      taskId,
      actorId: 'actor-id',
      type: 'LABEL_REMOVED' as const,
      payload: {
        schemaVersion: 1 as const,
        entity: 'label' as const,
        snapshot: { labelId: 'label-id', name: 'Bug', color: '#FF0000' },
      },
    });

    await writer.writeMany(transaction, [input('task-1'), input('task-2')]);

    expect(findMany).toHaveBeenCalledWith({
      where: { id: { in: ['actor-id'] } },
      select: { id: true, name: true },
    });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          taskId: 'task-1',
          actorDisplayName: 'Ada',
          type: 'LABEL_REMOVED',
        }),
        expect.objectContaining({
          taskId: 'task-2',
          actorDisplayName: 'Ada',
          type: 'LABEL_REMOVED',
        }),
      ],
    });
  });
});
