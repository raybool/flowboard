import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { WorkspaceRole } from '../../../generated/prisma/client';

import { WorkspaceRoles } from '../decorators/workspace-roles.decorator';
import type { WorkspaceMembersService } from '../workspace-members.service';

import { WorkspaceRolesGuard } from './workspace-roles.guard';

class TestController {
  @WorkspaceRoles()
  memberRoute(this: void): void {}

  @WorkspaceRoles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  managerRoute(this: void): void {}

  managerWithoutMetadata(this: void): void {}
}

function createContext(
  handler: () => void,
  request: {
    params?: Record<string, unknown>;
    user?: { id: string; email: string; name: string | null };
    body?: Record<string, unknown>;
    query?: Record<string, unknown>;
    headers?: Record<string, string>;
  },
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => TestController,
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('WorkspaceRolesGuard', () => {
  const requireMembership = vi.fn();
  const requireRole = vi.fn();
  const workspaceMembersService = {
    requireMembership,
    requireRole,
  } as unknown as WorkspaceMembersService;
  const guard = new WorkspaceRolesGuard(
    new Reflector(),
    workspaceMembersService,
  );
  const user = {
    id: 'user-id',
    email: 'user@example.com',
    name: 'User',
  };
  const workspaceId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns 401 without request.user', async () => {
    const context = createContext(TestController.prototype.memberRoute, {
      params: { workspaceId },
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(requireMembership).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid path workspaceId before Prisma', async () => {
    const context = createContext(TestController.prototype.memberRoute, {
      params: { workspaceId: 'not-a-uuid' },
      user,
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(requireMembership).not.toHaveBeenCalled();
    expect(requireRole).not.toHaveBeenCalled();
  });

  it('requires membership for the any-member policy', async () => {
    const membership = { role: WorkspaceRole.MEMBER };
    requireMembership.mockResolvedValue(membership);
    const request = { params: { workspaceId }, user };

    await expect(
      guard.canActivate(
        createContext(TestController.prototype.memberRoute, request),
      ),
    ).resolves.toBe(true);

    expect(requireMembership).toHaveBeenCalledWith(workspaceId, user.id);
    expect(requireRole).not.toHaveBeenCalled();
    expect(request).toHaveProperty('workspaceMembership', membership);
  });

  it('requires the configured roles for restricted policies', async () => {
    requireRole.mockResolvedValue({ role: WorkspaceRole.ADMIN });

    await expect(
      guard.canActivate(
        createContext(TestController.prototype.managerRoute, {
          params: { workspaceId },
          user,
        }),
      ),
    ).resolves.toBe(true);

    expect(requireRole).toHaveBeenCalledWith(workspaceId, user.id, [
      WorkspaceRole.OWNER,
      WorkspaceRole.ADMIN,
    ]);
  });

  it('preserves 404 and 403 authorization errors', async () => {
    requireMembership.mockRejectedValue(new NotFoundException());
    await expect(
      guard.canActivate(
        createContext(TestController.prototype.memberRoute, {
          params: { workspaceId },
          user,
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    requireRole.mockRejectedValue(new ForbiddenException());
    await expect(
      guard.canActivate(
        createContext(TestController.prototype.managerRoute, {
          params: { workspaceId },
          user,
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('preserves infrastructure failures', async () => {
    const error = new ServiceUnavailableException();
    requireMembership.mockRejectedValue(error);

    await expect(
      guard.canActivate(
        createContext(TestController.prototype.memberRoute, {
          params: { workspaceId },
          user,
        }),
      ),
    ).rejects.toBe(error);
  });

  it('blocks the next request after membership is removed', async () => {
    requireMembership
      .mockResolvedValueOnce({ role: WorkspaceRole.MEMBER })
      .mockRejectedValueOnce(new NotFoundException());
    const context = () =>
      createContext(TestController.prototype.memberRoute, {
        params: { workspaceId },
        user,
      });

    await expect(guard.canActivate(context())).resolves.toBe(true);
    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('fails closed when metadata is missing', async () => {
    await expect(
      guard.canActivate(
        createContext(TestController.prototype.managerWithoutMetadata, {
          params: { workspaceId },
          user,
        }),
      ),
    ).rejects.toMatchObject({
      constructor: InternalServerErrorException,
      message: 'Unable to authorize workspace request',
    });
    expect(requireMembership).not.toHaveBeenCalled();
    expect(requireRole).not.toHaveBeenCalled();
  });

  it('uses only params.workspaceId as the workspace source', async () => {
    requireMembership.mockResolvedValue({ role: WorkspaceRole.MEMBER });

    await expect(
      guard.canActivate(
        createContext(TestController.prototype.memberRoute, {
          params: { workspaceId },
          user,
          body: { workspaceId: '22222222-2222-4222-8222-222222222222' },
          query: { workspaceId: '33333333-3333-4333-8333-333333333333' },
          headers: { 'x-workspace-id': '44444444-4444-4444-8444-444444444444' },
        }),
      ),
    ).resolves.toBe(true);

    expect(requireMembership).toHaveBeenCalledWith(workspaceId, user.id);
  });
});
