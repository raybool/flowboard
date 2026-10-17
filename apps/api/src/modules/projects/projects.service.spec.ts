import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { Prisma, WorkspaceRole } from '../../generated/prisma/client';
import type { PrismaService } from '../../database/prisma.service';
import { WorkspaceMembersService } from '../workspaces/workspace-members.service';

import { ProjectsService } from './projects.service';

describe('ProjectsService', () => {
  const requireMembership = vi.fn();
  const requireRole = vi.fn();
  const projectCreate = vi.fn();
  const projectFindFirst = vi.fn();
  const projectFindMany = vi.fn();
  const projectUpdate = vi.fn();
  const transaction = vi.fn();
  const transactionClient = {
    workspaceMember: { findUnique: vi.fn() },
    project: {
      create: projectCreate,
      findFirst: projectFindFirst,
      update: projectUpdate,
    },
  };
  const service = new ProjectsService(
    {
      project: {
        findMany: projectFindMany,
        findFirst: projectFindFirst,
      },
      $transaction: transaction,
    } as unknown as PrismaService,
    { requireMembership, requireRole } as unknown as WorkspaceMembersService,
  );

  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const otherWorkspaceId = '22222222-2222-4222-8222-222222222222';
  const userId = 'user-id';
  const projectId = 'project-id';
  const dto = {
    name: 'Platform',
    key: 'PLAT',
    description: 'Core platform',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    requireMembership.mockResolvedValue({
      userId,
      workspaceId,
      role: WorkspaceRole.MEMBER,
    });
    transaction.mockImplementation(async (callback) =>
      callback(transactionClient),
    );
  });

  it('allows owners and admins to create projects in their workspace', async () => {
    requireRole.mockResolvedValue({ role: WorkspaceRole.ADMIN });
    projectCreate.mockResolvedValue({ id: projectId, ...dto });

    await expect(service.create(workspaceId, userId, dto)).resolves.toEqual({
      id: projectId,
      ...dto,
    });

    expect(requireRole).toHaveBeenCalledWith(
      workspaceId,
      userId,
      [WorkspaceRole.OWNER, WorkspaceRole.ADMIN],
      transactionClient.workspaceMember,
    );
    expect(projectCreate).toHaveBeenCalledWith({
      data: {
        workspaceId,
        name: 'Platform',
        key: 'PLAT',
        description: 'Core platform',
      },
    });
  });

  it('blocks members from write operations before touching the project', async () => {
    const error = new ForbiddenException('Insufficient permissions');
    requireRole.mockRejectedValue(error);

    await expect(service.create(workspaceId, userId, dto)).rejects.toBe(error);
    expect(projectCreate).not.toHaveBeenCalled();
  });

  it('returns a membership-scoped paginated project envelope', async () => {
    projectFindMany.mockResolvedValue([]);

    await expect(service.findAll(workspaceId, userId)).resolves.toEqual({
      items: [],
      nextCursor: null,
    });

    expect(requireMembership).toHaveBeenCalledWith(workspaceId, userId);

    expect(projectFindMany).toHaveBeenCalledWith({
      where: {
        workspaceId,
        archivedAt: null,
        workspace: { members: { some: { userId } } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 51,
      select: {
        id: true,
        workspaceId: true,
        name: true,
        key: true,
        description: true,
        nextTaskSequence: true,
        archivedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  });

  it('includes archived projects and creates a cursor for the next page', async () => {
    const first = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
    };
    const second = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    projectFindMany.mockResolvedValueOnce([first, second]);

    const page = await service.findAll(workspaceId, userId, {
      includeArchived: true,
      limit: 1,
    });

    expect(page.items).toEqual([first]);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(projectFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId,
          workspace: { members: { some: { userId } } },
        },
        take: 2,
      }),
    );
  });

  it('rejects an invalid project cursor without exposing decode details', async () => {
    await expect(
      service.findAll(workspaceId, userId, { cursor: 'not-a-cursor' }),
    ).rejects.toEqual(new BadRequestException('Invalid cursor'));
    expect(projectFindMany).not.toHaveBeenCalled();
  });

  it('returns 404 for a project id from another workspace', async () => {
    projectFindFirst.mockResolvedValue(null);

    await expect(
      service.findOne(workspaceId, projectId, userId),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(projectFindFirst).toHaveBeenCalledWith({
      where: {
        id: projectId,
        workspaceId,
        workspace: { members: { some: { userId } } },
      },
    });
  });

  it('allows members to read archived projects when they are still members', async () => {
    const archivedProject = {
      id: projectId,
      workspaceId,
      archivedAt: new Date(),
    };
    projectFindFirst.mockResolvedValue(archivedProject);

    await expect(service.findOne(workspaceId, projectId, userId)).resolves.toBe(
      archivedProject,
    );
  });

  it('updates only explicitly allowed fields through a scoped transaction', async () => {
    requireRole.mockResolvedValue({ role: WorkspaceRole.OWNER });
    projectFindFirst.mockResolvedValue({
      id: projectId,
      workspaceId,
      archivedAt: null,
    });
    projectUpdate.mockResolvedValue({ id: projectId, name: 'New name' });

    await expect(
      service.update(workspaceId, projectId, userId, {
        name: 'New name',
        description: null,
      }),
    ).resolves.toEqual({ id: projectId, name: 'New name' });

    expect(projectUpdate).toHaveBeenCalledWith({
      where: { workspaceId_id: { workspaceId, id: projectId } },
      data: { name: 'New name', description: null },
    });
    expect(transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
  });

  it('rejects updates to archived projects', async () => {
    requireRole.mockResolvedValue({ role: WorkspaceRole.ADMIN });
    projectFindFirst.mockResolvedValue({
      id: projectId,
      workspaceId,
      archivedAt: new Date(),
    });

    await expect(
      service.update(workspaceId, projectId, userId, { name: 'New name' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(projectUpdate).not.toHaveBeenCalled();
  });

  it('maps a workspace-local project key conflict to 409', async () => {
    requireRole.mockResolvedValue({ role: WorkspaceRole.OWNER });
    const conflict = Object.assign(
      Object.create(Prisma.PrismaClientKnownRequestError.prototype),
      { code: 'P2002' },
    );
    projectCreate.mockRejectedValue(conflict);

    await expect(service.create(workspaceId, userId, dto)).rejects.toEqual(
      expect.any(ConflictException),
    );
  });

  it('permits the same key in a different workspace', async () => {
    requireRole.mockResolvedValue({ role: WorkspaceRole.OWNER });
    projectCreate.mockResolvedValue({ key: dto.key });

    await expect(
      service.create(otherWorkspaceId, userId, dto),
    ).resolves.toEqual({ key: dto.key });

    expect(projectCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ workspaceId: otherWorkspaceId }),
    });
  });

  it('archives a project once and rejects repeated archiving', async () => {
    requireRole.mockResolvedValue({ role: WorkspaceRole.ADMIN });
    projectFindFirst
      .mockResolvedValueOnce({ id: projectId, workspaceId, archivedAt: null })
      .mockResolvedValueOnce({
        id: projectId,
        workspaceId,
        archivedAt: new Date(),
      });
    projectUpdate.mockResolvedValue({
      id: projectId,
      archivedAt: new Date(),
    });

    await expect(
      service.archive(workspaceId, projectId, userId),
    ).resolves.toMatchObject({ id: projectId });
    await expect(
      service.archive(workspaceId, projectId, userId),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(projectUpdate).toHaveBeenCalledWith({
      where: { workspaceId_id: { workspaceId, id: projectId } },
      data: { archivedAt: expect.any(Date) },
    });
  });

  it('propagates revoked membership and infrastructure errors', async () => {
    const revoked = new NotFoundException('Workspace not found');
    requireRole.mockRejectedValue(revoked);

    await expect(service.archive(workspaceId, projectId, userId)).rejects.toBe(
      revoked,
    );

    const infrastructureError = new Error('database unavailable');
    projectFindMany.mockRejectedValue(infrastructureError);
    await expect(service.findAll(workspaceId, userId)).rejects.toBe(
      infrastructureError,
    );
  });

  it('retries P2034 and returns 503 when the retry budget is exhausted', async () => {
    requireRole.mockResolvedValue({ role: WorkspaceRole.OWNER });
    const p2034 = Object.assign(
      Object.create(Prisma.PrismaClientKnownRequestError.prototype),
      { code: 'P2034' },
    );
    transaction.mockRejectedValue(p2034);

    await expect(
      service.create(workspaceId, userId, dto),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('propagates transaction failures so the database transaction can roll back', async () => {
    requireRole.mockResolvedValue({ role: WorkspaceRole.OWNER });
    const infrastructureError = new Error('insert failed');
    projectCreate.mockRejectedValue(infrastructureError);

    await expect(service.create(workspaceId, userId, dto)).rejects.toBe(
      infrastructureError,
    );
  });
});
