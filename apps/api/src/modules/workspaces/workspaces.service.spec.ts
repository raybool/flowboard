import {
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { Prisma, WorkspaceRole } from '../../generated/prisma/client';
import type { PrismaService } from '../../database/prisma.service';

import { WorkspaceMembersService } from './workspace-members.service';
import { WorkspacesService } from './workspaces.service';

describe('WorkspacesService authorization defense-in-depth', () => {
  const requireMembership = vi.fn();
  const requireRole = vi.fn();
  const findFirst = vi.fn();
  const update = vi.fn();
  const memberDelete = vi.fn();
  const taskUpdateMany = vi.fn();
  const workspaceFindFirst = vi.fn();
  const workspaceUpdate = vi.fn();
  const transaction = vi.fn();
  const service = new WorkspacesService(
    {
      workspaceMember: { findFirst, update, delete: memberDelete },
      workspace: { findFirst: workspaceFindFirst, update: workspaceUpdate },
      $transaction: transaction,
    } as unknown as PrismaService,
    {
      requireMembership,
      requireRole,
    } as unknown as WorkspaceMembersService,
  );

  beforeEach(() => {
    vi.resetAllMocks();
    transaction.mockImplementation(async (callback) =>
      callback({
        workspaceMember: { findFirst, update, delete: memberDelete },
        workspace: { update: workspaceUpdate },
        task: { updateMany: taskUpdateMany },
      }),
    );
  });

  it('keeps direct service calls behind the centralized role check', async () => {
    const error = new ForbiddenException();
    requireRole.mockRejectedValue(error);

    await expect(
      service.update('workspace-id', 'user-id', { name: 'Renamed workspace' }),
    ).rejects.toBe(error);
    expect(update).not.toHaveBeenCalled();
  });

  it('rechecks the role and updates through the same serializable transaction', async () => {
    requireRole.mockResolvedValue({ role: WorkspaceRole.OWNER });
    workspaceUpdate.mockResolvedValue({ id: 'workspace-id' });

    await expect(
      service.update('workspace-id', 'owner-id', { name: 'Renamed workspace' }),
    ).resolves.toEqual({ id: 'workspace-id' });

    expect(requireRole).toHaveBeenCalledWith(
      'workspace-id',
      'owner-id',
      [WorkspaceRole.OWNER, WorkspaceRole.ADMIN],
      expect.objectContaining({ findFirst, update }),
    );
    expect(workspaceUpdate).toHaveBeenCalledWith({
      where: { id: 'workspace-id' },
      data: { name: 'Renamed workspace' },
    });
    expect(transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
  });

  it('scopes member lookup to the requested workspace', async () => {
    requireRole.mockResolvedValue({ role: WorkspaceRole.OWNER });
    findFirst.mockResolvedValue(null);

    await expect(
      service.updateMemberRole(
        'workspace-a',
        'owner-id',
        'member-from-workspace-b',
        { role: WorkspaceRole.MEMBER },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: 'member-from-workspace-b',
        workspaceId: 'workspace-a',
      },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('returns 404 from a membership-scoped workspace read', async () => {
    workspaceFindFirst.mockResolvedValue(null);

    await expect(
      service.findOne('workspace-id', 'revoked-user-id'),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(workspaceFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'workspace-id',
        members: { some: { userId: 'revoked-user-id' } },
      },
      include: { _count: { select: { members: true } } },
    });
    expect(requireMembership).not.toHaveBeenCalled();
  });

  it('does not transform infrastructure errors from workspace reads', async () => {
    const error = new Error('database unavailable');
    workspaceFindFirst.mockRejectedValue(error);

    await expect(service.findOne('workspace-id', 'user-id')).rejects.toBe(
      error,
    );
  });

  it('preserves a domain error without retrying the transaction', async () => {
    const error = new ForbiddenException('Insufficient permissions');
    requireRole.mockRejectedValue(error);

    await expect(
      service.update('workspace-id', 'user-id', { name: 'Renamed workspace' }),
    ).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledOnce();
  });

  it('returns controlled 503 after the configured retry budget is exhausted', async () => {
    const p2034 = Object.assign(
      Object.create(Prisma.PrismaClientKnownRequestError.prototype),
      { code: 'P2034' },
    );
    transaction.mockRejectedValue(p2034);

    await expect(
      service.update('workspace-id', 'user-id', { name: 'Renamed workspace' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('clears task assignments before deleting a member in one transaction', async () => {
    requireRole.mockResolvedValue({ role: WorkspaceRole.OWNER });
    findFirst.mockResolvedValue({
      id: 'member-id',
      workspaceId: 'workspace-id',
      role: WorkspaceRole.MEMBER,
    });

    await expect(
      service.removeMember('workspace-id', 'owner-id', 'member-id'),
    ).resolves.toBeUndefined();

    expect(taskUpdateMany).toHaveBeenCalledWith({
      where: { workspaceId: 'workspace-id', assigneeMemberId: 'member-id' },
      data: { assigneeMemberId: null },
    });
    expect(memberDelete).toHaveBeenCalledWith({ where: { id: 'member-id' } });
  });

  it('does not delete a member when assignment cleanup fails', async () => {
    requireRole.mockResolvedValue({ role: WorkspaceRole.OWNER });
    findFirst.mockResolvedValue({
      id: 'member-id',
      workspaceId: 'workspace-id',
      role: WorkspaceRole.MEMBER,
    });
    const error = new Error('database unavailable');
    taskUpdateMany.mockRejectedValue(error);

    await expect(
      service.removeMember('workspace-id', 'owner-id', 'member-id'),
    ).rejects.toBe(error);
    expect(memberDelete).not.toHaveBeenCalled();
  });
});
