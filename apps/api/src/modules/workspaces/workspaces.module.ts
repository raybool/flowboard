import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../../database/database.module';

import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';
import { WorkspaceMembersService } from './workspace-members.service';
import { WorkspaceRolesGuard } from './guards/workspace-roles.guard';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [WorkspacesController],
  providers: [WorkspacesService, WorkspaceMembersService, WorkspaceRolesGuard],
  exports: [WorkspacesService, WorkspaceMembersService, WorkspaceRolesGuard],
})
export class WorkspacesModule {}
