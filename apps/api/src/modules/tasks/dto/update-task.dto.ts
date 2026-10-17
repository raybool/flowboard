import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { TaskPriority } from '../../../generated/prisma/client';

export class UpdateTaskDto {
  @ApiPropertyOptional({ example: 'Prepare final release notes' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({
    example: 'Include the migration notes.',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  description?: string | null;

  @ApiPropertyOptional({ enum: TaskPriority })
  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;
}
