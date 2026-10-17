import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

const trimContent = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateTaskCommentDto {
  @ApiProperty({
    description: 'Plain-text or Markdown comment body',
    maxLength: 10_000,
  })
  @Transform(trimContent)
  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  content!: string;
}
