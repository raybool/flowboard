import { WorkspaceRole } from '../../generated/prisma/client';
import { WorkspaceRolesGuard } from '../workspaces/guards/workspace-roles.guard';
import { WORKSPACE_ROLES_KEY } from '../workspaces/decorators/workspace-roles.decorator';
import type { AuthUser } from '../auth/types/auth.types';

import { FindProjectsDto } from './dto/find-projects.dto';
import { ProjectsController } from './projects.controller';

describe('ProjectsController workspace policies', () => {
  const method = (name: keyof ProjectsController): object =>
    Object.getOwnPropertyDescriptor(ProjectsController.prototype, name)
      ?.value as object;

  it('requires manager roles for project writes', () => {
    for (const name of ['create', 'update', 'archive'] as const) {
      expect(Reflect.getMetadata(WORKSPACE_ROLES_KEY, method(name))).toEqual([
        WorkspaceRole.OWNER,
        WorkspaceRole.ADMIN,
      ]);
      expect(Reflect.getMetadata('__guards__', method(name))).toContain(
        WorkspaceRolesGuard,
      );
    }
  });

  it('allows every workspace member to read projects', () => {
    for (const name of ['findAll', 'findOne'] as const) {
      expect(Reflect.getMetadata(WORKSPACE_ROLES_KEY, method(name))).toEqual(
        [],
      );
      expect(Reflect.getMetadata('__guards__', method(name))).toContain(
        WorkspaceRolesGuard,
      );
    }
  });

  it('forwards the project list query to the service', async () => {
    const findAll = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const controller = new ProjectsController({ findAll } as never);
    const query: FindProjectsDto = { includeArchived: true, limit: 1 };
    const user = { id: 'user-id' } as AuthUser;

    await controller.findAll('workspace-id', user, query);

    expect(findAll).toHaveBeenCalledWith('workspace-id', 'user-id', query);
  });
});
