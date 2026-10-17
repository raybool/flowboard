import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth.types';
import { WorkspaceRole } from '../../generated/prisma/client';
import { WorkspaceRoles } from '../workspaces/decorators/workspace-roles.decorator';
import { WorkspaceRolesGuard } from '../workspaces/guards/workspace-roles.guard';

import { CreateTaskDto } from './dto/create-task.dto';
import { AssignTaskDto } from './dto/assign-task.dto';
import { FindTasksDto } from './dto/find-tasks.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { UpdateTaskStatusDto } from './dto/update-task-status.dto';
import { TasksService } from './tasks.service';

@ApiTags('Tasks')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/projects/:projectId/tasks')
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Post()
  @WorkspaceRoles()
  @UseGuards(WorkspaceRolesGuard)
  create(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateTaskDto,
  ) {
    return this.tasksService.create(workspaceId, projectId, user.id, dto);
  }

  @Get()
  @WorkspaceRoles()
  @UseGuards(WorkspaceRolesGuard)
  findAll(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: FindTasksDto,
  ) {
    return this.tasksService.findAll(workspaceId, projectId, user.id, query);
  }

  @Get(':taskId')
  @WorkspaceRoles()
  @UseGuards(WorkspaceRolesGuard)
  findOne(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tasksService.findOne(workspaceId, projectId, taskId, user.id);
  }

  @Patch(':taskId')
  @WorkspaceRoles()
  @UseGuards(WorkspaceRolesGuard)
  update(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateTaskDto,
  ) {
    return this.tasksService.update(
      workspaceId,
      projectId,
      taskId,
      user.id,
      dto,
    );
  }

  @Patch(':taskId/status')
  @WorkspaceRoles()
  @UseGuards(WorkspaceRolesGuard)
  updateStatus(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateTaskStatusDto,
  ) {
    return this.tasksService.updateStatus(
      workspaceId,
      projectId,
      taskId,
      user.id,
      dto,
    );
  }

  @Patch(':taskId/assignee')
  @WorkspaceRoles()
  @UseGuards(WorkspaceRolesGuard)
  assign(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: AssignTaskDto,
  ) {
    return this.tasksService.assign(
      workspaceId,
      projectId,
      taskId,
      user.id,
      dto,
    );
  }

  @Post(':taskId/archive')
  @WorkspaceRoles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  @UseGuards(WorkspaceRolesGuard)
  archive(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tasksService.archive(workspaceId, projectId, taskId, user.id);
  }
}
