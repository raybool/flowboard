import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import {
  Prisma,
  TaskPriority,
  TaskStatus,
  WorkspaceRole,
} from '../../generated/prisma/client';
import type { PrismaService } from '../../database/prisma.service';
import { WorkspaceMembersService } from '../workspaces/workspace-members.service';

import { TasksService } from './tasks.service';

describe('TasksService', () => {
  const requireMembership = vi.fn();
  const requireRole = vi.fn();
  const projectFindFirst = vi.fn();
  const projectUpdate = vi.fn();
  const taskCreate = vi.fn();
  const taskFindFirst = vi.fn();
  const taskFindMany = vi.fn();
  const labelFindMany = vi.fn();
  const taskUpdate = vi.fn();
  const assigneeFindUnique = vi.fn();
  const activityWrite = vi.fn();
  const transaction = vi.fn();
  const transactionClient = {
    workspaceMember: { findUnique: assigneeFindUnique },
    project: { findFirst: projectFindFirst, update: projectUpdate },
    task: { create: taskCreate, findFirst: taskFindFirst, update: taskUpdate },
  };
  const service = new TasksService(
    {
      project: { findFirst: projectFindFirst },
      label: { findMany: labelFindMany },
      task: { findMany: taskFindMany, findFirst: taskFindFirst },
      $transaction: transaction,
    } as unknown as PrismaService,
    { requireMembership, requireRole } as unknown as WorkspaceMembersService,
    { write: activityWrite } as never,
  );

  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const projectId = '22222222-2222-4222-8222-222222222222';
  const taskId = '33333333-3333-4333-8333-333333333333';
  const userId = '44444444-4444-4444-8444-444444444444';
  const assigneeId = '55555555-5555-4555-8555-555555555555';
  const dto = { title: '  Release notes  ', priority: TaskPriority.HIGH };

  beforeEach(() => {
    vi.resetAllMocks();
    transaction.mockImplementation(async (callback) =>
      callback(transactionClient),
    );
    requireMembership.mockResolvedValue({
      id: 'member-id',
      userId,
      role: WorkspaceRole.MEMBER,
    });
    requireRole.mockResolvedValue({
      id: 'manager-member-id',
      userId,
      role: WorkspaceRole.OWNER,
    });
    projectFindFirst.mockResolvedValue({
      id: projectId,
      workspaceId,
      key: 'FLOW',
      archivedAt: null,
    });
    projectUpdate.mockResolvedValue({
      id: projectId,
      workspaceId,
      key: 'FLOW',
      nextTaskSequence: 2,
    });
    taskCreate.mockResolvedValue({
      id: taskId,
      workspaceId,
      projectId,
      sequence: 1,
      title: 'Release notes',
      status: 'BACKLOG',
      priority: TaskPriority.HIGH,
      creatorId: userId,
      assigneeMemberId: null,
      archivedAt: null,
    });
    labelFindMany.mockResolvedValue([]);
  });

  it('writes task creation and status activity in the business transaction', async () => {
    await service.create(workspaceId, projectId, userId, dto);

    expect(activityWrite).toHaveBeenCalledWith(
      transactionClient,
      expect.objectContaining({
        workspaceId,
        taskId,
        actorId: userId,
        type: 'TASK_CREATED',
        payload: expect.objectContaining({
          schemaVersion: 1,
          entity: 'task',
        }),
      }),
    );

    activityWrite.mockClear();
    taskFindFirst.mockResolvedValue({
      id: taskId,
      sequence: 1,
      status: TaskStatus.TODO,
      creatorId: userId,
      archivedAt: null,
      assigneeMember: null,
      project: { key: 'FLOW', archivedAt: null },
    });
    taskUpdate.mockResolvedValue({ id: taskId, sequence: 1 });

    await service.updateStatus(workspaceId, projectId, taskId, userId, {
      status: TaskStatus.DONE,
    });

    expect(activityWrite).toHaveBeenCalledWith(
      transactionClient,
      expect.objectContaining({
        type: 'TASK_STATUS_CHANGED',
        payload: expect.objectContaining({
          changes: { status: { from: TaskStatus.TODO, to: TaskStatus.DONE } },
        }),
      }),
    );
  });

  it('does not write activity for a no-op task update', async () => {
    taskFindFirst.mockResolvedValue({
      id: taskId,
      sequence: 1,
      title: 'Same title',
      description: null,
      priority: TaskPriority.NONE,
      creatorId: userId,
      archivedAt: null,
      assigneeMember: null,
      project: { key: 'FLOW', archivedAt: null },
    });
    taskUpdate.mockResolvedValue({ id: taskId, sequence: 1 });

    await service.update(workspaceId, projectId, taskId, userId, {
      title: 'Same title',
    });

    expect(activityWrite).not.toHaveBeenCalled();
  });

  it('records description changes without copying description content', async () => {
    const previousDescription = 'previous task description secret';
    const nextDescription = 'next task description secret';
    taskFindFirst.mockResolvedValue({
      id: taskId,
      sequence: 1,
      title: 'Same title',
      description: previousDescription,
      priority: TaskPriority.NONE,
      creatorId: userId,
      archivedAt: null,
      assigneeMember: null,
      project: { key: 'FLOW', archivedAt: null },
    });
    taskUpdate.mockResolvedValue({
      id: taskId,
      sequence: 1,
      description: nextDescription,
    });

    await service.update(workspaceId, projectId, taskId, userId, {
      description: nextDescription,
    });

    expect(activityWrite).toHaveBeenCalledWith(
      transactionClient,
      expect.objectContaining({
        type: 'TASK_UPDATED',
        payload: expect.objectContaining({
          changes: { descriptionChanged: true },
        }),
      }),
    );
    const payload = activityWrite.mock.calls[0][1].payload;
    expect(JSON.stringify(payload)).not.toContain(previousDescription);
    expect(JSON.stringify(payload)).not.toContain(nextDescription);
    expect(payload).not.toHaveProperty('changes.description');
  });

  it.each([WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.MEMBER])(
    'allows %s to create a task',
    async (role) => {
      requireMembership.mockResolvedValue({ role });

      await expect(
        service.create(workspaceId, projectId, userId, dto),
      ).resolves.toMatchObject({ taskNumber: 'FLOW-1' });

      expect(projectUpdate).toHaveBeenCalledWith({
        where: { workspaceId_id: { workspaceId, id: projectId } },
        data: { nextTaskSequence: { increment: 1 } },
      });
      expect(taskCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          sequence: 1,
          title: 'Release notes',
          creatorId: userId,
          priority: TaskPriority.HIGH,
        }),
      });
    },
  );

  it('allocates the next sequence atomically for each transaction', async () => {
    projectUpdate
      .mockResolvedValueOnce({ key: 'FLOW', nextTaskSequence: 2 })
      .mockResolvedValueOnce({ key: 'FLOW', nextTaskSequence: 3 });

    await service.create(workspaceId, projectId, userId, dto);
    await service.create(workspaceId, projectId, userId, dto);

    expect(taskCreate.mock.calls.map(([call]) => call.data.sequence)).toEqual([
      1, 2,
    ]);
  });

  it('rejects archived projects and cross-workspace assignees', async () => {
    projectFindFirst.mockResolvedValueOnce({
      id: projectId,
      workspaceId,
      key: 'FLOW',
      archivedAt: new Date(),
    });
    await expect(
      service.create(workspaceId, projectId, userId, dto),
    ).rejects.toBeInstanceOf(ConflictException);

    projectFindFirst.mockResolvedValue({
      id: projectId,
      workspaceId,
      key: 'FLOW',
      archivedAt: null,
    });
    assigneeFindUnique.mockResolvedValue(null);
    await expect(
      service.create(workspaceId, projectId, userId, {
        ...dto,
        assigneeId,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(taskCreate).not.toHaveBeenCalled();
  });

  it('returns 404 for a project or task outside the requested workspace/project', async () => {
    projectFindFirst.mockResolvedValue(null);
    await expect(
      service.findAll(workspaceId, projectId, userId),
    ).rejects.toBeInstanceOf(NotFoundException);

    projectFindFirst.mockResolvedValue({ key: 'FLOW' });
    taskFindFirst.mockResolvedValue(null);
    await expect(
      service.findOne(workspaceId, projectId, taskId, userId),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(taskFindFirst).toHaveBeenCalledWith({
      where: { id: taskId, workspaceId, projectId },
      include: { project: { select: { key: true } } },
    });
  });

  it('returns a stable, membership-scoped paginated task envelope', async () => {
    taskFindMany.mockResolvedValue([]);
    await expect(
      service.findAll(workspaceId, projectId, userId),
    ).resolves.toEqual({ items: [], nextCursor: null });

    expect(taskFindMany).toHaveBeenCalledWith({
      where: {
        workspaceId,
        projectId,
        archivedAt: null,
        workspace: { members: { some: { userId } } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 51,
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

    requireMembership.mockRejectedValueOnce(new NotFoundException());
    await expect(
      service.findAll(workspaceId, projectId, userId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('applies task filters and returns a cursor after the requested page size', async () => {
    const first = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      workspaceId,
      projectId,
      sequence: 1,
      title: 'First',
      description: null,
      status: TaskStatus.DONE,
      priority: TaskPriority.HIGH,
      creatorId: userId,
      assigneeMemberId: 'member-id',
      archivedAt: null,
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      project: { key: 'FLOW' },
    };
    const second = {
      ...first,
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      sequence: 2,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    taskFindMany.mockResolvedValue([first, second]);

    const page = await service.findAll(workspaceId, projectId, userId, {
      status: TaskStatus.DONE,
      priority: TaskPriority.HIGH,
      assigneeId,
      includeArchived: true,
      limit: 1,
    });

    expect(page.items).toEqual([
      expect.objectContaining({ id: first.id, taskNumber: 'FLOW-1' }),
    ]);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(taskFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId,
          projectId,
          status: TaskStatus.DONE,
          priority: TaskPriority.HIGH,
          assigneeMember: { userId: assigneeId },
          workspace: { members: { some: { userId } } },
        },
        take: 2,
      }),
    );
  });

  it('rejects an invalid task cursor before querying Prisma', async () => {
    await expect(
      service.findAll(workspaceId, projectId, userId, {
        cursor: 'not-a-cursor',
      }),
    ).rejects.toEqual(new BadRequestException('Invalid cursor'));
    expect(taskFindMany).not.toHaveBeenCalled();
  });

  it('filters tasks by every requested workspace label without changing pagination', async () => {
    const firstLabelId = '66666666-6666-4666-8666-666666666666';
    const secondLabelId = '77777777-7777-4777-8777-777777777777';
    labelFindMany.mockResolvedValue([
      { id: firstLabelId },
      { id: secondLabelId },
    ]);
    taskFindMany.mockResolvedValue([]);

    await expect(
      service.findAll(workspaceId, projectId, userId, {
        labelIds: [firstLabelId, secondLabelId],
        limit: 10,
      }),
    ).resolves.toEqual({ items: [], nextCursor: null });

    expect(labelFindMany).toHaveBeenCalledWith({
      where: {
        workspaceId,
        id: { in: [firstLabelId, secondLabelId] },
      },
      select: { id: true },
    });
    expect(taskFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [
            { labels: { some: { workspaceId, labelId: firstLabelId } } },
            { labels: { some: { workspaceId, labelId: secondLabelId } } },
          ],
        }),
        take: 11,
      }),
    );
  });

  it('enforces member ownership or assignment and preserves protected fields', async () => {
    taskFindFirst.mockResolvedValue({
      id: taskId,
      projectId,
      workspaceId,
      creatorId: 'someone-else',
      archivedAt: null,
      assigneeMember: { userId: 'another-user' },
      project: { key: 'FLOW' },
    });
    await expect(
      service.update(workspaceId, projectId, taskId, userId, {
        title: 'Changed',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(taskUpdate).not.toHaveBeenCalled();

    taskFindFirst.mockResolvedValue({
      id: taskId,
      projectId,
      workspaceId,
      creatorId: userId,
      archivedAt: null,
      assigneeMember: null,
      project: { key: 'FLOW' },
    });
    taskUpdate.mockResolvedValue({ id: taskId, sequence: 1, title: 'Changed' });
    await service.update(workspaceId, projectId, taskId, userId, {
      title: 'Changed',
      priority: TaskPriority.URGENT,
    });
    expect(taskUpdate).toHaveBeenCalledWith({
      where: { id: taskId },
      data: { title: 'Changed', priority: TaskPriority.URGENT },
    });
  });

  it('allows the assigned member and managers to update any active task', async () => {
    taskFindFirst.mockResolvedValue({
      id: taskId,
      projectId,
      workspaceId,
      creatorId: 'creator',
      archivedAt: null,
      assigneeMember: { userId },
      project: { key: 'FLOW' },
    });
    taskUpdate.mockResolvedValue({ id: taskId, sequence: 1 });
    await expect(
      service.update(workspaceId, projectId, taskId, userId, {}),
    ).resolves.toMatchObject({ taskNumber: 'FLOW-1' });

    for (const role of [WorkspaceRole.OWNER, WorkspaceRole.ADMIN]) {
      requireMembership.mockResolvedValue({ role });
      taskFindFirst.mockResolvedValue({
        id: taskId,
        projectId,
        workspaceId,
        creatorId: 'creator',
        archivedAt: null,
        assigneeMember: null,
        project: { key: 'FLOW' },
      });
      await expect(
        service.update(workspaceId, projectId, taskId, userId, {
          description: null,
        }),
      ).resolves.toBeDefined();
    }
  });

  it('rejects archived tasks, rolls back failed creates, and preserves unknown errors', async () => {
    taskFindFirst.mockResolvedValue({
      id: taskId,
      projectId,
      workspaceId,
      creatorId: userId,
      archivedAt: new Date(),
      assigneeMember: null,
      project: { key: 'FLOW' },
    });
    await expect(
      service.update(workspaceId, projectId, taskId, userId, { title: 'Nope' }),
    ).rejects.toBeInstanceOf(ConflictException);

    const infrastructureError = new Error('database unavailable');
    taskCreate.mockRejectedValue(infrastructureError);
    await expect(
      service.create(workspaceId, projectId, userId, dto),
    ).rejects.toBe(infrastructureError);
  });

  it('retries P2034 and reports exhaustion as service unavailable', async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError('conflict', {
      code: 'P2034',
      clientVersion: 'test',
    });
    transaction
      .mockRejectedValueOnce(conflict)
      .mockImplementationOnce(async (callback) => callback(transactionClient));

    await expect(
      service.create(workspaceId, projectId, userId, dto),
    ).resolves.toBeDefined();
    expect(transaction).toHaveBeenCalledTimes(2);

    transaction.mockRejectedValue(conflict);
    await expect(
      service.create(workspaceId, projectId, userId, dto),
    ).rejects.toMatchObject({
      status: 503,
    });
    expect(transaction).toHaveBeenCalledTimes(5);
  });

  it('allows task creators and managers to change status, but blocks other members', async () => {
    taskFindFirst.mockResolvedValue({
      id: taskId,
      projectId,
      workspaceId,
      creatorId: userId,
      archivedAt: null,
      assigneeMember: null,
      project: { key: 'FLOW', archivedAt: null },
    });
    taskUpdate.mockResolvedValue({
      id: taskId,
      sequence: 1,
      status: TaskStatus.DONE,
    });

    await expect(
      service.updateStatus(workspaceId, projectId, taskId, userId, {
        status: TaskStatus.DONE,
      }),
    ).resolves.toMatchObject({ taskNumber: 'FLOW-1' });
    expect(taskUpdate).toHaveBeenCalledWith({
      where: { id: taskId },
      data: { status: TaskStatus.DONE },
    });

    requireMembership.mockResolvedValue({
      id: 'member-id',
      userId,
      role: WorkspaceRole.MEMBER,
    });
    taskFindFirst.mockResolvedValue({
      id: taskId,
      creatorId: 'someone-else',
      archivedAt: null,
      assigneeMember: null,
      project: { key: 'FLOW', archivedAt: null },
    });
    await expect(
      service.updateStatus(workspaceId, projectId, taskId, userId, {
        status: TaskStatus.DONE,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects status changes for archived tasks and projects', async () => {
    taskFindFirst.mockResolvedValue({
      id: taskId,
      creatorId: userId,
      archivedAt: new Date(),
      assigneeMember: null,
      project: { key: 'FLOW', archivedAt: null },
    });
    await expect(
      service.updateStatus(workspaceId, projectId, taskId, userId, {
        status: TaskStatus.DONE,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    taskFindFirst.mockResolvedValue({
      id: taskId,
      creatorId: userId,
      archivedAt: null,
      assigneeMember: null,
      project: { key: 'FLOW', archivedAt: new Date() },
    });
    await expect(
      service.updateStatus(workspaceId, projectId, taskId, userId, {
        status: TaskStatus.DONE,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('supports manager assignment and member self-assignment/removal policy', async () => {
    requireMembership.mockResolvedValue({
      id: 'manager-member-id',
      userId,
      role: WorkspaceRole.OWNER,
    });
    assigneeFindUnique.mockResolvedValue({
      id: 'assignee-member-id',
      userId: assigneeId,
    });
    taskFindFirst.mockResolvedValue({
      id: taskId,
      creatorId: 'creator',
      archivedAt: null,
      assigneeMember: null,
      project: { key: 'FLOW', archivedAt: null },
    });
    taskUpdate.mockResolvedValue({ id: taskId, sequence: 1 });

    await service.assign(workspaceId, projectId, taskId, userId, {
      assigneeId,
    });
    expect(assigneeFindUnique).toHaveBeenCalledWith({
      where: { workspaceId_userId: { workspaceId, userId: assigneeId } },
    });
    expect(taskUpdate).toHaveBeenCalledWith({
      where: { id: taskId },
      data: { assigneeMemberId: 'assignee-member-id' },
    });

    requireMembership.mockResolvedValue({
      id: 'member-id',
      userId,
      role: WorkspaceRole.MEMBER,
    });
    taskFindFirst.mockResolvedValue({
      id: taskId,
      creatorId: 'creator',
      archivedAt: null,
      assigneeMember: { userId },
      project: { key: 'FLOW', archivedAt: null },
    });
    await service.assign(workspaceId, projectId, taskId, userId, {
      assigneeId: null,
    });
    expect(taskUpdate).toHaveBeenLastCalledWith({
      where: { id: taskId },
      data: { assigneeMemberId: null },
    });

    await expect(
      service.assign(workspaceId, projectId, taskId, userId, {
        assigneeId,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('archives tasks only for managers and rejects repeated archiving', async () => {
    requireRole.mockResolvedValue({ role: WorkspaceRole.ADMIN });
    taskFindFirst.mockResolvedValue({
      id: taskId,
      archivedAt: null,
      project: { key: 'FLOW' },
    });
    taskUpdate.mockResolvedValue({
      id: taskId,
      sequence: 1,
      archivedAt: new Date(),
    });

    await expect(
      service.archive(workspaceId, projectId, taskId, userId),
    ).resolves.toMatchObject({ taskNumber: 'FLOW-1' });

    taskFindFirst.mockResolvedValue({
      id: taskId,
      archivedAt: new Date(),
      project: { key: 'FLOW' },
    });
    await expect(
      service.archive(workspaceId, projectId, taskId, userId),
    ).rejects.toBeInstanceOf(ConflictException);

    requireRole.mockRejectedValue(new ForbiddenException());
    await expect(
      service.archive(workspaceId, projectId, taskId, userId),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
