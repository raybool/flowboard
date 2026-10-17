import { HttpStatus } from '@nestjs/common';

import { WorkspaceRolesGuard } from '../workspaces/guards/workspace-roles.guard';
import { WORKSPACE_ROLES_KEY } from '../workspaces/decorators/workspace-roles.decorator';
import type { AuthUser } from '../auth/types/auth.types';

import { CreateTaskCommentDto } from './dto/create-task-comment.dto';
import { ListTaskCommentsDto } from './dto/list-task-comments.dto';
import { TaskCommentsController } from './task-comments.controller';

describe('TaskCommentsController workspace policies', () => {
  const method = (name: keyof TaskCommentsController): object =>
    Object.getOwnPropertyDescriptor(TaskCommentsController.prototype, name)
      ?.value as object;

  it('requires current workspace membership for every endpoint', () => {
    for (const name of ['create', 'findAll', 'update', 'remove'] as const) {
      expect(Reflect.getMetadata(WORKSPACE_ROLES_KEY, method(name))).toEqual(
        [],
      );
      expect(Reflect.getMetadata('__guards__', method(name))).toContain(
        WorkspaceRolesGuard,
      );
    }
  });

  it('returns 204 for delete', () => {
    expect(Reflect.getMetadata('__httpCode__', method('remove'))).toBe(
      HttpStatus.NO_CONTENT,
    );
  });

  it('forwards the verified user and route scope to create', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'comment-id' });
    const controller = new TaskCommentsController({ create } as never);
    const user = { id: 'user-id' } as AuthUser;
    const dto = { content: 'Comment' } as CreateTaskCommentDto;

    await controller.create('workspace-id', 'project-id', 'task-id', user, dto);

    expect(create).toHaveBeenCalledWith(
      'workspace-id',
      'project-id',
      'task-id',
      user,
      dto,
    );
  });

  it('forwards list pagination and user id', async () => {
    const findAll = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const controller = new TaskCommentsController({ findAll } as never);
    const user = { id: 'user-id' } as AuthUser;
    const query: ListTaskCommentsDto = { limit: 1 };

    await controller.findAll(
      'workspace-id',
      'project-id',
      'task-id',
      user,
      query,
    );

    expect(findAll).toHaveBeenCalledWith(
      'workspace-id',
      'project-id',
      'task-id',
      'user-id',
      query,
    );
  });
});
