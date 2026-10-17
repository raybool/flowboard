import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { CreateTaskCommentDto } from './create-task-comment.dto';
import { ListTaskCommentsDto } from './list-task-comments.dto';
import { UpdateTaskCommentDto } from './update-task-comment.dto';

describe('Task comments DTO validation', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  });

  it('trims and accepts comment content', async () => {
    await expect(
      pipe.transform(
        { content: '  **A comment**  ' },
        { type: 'body', metatype: CreateTaskCommentDto },
      ),
    ).resolves.toEqual({ content: '**A comment**' });

    await expect(
      pipe.transform(
        { content: '  Edited  ' },
        { type: 'body', metatype: UpdateTaskCommentDto },
      ),
    ).resolves.toEqual({ content: 'Edited' });
  });

  it('rejects empty, oversized, and mass-assignment fields', async () => {
    for (const value of [
      { content: '   ' },
      { content: 'x'.repeat(10_001) },
      {
        content: 'safe',
        authorId: '11111111-1111-4111-8111-111111111111',
        workspaceId: '11111111-1111-4111-8111-111111111111',
      },
    ]) {
      await expect(
        pipe.transform(value, {
          type: 'body',
          metatype: CreateTaskCommentDto,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('validates and transforms list pagination', async () => {
    await expect(
      pipe.transform(
        { limit: '25', cursor: 'opaque' },
        { type: 'query', metatype: ListTaskCommentsDto },
      ),
    ).resolves.toEqual({ limit: 25, cursor: 'opaque' });

    for (const query of [
      { limit: '0' },
      { limit: '101' },
      { limit: 'not-a-number' },
      { unexpected: 'value' },
    ]) {
      await expect(
        pipe.transform(query, {
          type: 'query',
          metatype: ListTaskCommentsDto,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});
