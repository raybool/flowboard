import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';

import { PrismaService } from '../../database/prisma.service';
import { WorkspaceRolesGuard } from '../workspaces/guards/workspace-roles.guard';

import { TaskCommentsController } from './task-comments.controller';
import { TaskCommentsModule } from './task-comments.module';
import { TaskCommentsService } from './task-comments.service';

describe('TaskCommentsModule DI', () => {
  it('resolves the controller, service, and workspace guard', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        TaskCommentsModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(TaskCommentsController)).toBeInstanceOf(
      TaskCommentsController,
    );
    expect(moduleRef.get(TaskCommentsService)).toBeInstanceOf(
      TaskCommentsService,
    );
    expect(moduleRef.get(WorkspaceRolesGuard)).toBeInstanceOf(
      WorkspaceRolesGuard,
    );

    await moduleRef.close();
  });
});
