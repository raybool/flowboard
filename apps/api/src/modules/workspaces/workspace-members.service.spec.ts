import {
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { WorkspaceRole } from '../../generated/prisma/client';
import type { PrismaService } from '../../database/prisma.service';

import { WorkspaceMembersService } from './workspace-members.service';

describe('WorkspaceMembersService', () => {
  const findUnique = vi.fn();
  const service = new WorkspaceMembersService({
    workspaceMember: { findUnique },
  } as unknown as PrismaService);

  beforeEach(() => vi.resetAllMocks());

  it('uses the workspaceId_userId unique key', async () => {
    const membership = {
      id: 'member-id',
      workspaceId: 'workspace-id',
      userId: 'user-id',
      role: WorkspaceRole.MEMBER,
      joinedAt: new Date(),
    };
    findUnique.mockResolvedValue(membership);

    await expect(
      service.findMembership('workspace-id', 'user-id'),
    ).resolves.toBe(membership);
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        workspaceId_userId: {
          workspaceId: 'workspace-id',
          userId: 'user-id',
        },
      },
    });
  });

  it('returns 404 when membership is missing', async () => {
    findUnique.mockResolvedValue(null);

    await expect(
      service.requireMembership('workspace-id', 'user-id'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 403 when the membership role is not allowed', async () => {
    findUnique.mockResolvedValue({ role: WorkspaceRole.MEMBER });

    await expect(
      service.requireRole('workspace-id', 'user-id', [
        WorkspaceRole.OWNER,
        WorkspaceRole.ADMIN,
      ]),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each([WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.MEMBER])(
    'allows the expected role: %s',
    async (role) => {
      const membership = { role };
      findUnique.mockResolvedValue(membership);

      await expect(
        service.requireRole('workspace-id', 'user-id', [role]),
      ).resolves.toBe(membership);
    },
  );

  it('preserves Prisma infrastructure failures', async () => {
    const error = new ServiceUnavailableException();
    findUnique.mockRejectedValue(error);

    await expect(
      service.requireMembership('workspace-id', 'user-id'),
    ).rejects.toBe(error);
  });
});
