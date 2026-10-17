import { WorkspaceRole } from '../../generated/prisma/client';

import { WORKSPACE_ROLES_KEY } from './decorators/workspace-roles.decorator';
import { WorkspaceRolesGuard } from './guards/workspace-roles.guard';
import { WorkspacesController } from './workspaces.controller';

describe('WorkspacesController workspace policies', () => {
  const method = (name: keyof WorkspacesController): object =>
    Object.getOwnPropertyDescriptor(WorkspacesController.prototype, name)
      ?.value as object;

  it('keeps workspace creation and own-workspace listing JWT-only', () => {
    expect(
      Reflect.getMetadata(WORKSPACE_ROLES_KEY, method('create')),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(WORKSPACE_ROLES_KEY, method('findAll')),
    ).toBeUndefined();
    expect(Reflect.getMetadata('__guards__', method('create'))).toBeUndefined();
    expect(
      Reflect.getMetadata('__guards__', method('findAll')),
    ).toBeUndefined();
  });

  it('declares the workspace role matrix on scoped endpoints', () => {
    expect(Reflect.getMetadata(WORKSPACE_ROLES_KEY, method('findOne'))).toEqual(
      [],
    );
    expect(
      Reflect.getMetadata(WORKSPACE_ROLES_KEY, method('getMembers')),
    ).toEqual([]);
    expect(Reflect.getMetadata(WORKSPACE_ROLES_KEY, method('update'))).toEqual([
      WorkspaceRole.OWNER,
      WorkspaceRole.ADMIN,
    ]);
    expect(
      Reflect.getMetadata(WORKSPACE_ROLES_KEY, method('addMember')),
    ).toEqual([WorkspaceRole.OWNER, WorkspaceRole.ADMIN]);
    expect(
      Reflect.getMetadata(WORKSPACE_ROLES_KEY, method('updateMemberRole')),
    ).toEqual([WorkspaceRole.OWNER]);
    expect(
      Reflect.getMetadata(WORKSPACE_ROLES_KEY, method('removeMember')),
    ).toEqual([WorkspaceRole.OWNER, WorkspaceRole.ADMIN]);
  });

  it('attaches WorkspaceRolesGuard only to scoped endpoints', () => {
    expect(Reflect.getMetadata('__guards__', method('create'))).toBeUndefined();
    expect(
      Reflect.getMetadata('__guards__', method('findAll')),
    ).toBeUndefined();

    for (const name of [
      'findOne',
      'update',
      'getMembers',
      'addMember',
      'updateMemberRole',
      'removeMember',
    ] as const) {
      expect(Reflect.getMetadata('__guards__', method(name))).toContain(
        WorkspaceRolesGuard,
      );
    }
  });
});
