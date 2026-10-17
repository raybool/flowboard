import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { TaskPriority, TaskStatus } from '../../../generated/prisma/client';

import { AssignTaskDto } from './assign-task.dto';
import { CreateTaskDto } from './create-task.dto';
import { FindTasksDto } from './find-tasks.dto';
import { UpdateTaskDto } from './update-task.dto';
import { UpdateTaskStatusDto } from './update-task-status.dto';

describe('Tasks DTO validation', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  });

  it('accepts valid task fields', async () => {
    await expect(
      pipe.transform(
        {
          title: 'Release notes',
          description: 'Migration details',
          priority: TaskPriority.HIGH,
          assigneeId: '11111111-1111-4111-8111-111111111111',
        },
        { type: 'body', metatype: CreateTaskDto },
      ),
    ).resolves.toMatchObject({
      title: 'Release notes',
      priority: TaskPriority.HIGH,
    });
  });

  it('rejects invalid UUIDs, oversized fields, and protected fields', async () => {
    await expect(
      pipe.transform(
        {
          title: 'Task',
          assigneeId: 'not-a-uuid',
        },
        { type: 'body', metatype: CreateTaskDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      pipe.transform(
        {
          title: 'Task',
          creatorId: '11111111-1111-4111-8111-111111111111',
          sequence: 99,
          workspaceId: '11111111-1111-4111-8111-111111111111',
          projectId: '11111111-1111-4111-8111-111111111111',
        },
        { type: 'body', metatype: CreateTaskDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      pipe.transform(
        {
          title: 'Task',
          status: 'DONE',
          assigneeId: '11111111-1111-4111-8111-111111111111',
        },
        { type: 'body', metatype: UpdateTaskDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows an empty update payload', async () => {
    await expect(
      pipe.transform({}, { type: 'body', metatype: UpdateTaskDto }),
    ).resolves.toEqual({});
  });

  it('validates status and allows clearing an assignee', async () => {
    await expect(
      pipe.transform(
        { status: TaskStatus.DONE },
        { type: 'body', metatype: UpdateTaskStatusDto },
      ),
    ).resolves.toMatchObject({ status: TaskStatus.DONE });

    await expect(
      pipe.transform(
        { status: 'INVALID' },
        { type: 'body', metatype: UpdateTaskStatusDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      pipe.transform(
        { assigneeId: null },
        { type: 'body', metatype: AssignTaskDto },
      ),
    ).resolves.toMatchObject({ assigneeId: null });

    await expect(
      pipe.transform({}, { type: 'body', metatype: AssignTaskDto }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('validates and transforms task list filters', async () => {
    await expect(
      pipe.transform(
        {
          status: TaskStatus.DONE,
          priority: TaskPriority.HIGH,
          assigneeId: '11111111-1111-4111-8111-111111111111',
          includeArchived: 'true',
          limit: '100',
          cursor: 'opaque',
        },
        { type: 'query', metatype: FindTasksDto },
      ),
    ).resolves.toEqual({
      status: TaskStatus.DONE,
      priority: TaskPriority.HIGH,
      assigneeId: '11111111-1111-4111-8111-111111111111',
      includeArchived: true,
      limit: 100,
      cursor: 'opaque',
    });

    for (const query of [
      { status: 'UNKNOWN' },
      { priority: 'UNKNOWN' },
      { assigneeId: 'not-a-uuid' },
      { includeArchived: 'not-a-boolean' },
      { limit: '101' },
      { unexpected: 'value' },
    ]) {
      await expect(
        pipe.transform(query, { type: 'query', metatype: FindTasksDto }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});
