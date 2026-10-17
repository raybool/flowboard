import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import type { PrismaService } from '../../database/prisma.service';
import { Prisma, WorkspaceRole } from '../../generated/prisma/client';
import type { WorkspaceMembersService } from '../workspaces/workspace-members.service';

import { LabelsService } from './labels.service';

describe('LabelsService', () => {
  const requireMembership = vi.fn();
  const requireRole = vi.fn();
  const labelCreate = vi.fn();
  const labelFindFirst = vi.fn();
  const labelFindMany = vi.fn();
  const labelUpdate = vi.fn();
  const labelDelete = vi.fn();
  const taskFindFirst = vi.fn();
  const taskLabelFindMany = vi.fn();
  const taskLabelFindUnique = vi.fn();
  const taskLabelCreate = vi.fn();
  const taskLabelDeleteMany = vi.fn();
  const queryRaw = vi.fn();
  const activityWrite = vi.fn();
  const activityWriteMany = vi.fn();
  const transaction = vi.fn();
  const transactionClient = {
    workspaceMember: { findUnique: vi.fn() },
    label: {
      create: labelCreate,
      findFirst: labelFindFirst,
      findMany: labelFindMany,
      update: labelUpdate,
      delete: labelDelete,
    },
    $queryRaw: queryRaw,
    task: { findFirst: taskFindFirst },
    taskLabel: {
      findMany: taskLabelFindMany,
      findUnique: taskLabelFindUnique,
      create: taskLabelCreate,
      deleteMany: taskLabelDeleteMany,
    },
  };
  const prisma = {
    label: { findMany: labelFindMany },
    $transaction: transaction,
  } as unknown as PrismaService;
  const service = new LabelsService(
    prisma,
    {
      requireMembership,
      requireRole,
    } as unknown as WorkspaceMembersService,
    {
      write: activityWrite,
      writeMany: activityWriteMany,
    } as never,
  );

  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const projectId = '22222222-2222-4222-8222-222222222222';
  const taskId = '33333333-3333-4333-8333-333333333333';
  const labelId = '44444444-4444-4444-8444-444444444444';
  const userId = '55555555-5555-4555-8555-555555555555';

  beforeEach(() => {
    vi.resetAllMocks();
    transaction.mockImplementation(
      async (callback: (client: unknown) => unknown) =>
        callback(transactionClient),
    );
    requireMembership.mockResolvedValue({
      id: 'member-id',
      role: WorkspaceRole.MEMBER,
    });
    requireRole.mockResolvedValue({
      id: 'manager-id',
      role: WorkspaceRole.OWNER,
    });
    labelCreate.mockResolvedValue({
      id: labelId,
      workspaceId,
      name: 'Bug',
      color: '#FF0000',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    labelFindFirst.mockResolvedValue({
      id: labelId,
      workspaceId,
      name: 'Bug',
      nameKey: 'bug',
      color: '#FF0000',
    });
    taskFindFirst.mockResolvedValue({
      id: taskId,
      creatorId: userId,
      archivedAt: null,
      project: { archivedAt: null },
      assigneeMember: null,
    });
    labelFindMany.mockResolvedValue([]);
    queryRaw.mockResolvedValue([]);
    taskLabelFindMany.mockResolvedValue([]);
    taskLabelFindUnique.mockResolvedValue(null);
  });

  it('creates a canonical workspace-scoped label', async () => {
    await expect(
      service.create(workspaceId, userId, {
        name: '  Bug  ',
        color: ' #ff0000 ',
      }),
    ).resolves.toMatchObject({ name: 'Bug', color: '#FF0000' });

    expect(requireRole).toHaveBeenCalled();
    expect(labelCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          workspaceId,
          name: 'Bug',
          nameKey: 'bug',
          color: '#FF0000',
        },
      }),
    );
  });

  it('stores a full Unicode case-folded key without changing the display name', async () => {
    await service.create(workspaceId, userId, {
      name: '  Straße  ',
      color: '#ff0000',
    });

    expect(labelCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'Straße',
          nameKey: 'strasse',
        }),
      }),
    );
  });

  it('blocks a legacy-equivalent name on create', async () => {
    labelFindMany
      .mockResolvedValueOnce([{ id: 'counted-label', name: 'Existing' }])
      .mockResolvedValueOnce([{ id: labelId, name: 'Straße' }]);

    await expect(
      service.create(workspaceId, userId, {
        name: 'STRASSE',
        color: '#ff0000',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(labelCreate).not.toHaveBeenCalled();
  });

  it('blocks Unicode Greek sigma variants from a legacy label', async () => {
    labelFindMany
      .mockResolvedValueOnce([{ id: 'counted-label', name: 'Existing' }])
      .mockResolvedValueOnce([{ id: labelId, name: 'ΟΣ' }]);

    await expect(
      service.create(workspaceId, userId, {
        name: 'οσ',
        color: '#ff0000',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(labelCreate).not.toHaveBeenCalled();
  });

  it('blocks legacy-equivalent names on update but excludes the current label', async () => {
    labelFindFirst.mockResolvedValueOnce({
      id: labelId,
      workspaceId,
      name: 'Bug',
      nameKey: 'bug',
      color: '#FF0000',
    });
    labelFindMany
      .mockResolvedValueOnce([
        { id: labelId, name: 'Bug' },
        { id: 'legacy-label-id', name: 'École' },
      ])
      .mockResolvedValueOnce([{ id: 'legacy-label-id', name: 'École' }]);

    await expect(
      service.update(workspaceId, labelId, userId, { name: 'école' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(labelUpdate).not.toHaveBeenCalled();
    expect(labelFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId, id: { not: labelId } },
      }),
    );
  });

  it('allows an equivalent name when updating the current label only', async () => {
    labelFindFirst.mockResolvedValueOnce({
      id: labelId,
      workspaceId,
      name: 'Straße',
      nameKey: 'straße',
      color: '#FF0000',
    });
    labelFindMany.mockResolvedValueOnce([{ id: labelId, name: 'Straße' }]);
    labelUpdate.mockResolvedValueOnce({
      id: labelId,
      workspaceId,
      name: 'STRASSE',
      color: '#FF0000',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      service.update(workspaceId, labelId, userId, { name: 'STRASSE' }),
    ).resolves.toMatchObject({ name: 'STRASSE' });
  });

  it('fails closed when the temporary compatibility scan limit is exceeded', async () => {
    labelFindMany.mockResolvedValueOnce(
      Array.from({ length: 1_001 }, (_, index) => ({
        id: `label-${index}`,
        name: `Label ${index}`,
      })),
    );

    await expect(
      service.create(workspaceId, userId, {
        name: 'New label',
        color: '#ff0000',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(labelCreate).not.toHaveBeenCalled();
  });

  it.each([
    { count: 999, shouldUpdate: true },
    { count: 1_000, shouldUpdate: true },
    { count: 1_001, shouldUpdate: false },
  ])(
    'applies the label count guard to update at $count labels',
    async ({ count, shouldUpdate }) => {
      labelFindMany.mockResolvedValueOnce(
        Array.from({ length: count }, (_, index) => ({
          id: `label-${index}`,
          name: `Label ${index}`,
        })),
      );
      labelUpdate.mockResolvedValueOnce({
        id: labelId,
        workspaceId,
        name: 'Renamed',
        color: '#FF0000',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const update = service.update(workspaceId, labelId, userId, {
        name: 'Renamed',
      });

      if (shouldUpdate) {
        await expect(update).resolves.toMatchObject({ name: 'Renamed' });
        expect(labelUpdate).toHaveBeenCalledTimes(1);
      } else {
        await expect(update).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
        expect(labelUpdate).not.toHaveBeenCalled();
      }
    },
  );

  it('does not run the name compatibility guard for a color-only update', async () => {
    labelUpdate.mockResolvedValueOnce({
      id: labelId,
      workspaceId,
      name: 'Bug',
      color: '#00FF00',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      service.update(workspaceId, labelId, userId, { color: '#00ff00' }),
    ).resolves.toMatchObject({ color: '#00FF00' });

    expect(labelFindMany).not.toHaveBeenCalled();
  });

  it('rechecks the label count after a P2034 retry', async () => {
    const p2034 = Object.assign(
      Object.create(Prisma.PrismaClientKnownRequestError.prototype),
      { code: 'P2034' },
    );
    transaction
      .mockImplementationOnce(
        async (callback: (client: unknown) => unknown) => {
          await callback(transactionClient);
          throw p2034;
        },
      )
      .mockImplementationOnce(async (callback: (client: unknown) => unknown) =>
        callback(transactionClient),
      );
    labelFindMany
      .mockResolvedValueOnce(
        Array.from({ length: 1_000 }, (_, index) => ({
          id: `label-${index}`,
          name: `Label ${index}`,
        })),
      )
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(
        Array.from({ length: 1_001 }, (_, index) => ({
          id: `label-${index}`,
          name: `Label ${index}`,
        })),
      );
    labelUpdate.mockResolvedValueOnce({
      id: labelId,
      workspaceId,
      name: 'Renamed',
      color: '#FF0000',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      service.update(workspaceId, labelId, userId, { name: 'Renamed' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(labelUpdate).toHaveBeenCalledTimes(1);
  });

  it('allows the same normalized name key in another workspace', async () => {
    const otherWorkspaceId = '77777777-7777-4777-8777-777777777777';

    await service.create(workspaceId, userId, {
      name: 'Straße',
      color: '#ff0000',
    });
    await service.create(otherWorkspaceId, userId, {
      name: 'STRASSE',
      color: '#00ff00',
    });

    expect(labelCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: otherWorkspaceId,
          nameKey: 'strasse',
        }),
      }),
    );
  });

  it('uses the normalized key when changing a label name', async () => {
    labelFindFirst.mockResolvedValueOnce({
      id: labelId,
      workspaceId,
      name: 'Straße',
      nameKey: 'strasse',
      color: '#FF0000',
    });
    labelUpdate.mockResolvedValueOnce({
      id: labelId,
      workspaceId,
      name: 'STRASSE',
      color: '#FF0000',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await service.update(workspaceId, labelId, userId, { name: 'STRASSE' });

    expect(labelUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'STRASSE',
          nameKey: 'strasse',
        }),
      }),
    );
  });

  it('maps an update collision to the same HTTP conflict', async () => {
    labelUpdate.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      service.update(workspaceId, labelId, userId, { name: 'STRASSE' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps duplicate label names to conflict', async () => {
    labelCreate.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(
      service.create(workspaceId, userId, { name: 'Bug', color: '#FF0000' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('writes one removal event per relation before deleting the label', async () => {
    taskLabelFindMany.mockResolvedValue([
      { taskId },
      { taskId: '66666666-6666-4666-8666-666666666666' },
    ]);

    await service.remove(workspaceId, labelId, userId);

    expect(taskLabelFindMany).toHaveBeenCalledWith({
      where: { workspaceId, labelId },
      select: { taskId: true },
    });
    expect(activityWriteMany).toHaveBeenCalledTimes(1);
    expect(activityWriteMany).toHaveBeenCalledWith(transactionClient, [
      expect.objectContaining({
        taskId,
        type: 'LABEL_REMOVED',
        payload: {
          schemaVersion: 1,
          entity: 'label',
          snapshot: { labelId, name: 'Bug', color: '#FF0000' },
        },
      }),
      expect.objectContaining({
        taskId: '66666666-6666-4666-8666-666666666666',
        type: 'LABEL_REMOVED',
      }),
    ]);
    expect(labelDelete).toHaveBeenCalledWith({
      where: { workspaceId_id: { workspaceId, id: labelId } },
    });
  });

  it('does not write activity for an unused label', async () => {
    await service.remove(workspaceId, labelId, userId);

    expect(activityWriteMany).not.toHaveBeenCalled();
    expect(labelDelete).toHaveBeenCalledTimes(1);
  });

  it('does not delete the label when activity fan-out fails', async () => {
    taskLabelFindMany.mockResolvedValue([{ taskId }]);
    const error = new Prisma.PrismaClientKnownRequestError(
      'activity write failed',
      { code: 'P2025', clientVersion: 'test' },
    );
    activityWriteMany.mockRejectedValueOnce(error);

    await expect(service.remove(workspaceId, labelId, userId)).rejects.toBe(
      error,
    );
    expect(labelDelete).not.toHaveBeenCalled();
  });

  it('keeps the manager-only delete policy and workspace isolation', async () => {
    requireRole.mockRejectedValueOnce(new ForbiddenException());
    await expect(
      service.remove(workspaceId, labelId, userId),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(labelFindFirst).not.toHaveBeenCalled();

    requireRole.mockResolvedValueOnce({ role: WorkspaceRole.OWNER });
    labelFindFirst.mockResolvedValueOnce(null);
    await expect(
      service.remove(workspaceId, labelId, userId),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(labelDelete).not.toHaveBeenCalled();
  });

  it('allows a member to add an owned task label idempotently', async () => {
    taskLabelFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ taskId });
    await service.addToTask(workspaceId, projectId, taskId, labelId, userId);
    await service.addToTask(workspaceId, projectId, taskId, labelId, userId);

    expect(taskLabelCreate).toHaveBeenCalledTimes(1);
    expect(activityWrite).toHaveBeenCalledTimes(1);
    expect(activityWrite).toHaveBeenCalledWith(
      transactionClient,
      expect.objectContaining({ type: 'LABEL_ADDED' }),
    );
  });

  it('writes removal only when a task-label relation existed', async () => {
    taskLabelDeleteMany.mockResolvedValueOnce({ count: 1 });
    await service.removeFromTask(
      workspaceId,
      projectId,
      taskId,
      labelId,
      userId,
    );
    expect(activityWrite).toHaveBeenCalledWith(
      transactionClient,
      expect.objectContaining({ type: 'LABEL_REMOVED' }),
    );

    activityWrite.mockClear();
    taskLabelDeleteMany.mockResolvedValueOnce({ count: 0 });
    await service.removeFromTask(
      workspaceId,
      projectId,
      taskId,
      labelId,
      userId,
    );
    expect(activityWrite).not.toHaveBeenCalled();
  });

  it('blocks a member from changing another member task', async () => {
    requireMembership.mockResolvedValue({ role: WorkspaceRole.MEMBER });
    taskFindFirst.mockResolvedValue({
      id: taskId,
      creatorId: 'other-user',
      archivedAt: null,
      project: { archivedAt: null },
      assigneeMember: null,
    });

    await expect(
      service.addToTask(workspaceId, projectId, taskId, labelId, userId),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(taskLabelCreate).not.toHaveBeenCalled();
  });

  it('rejects labels outside the task workspace and protects archived tasks', async () => {
    labelFindFirst.mockResolvedValueOnce(null);
    await expect(
      service.addToTask(workspaceId, projectId, taskId, labelId, userId),
    ).rejects.toBeInstanceOf(NotFoundException);

    labelFindFirst.mockResolvedValue({ id: labelId });
    taskFindFirst.mockResolvedValueOnce({
      id: taskId,
      creatorId: userId,
      archivedAt: new Date(),
      project: { archivedAt: null },
      assigneeMember: null,
    });
    await expect(
      service.removeFromTask(workspaceId, projectId, taskId, labelId, userId),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
