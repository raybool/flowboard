import {
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth.types';
import { WorkspaceRoles } from '../workspaces/decorators/workspace-roles.decorator';
import { WorkspaceRolesGuard } from '../workspaces/guards/workspace-roles.guard';

import { LabelsService } from './labels.service';

@ApiTags('Task Labels')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/projects/:projectId/tasks/:taskId/labels')
export class TaskLabelsController {
  constructor(private readonly labelsService: LabelsService) {}

  @Put(':labelId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WorkspaceRoles()
  @UseGuards(WorkspaceRolesGuard)
  add(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('labelId', ParseUUIDPipe) labelId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.labelsService.addToTask(
      workspaceId,
      projectId,
      taskId,
      labelId,
      user.id,
    );
  }

  @Delete(':labelId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WorkspaceRoles()
  @UseGuards(WorkspaceRolesGuard)
  remove(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('labelId', ParseUUIDPipe) labelId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.labelsService.removeFromTask(
      workspaceId,
      projectId,
      taskId,
      labelId,
      user.id,
    );
  }
}
