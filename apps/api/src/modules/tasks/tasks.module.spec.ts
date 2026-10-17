import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';

import { PrismaService } from '../../database/prisma.service';
import { WorkspaceRolesGuard } from '../workspaces/guards/workspace-roles.guard';

import { TasksController } from './tasks.controller';
import { TasksModule } from './tasks.module';
import { TasksService } from './tasks.service';

describe('TasksModule DI', () => {
  it('resolves the controller, service, and workspace guard', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        TasksModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(TasksController)).toBeInstanceOf(TasksController);
    expect(moduleRef.get(TasksService)).toBeInstanceOf(TasksService);
    expect(moduleRef.get(WorkspaceRolesGuard)).toBeInstanceOf(
      WorkspaceRolesGuard,
    );

    await moduleRef.close();
  });
});
