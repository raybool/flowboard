import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { CreateProjectDto } from './create-project.dto';
import { FindProjectsDto } from './find-projects.dto';
import { UpdateProjectDto } from './update-project.dto';

describe('Projects DTO validation', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  });

  it('accepts a valid create payload and enforces the uppercase key contract', async () => {
    await expect(
      pipe.transform(
        { name: 'Platform', key: 'PLAT', description: 'Core work' },
        { type: 'body', metatype: CreateProjectDto },
      ),
    ).resolves.toMatchObject({ name: 'Platform', key: 'PLAT' });

    await expect(
      pipe.transform(
        { name: 'Platform', key: 'plat' },
        { type: 'body', metatype: CreateProjectDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects immutable project fields on update', async () => {
    await expect(
      pipe.transform(
        {
          name: 'Platform',
          key: 'NEW',
          workspaceId: '11111111-1111-4111-8111-111111111111',
          archivedAt: null,
        },
        { type: 'body', metatype: UpdateProjectDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('validates and transforms project list query parameters', async () => {
    await expect(
      pipe.transform(
        { includeArchived: 'false', limit: '1', cursor: 'opaque' },
        { type: 'query', metatype: FindProjectsDto },
      ),
    ).resolves.toEqual({ includeArchived: false, limit: 1, cursor: 'opaque' });

    for (const query of [
      { includeArchived: 'not-a-boolean' },
      { limit: '0' },
      { limit: '101' },
      { unexpected: 'value' },
    ]) {
      await expect(
        pipe.transform(query, { type: 'query', metatype: FindProjectsDto }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});
