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
import { WorkspaceRole } from '../../generated/prisma/client';
import { WorkspaceRoles } from '../workspaces/decorators/workspace-roles.decorator';
import { WorkspaceRolesGuard } from '../workspaces/guards/workspace-roles.guard';

import { CreateLabelDto } from './dto/create-label.dto';
import { ListLabelsDto } from './dto/list-labels.dto';
import { UpdateLabelDto } from './dto/update-label.dto';
import { LabelsService } from './labels.service';

@ApiTags('Labels')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/labels')
export class LabelsController {
  constructor(private readonly labelsService: LabelsService) {}

  @Post()
  @WorkspaceRoles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  @UseGuards(WorkspaceRolesGuard)
  create(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateLabelDto,
  ) {
    return this.labelsService.create(workspaceId, user.id, dto);
  }

  @Get()
  @WorkspaceRoles()
  @UseGuards(WorkspaceRolesGuard)
  findAll(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: ListLabelsDto,
  ) {
    return this.labelsService.findAll(workspaceId, user.id, query);
  }

  @Patch(':labelId')
  @WorkspaceRoles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  @UseGuards(WorkspaceRolesGuard)
  update(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('labelId', ParseUUIDPipe) labelId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateLabelDto,
  ) {
    return this.labelsService.update(workspaceId, labelId, user.id, dto);
  }

  @Delete(':labelId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WorkspaceRoles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  @UseGuards(WorkspaceRolesGuard)
  remove(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('labelId', ParseUUIDPipe) labelId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.labelsService.remove(workspaceId, labelId, user.id);
  }
}
