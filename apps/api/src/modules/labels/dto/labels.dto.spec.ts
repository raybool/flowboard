import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { CreateLabelDto } from './create-label.dto';
import { ListLabelsDto } from './list-labels.dto';
import { UpdateLabelDto } from './update-label.dto';

describe('Labels DTO validation', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  });

  it('trims names and canonicalizes colors', async () => {
    await expect(
      pipe.transform(
        { name: '  Release  ', color: ' #abcdef ' },
        { type: 'body', metatype: CreateLabelDto },
      ),
    ).resolves.toEqual({ name: 'Release', color: '#ABCDEF' });

    await expect(
      pipe.transform(
        { name: 'Renamed', color: '#123456' },
        { type: 'body', metatype: UpdateLabelDto },
      ),
    ).resolves.toEqual({ name: 'Renamed', color: '#123456' });
  });

  it('rejects invalid colors, names, and protected fields', async () => {
    for (const value of [
      { name: '   ', color: '#123456' },
      { name: 'Valid', color: 'red' },
      { name: 'x'.repeat(51), color: '#123456' },
      {
        name: 'Valid',
        color: '#123456',
        workspaceId: '11111111-1111-4111-8111-111111111111',
      },
    ]) {
      await expect(
        pipe.transform(value, {
          type: 'body',
          metatype: CreateLabelDto,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('validates label cursor pagination', async () => {
    await expect(
      pipe.transform(
        { limit: '20', cursor: 'opaque' },
        { type: 'query', metatype: ListLabelsDto },
      ),
    ).resolves.toEqual({ limit: 20, cursor: 'opaque' });

    await expect(
      pipe.transform(
        { limit: '101', unexpected: true },
        { type: 'query', metatype: ListLabelsDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
