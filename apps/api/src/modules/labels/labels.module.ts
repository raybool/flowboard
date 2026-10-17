import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { TaskActivityModule } from '../task-activity/task-activity.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';

import { LabelsController } from './labels.controller';
import { LabelsService } from './labels.service';
import { TaskLabelsController } from './task-labels.controller';

@Module({
  imports: [DatabaseModule, WorkspacesModule, TaskActivityModule],
  controllers: [LabelsController, TaskLabelsController],
  providers: [LabelsService],
  exports: [LabelsService],
})
export class LabelsModule {}
