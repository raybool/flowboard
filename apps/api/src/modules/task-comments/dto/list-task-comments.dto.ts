import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListTaskCommentsDto {
  @ApiPropertyOptional({
    default: 50,
    description: 'Number of comments to return',
    maximum: 100,
    minimum: 1,
    type: Number,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque Base64URL pagination cursor' })
  @IsOptional()
  @IsString()
  cursor?: string;
}
