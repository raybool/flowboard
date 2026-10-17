import { WorkspaceRolesGuard } from '../workspaces/guards/workspace-roles.guard';

import { TaskActivityController } from './task-activity.controller';

describe('TaskActivityController', () => {
  it('exposes only the authenticated read endpoint', () => {
    const prototype = TaskActivityController.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'findAll');

    expect(descriptor).toBeDefined();
    expect(Reflect.getMetadata('__guards__', descriptor?.value)).toContain(
      WorkspaceRolesGuard,
    );
    expect(
      Object.getOwnPropertyDescriptor(prototype, 'create'),
    ).toBeUndefined();
    expect(
      Object.getOwnPropertyDescriptor(prototype, 'update'),
    ).toBeUndefined();
    expect(
      Object.getOwnPropertyDescriptor(prototype, 'remove'),
    ).toBeUndefined();
  });
});
