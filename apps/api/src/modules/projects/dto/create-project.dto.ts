import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateProjectDto {
  @ApiProperty({ example: 'Platform' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: 'PLAT', pattern: '[A-Z][A-Z0-9]{1,9}' })
  @IsString()
  @Matches(/^[A-Z][A-Z0-9]{1,9}$/)
  key!: string;

  @ApiPropertyOptional({ example: 'Core platform work' })
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  description?: string;
}
