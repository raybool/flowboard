import {
  Body,
  Controller,
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
import { WorkspaceRole } from '../../generated/prisma/client';
import { WorkspaceRoles } from '../workspaces/decorators/workspace-roles.decorator';
import { WorkspaceRolesGuard } from '../workspaces/guards/workspace-roles.guard';

import { CreateProjectDto } from './dto/create-project.dto';
import { FindProjectsDto } from './dto/find-projects.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { ProjectsService } from './projects.service';

@ApiTags('Projects')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  @WorkspaceRoles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  @UseGuards(WorkspaceRolesGuard)
  create(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateProjectDto,
  ) {
    return this.projectsService.create(workspaceId, user.id, dto);
  }

  @Get()
  @WorkspaceRoles()
  @UseGuards(WorkspaceRolesGuard)
  findAll(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: FindProjectsDto,
  ) {
    return this.projectsService.findAll(workspaceId, user.id, query);
  }

  @Get(':projectId')
  @WorkspaceRoles()
  @UseGuards(WorkspaceRolesGuard)
  findOne(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.projectsService.findOne(workspaceId, projectId, user.id);
  }

  @Patch(':projectId')
  @WorkspaceRoles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  @UseGuards(WorkspaceRolesGuard)
  update(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projectsService.update(workspaceId, projectId, user.id, dto);
  }

  @Post(':projectId/archive')
  @WorkspaceRoles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  @UseGuards(WorkspaceRolesGuard)
  @HttpCode(HttpStatus.OK)
  archive(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.projectsService.archive(workspaceId, projectId, user.id);
  }
}
