import { Body, Controller, Post } from '@nestjs/common';

import { ApiTags, ApiOperation, ApiBody, ApiResponse } from '@nestjs/swagger';
import { CreateProjectDto } from './common/dto/create-project.dto';

ApiTags('Projects')
@Controller('projects')
export class AppController {
  @Post()
  @ApiOperation({ summary: 'Create project' })
  @ApiBody({ type: CreateProjectDto })
  @ApiResponse({
    status: 201,
    description: 'Project created',
  })
  create(@Body() dto: CreateProjectDto) {
    return {
      id: crypto.randomUUID(),
      name: dto.name,
    };
  }
}
