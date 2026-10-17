import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';

import { PrismaService } from '../../database/prisma.service';
import { WorkspaceRolesGuard } from '../workspaces/guards/workspace-roles.guard';

import { ProjectsController } from './projects.controller';
import { ProjectsModule } from './projects.module';
import { ProjectsService } from './projects.service';

describe('ProjectsModule DI', () => {
  it('resolves the controller, service, and workspace guard', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        ProjectsModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(ProjectsController)).toBeInstanceOf(
      ProjectsController,
    );
    expect(moduleRef.get(ProjectsService)).toBeInstanceOf(ProjectsService);
    expect(moduleRef.get(WorkspaceRolesGuard)).toBeInstanceOf(
      WorkspaceRolesGuard,
    );

    await moduleRef.close();
  });
});
