import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { TaskActivityModule } from '../task-activity/task-activity.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';

import { TaskCommentsController } from './task-comments.controller';
import { TaskCommentsService } from './task-comments.service';

@Module({
  imports: [DatabaseModule, WorkspacesModule, TaskActivityModule],
  controllers: [TaskCommentsController],
  providers: [TaskCommentsService],
  exports: [TaskCommentsService],
})
export class TaskCommentsModule {}
