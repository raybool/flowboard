import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';

import { TaskActivityController } from './task-activity.controller';
import { TaskActivityService } from './task-activity.service';
import { ActivityWriterService } from './task-activity.writer';

@Module({
  imports: [DatabaseModule, WorkspacesModule],
  controllers: [TaskActivityController],
  providers: [TaskActivityService, ActivityWriterService],
  exports: [ActivityWriterService],
})
export class TaskActivityModule {}
