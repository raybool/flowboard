import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';

import { PrismaService } from '../../database/prisma.service';

import { WorkspaceMembersService } from './workspace-members.service';
import { WorkspaceRolesGuard } from './guards/workspace-roles.guard';
import { WorkspacesModule } from './workspaces.module';
import { WorkspacesService } from './workspaces.service';

describe('WorkspacesModule DI', () => {
  it('resolves RBAC providers and exports WorkspaceMembersService', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        WorkspacesModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(WorkspaceMembersService)).toBeInstanceOf(
      WorkspaceMembersService,
    );
    expect(moduleRef.get(WorkspaceRolesGuard)).toBeInstanceOf(
      WorkspaceRolesGuard,
    );
    expect(moduleRef.get(WorkspacesService)).toBeInstanceOf(WorkspacesService);

    await moduleRef.close();
  });
});
