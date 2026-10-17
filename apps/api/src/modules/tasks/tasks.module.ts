import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';

import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [DatabaseModule, WorkspacesModule],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
