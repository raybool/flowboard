import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';

import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  imports: [DatabaseModule, WorkspacesModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
