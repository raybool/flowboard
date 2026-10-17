import { HttpStatus } from '@nestjs/common';

import type { AuthUser } from '../auth/types/auth.types';
import { WorkspaceRole } from '../../generated/prisma/client';
import { WorkspaceRolesGuard } from '../workspaces/guards/workspace-roles.guard';
import { WORKSPACE_ROLES_KEY } from '../workspaces/decorators/workspace-roles.decorator';

import { CreateLabelDto } from './dto/create-label.dto';
import { LabelsController } from './labels.controller';
import { TaskLabelsController } from './task-labels.controller';

describe('Labels controllers workspace policies', () => {
  const method = (target: object, name: string): object =>
    Object.getOwnPropertyDescriptor(target.constructor.prototype, name)
      ?.value as object;

  it('protects catalog endpoints with the expected roles', () => {
    const target = LabelsController.prototype;
    expect(
      Reflect.getMetadata(WORKSPACE_ROLES_KEY, method(target, 'create')),
    ).toEqual([WorkspaceRole.OWNER, WorkspaceRole.ADMIN]);
    expect(
      Reflect.getMetadata(WORKSPACE_ROLES_KEY, method(target, 'findAll')),
    ).toEqual([]);
    expect(
      Reflect.getMetadata('__guards__', method(target, 'findAll')),
    ).toContain(WorkspaceRolesGuard);
    expect(Reflect.getMetadata('__httpCode__', method(target, 'remove'))).toBe(
      HttpStatus.NO_CONTENT,
    );
  });

  it('forwards task label routes with the verified user', async () => {
    const add = vi.fn();
    const remove = vi.fn();
    const controller = new TaskLabelsController({
      addToTask: add,
      removeFromTask: remove,
    } as never);
    const user = { id: 'user-id' } as AuthUser;

    await controller.add(
      'workspace-id',
      'project-id',
      'task-id',
      'label-id',
      user,
    );
    await controller.remove(
      'workspace-id',
      'project-id',
      'task-id',
      'label-id',
      user,
    );

    expect(add).toHaveBeenCalledWith(
      'workspace-id',
      'project-id',
      'task-id',
      'label-id',
      'user-id',
    );
    expect(remove).toHaveBeenCalledWith(
      'workspace-id',
      'project-id',
      'task-id',
      'label-id',
      'user-id',
    );
  });

  it('forwards catalog create payload', async () => {
    const create = vi.fn();
    const controller = new LabelsController({ create } as never);
    const user = { id: 'user-id' } as AuthUser;
    const dto = { name: 'Bug', color: '#FF0000' } as CreateLabelDto;

    await controller.create('workspace-id', user, dto);

    expect(create).toHaveBeenCalledWith('workspace-id', 'user-id', dto);
  });
});
