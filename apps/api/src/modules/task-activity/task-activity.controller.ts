import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth.types';
import { WorkspaceRoles } from '../workspaces/decorators/workspace-roles.decorator';
import { WorkspaceRolesGuard } from '../workspaces/guards/workspace-roles.guard';

import { ListTaskActivityDto } from './dto/list-task-activity.dto';
import { TaskActivityService } from './task-activity.service';

@ApiTags('Task Activity')
@ApiBearerAuth()
@Controller(
  'workspaces/:workspaceId/projects/:projectId/tasks/:taskId/activity',
)
export class TaskActivityController {
  constructor(private readonly taskActivityService: TaskActivityService) {}

  @Get()
  @WorkspaceRoles()
  @UseGuards(WorkspaceRolesGuard)
  findAll(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: ListTaskActivityDto,
  ) {
    return this.taskActivityService.findAll(
      workspaceId,
      projectId,
      taskId,
      user.id,
      query,
    );
  }
}
