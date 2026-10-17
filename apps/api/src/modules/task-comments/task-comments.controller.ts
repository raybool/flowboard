import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
import { WorkspaceRoles } from '../workspaces/decorators/workspace-roles.decorator';
import { WorkspaceRolesGuard } from '../workspaces/guards/workspace-roles.guard';

import { CreateTaskCommentDto } from './dto/create-task-comment.dto';
import { ListTaskCommentsDto } from './dto/list-task-comments.dto';
import { UpdateTaskCommentDto } from './dto/update-task-comment.dto';
import { TaskCommentsService } from './task-comments.service';

@ApiTags('Task Comments')
@ApiBearerAuth()
@Controller(
  'workspaces/:workspaceId/projects/:projectId/tasks/:taskId/comments',
)
export class TaskCommentsController {
  constructor(private readonly taskCommentsService: TaskCommentsService) {}

  @Post()
  @WorkspaceRoles()
  @UseGuards(WorkspaceRolesGuard)
  create(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateTaskCommentDto,
  ) {
    return this.taskCommentsService.create(
      workspaceId,
      projectId,
      taskId,
      user,
      dto,
    );
  }

  @Get()
  @WorkspaceRoles()
  @UseGuards(WorkspaceRolesGuard)
  findAll(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: ListTaskCommentsDto,
  ) {
    return this.taskCommentsService.findAll(
      workspaceId,
      projectId,
      taskId,
      user.id,
      query,
    );
  }

  @Patch(':commentId')
  @WorkspaceRoles()
  @UseGuards(WorkspaceRolesGuard)
  update(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateTaskCommentDto,
  ) {
    return this.taskCommentsService.update(
      workspaceId,
      projectId,
      taskId,
      commentId,
      user.id,
      dto,
    );
  }

  @Delete(':commentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WorkspaceRoles()
  @UseGuards(WorkspaceRolesGuard)
  remove(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.taskCommentsService.remove(
      workspaceId,
      projectId,
      taskId,
      commentId,
      user.id,
    );
  }
}
