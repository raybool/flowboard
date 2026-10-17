import { WorkspaceRolesGuard } from '../workspaces/guards/workspace-roles.guard';
import { WORKSPACE_ROLES_KEY } from '../workspaces/decorators/workspace-roles.decorator';
import { WorkspaceRole } from '../../generated/prisma/client';
import type { AuthUser } from '../auth/types/auth.types';

import { FindTasksDto } from './dto/find-tasks.dto';
import { TasksController } from './tasks.controller';

describe('TasksController workspace policies', () => {
  const method = (name: keyof TasksController): object =>
    Object.getOwnPropertyDescriptor(TasksController.prototype, name)
      ?.value as object;

  it('requires workspace membership and the workspace guard for every endpoint', () => {
    for (const name of [
      'create',
      'findAll',
      'findOne',
      'update',
      'updateStatus',
      'assign',
    ] as const) {
      expect(Reflect.getMetadata(WORKSPACE_ROLES_KEY, method(name))).toEqual(
        [],
      );
      expect(Reflect.getMetadata('__guards__', method(name))).toContain(
        WorkspaceRolesGuard,
      );
    }
  });

  it('requires manager roles to archive a task', () => {
    expect(Reflect.getMetadata(WORKSPACE_ROLES_KEY, method('archive'))).toEqual(
      [WorkspaceRole.OWNER, WorkspaceRole.ADMIN],
    );
  });

  it('forwards task filters and pagination to the service', async () => {
    const findAll = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const controller = new TasksController({ findAll } as never);
    const query: FindTasksDto = { limit: 1 };
    const user = { id: 'user-id' } as AuthUser;

    await controller.findAll('workspace-id', 'project-id', user, query);

    expect(findAll).toHaveBeenCalledWith(
      'workspace-id',
      'project-id',
      'user-id',
      query,
    );
  });
});
