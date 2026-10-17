import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import { Prisma, WorkspaceRole } from '../../generated/prisma/client';
import type { PrismaService } from '../../database/prisma.service';
import { WorkspaceMembersService } from '../workspaces/workspace-members.service';
import type { AuthUser } from '../auth/types/auth.types';

import { TaskCommentsService } from './task-comments.service';

describe('TaskCommentsService', () => {
  const requireMembership = vi.fn();
  const taskFindFirst = vi.fn();
  const commentCreate = vi.fn();
  const commentFindFirst = vi.fn();
  const commentFindMany = vi.fn();
  const commentUpdate = vi.fn();
  const transaction = vi.fn();
  const activityWrite = vi.fn();
  const transactionClient = {
    workspaceMember: { findUnique: vi.fn() },
    task: { findFirst: taskFindFirst },
    taskComment: {
      create: commentCreate,
      findFirst: commentFindFirst,
      update: commentUpdate,
    },
  };
  const service = new TaskCommentsService(
    {
      task: { findFirst: taskFindFirst },
      taskComment: { findMany: commentFindMany },
      $transaction: transaction,
    } as unknown as PrismaService,
    { requireMembership } as unknown as WorkspaceMembersService,
    { write: activityWrite } as never,
  );

  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const projectId = '22222222-2222-4222-8222-222222222222';
  const taskId = '33333333-3333-4333-8333-333333333333';
  const commentId = '55555555-5555-4555-8555-555555555555';
  const userId = '44444444-4444-4444-8444-444444444444';
  const user: AuthUser = {
    id: userId,
    email: 'user@example.com',
    name: 'User',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    transaction.mockImplementation(async (callback) =>
      callback(transactionClient),
    );
    requireMembership.mockResolvedValue({
      userId,
      role: WorkspaceRole.MEMBER,
    });
    taskFindFirst.mockResolvedValue({ id: taskId, archivedAt: null });
  });

  function comment(overrides: Record<string, unknown> = {}) {
    return {
      id: commentId,
      workspaceId,
      taskId,
      authorId: userId,
      authorDisplayName: 'User',
      content: 'A comment',
      deletedAt: null,
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      ...overrides,
    };
  }

  it.each([WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.MEMBER])(
    'allows %s to create a comment without accepting an author from the DTO',
    async (role) => {
      requireMembership.mockResolvedValue({ role });
      commentCreate.mockResolvedValue(comment());

      await expect(
        service.create(workspaceId, projectId, taskId, user, {
          content: '  A comment  ',
        }),
      ).resolves.toMatchObject({
        author: { id: userId, displayName: 'User' },
        content: 'A comment',
      });

      expect(commentCreate).toHaveBeenCalledWith({
        data: {
          workspaceId,
          taskId,
          authorId: userId,
          authorDisplayName: 'User',
          content: 'A comment',
        },
        select: expect.any(Object),
      });
      expect(activityWrite).toHaveBeenCalledWith(
        transactionClient,
        expect.objectContaining({
          type: 'COMMENT_CREATED',
          payload: expect.not.objectContaining({ content: expect.anything() }),
        }),
      );
    },
  );

  it('rejects writes to archived tasks and cross-project task ids', async () => {
    taskFindFirst.mockResolvedValueOnce({
      id: taskId,
      archivedAt: new Date(),
    });
    await expect(
      service.create(workspaceId, projectId, taskId, user, {
        content: 'Comment',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    taskFindFirst.mockResolvedValueOnce(null);
    await expect(
      service.create(workspaceId, projectId, taskId, user, {
        content: 'Comment',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(commentCreate).not.toHaveBeenCalled();
  });

  it('returns tombstones with redacted content and a stable cursor page', async () => {
    const first = comment();
    const second = comment({
      id: '66666666-6666-4666-8666-666666666666',
      content: null,
      deletedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    commentFindMany.mockResolvedValue([first, second]);

    const page = await service.findAll(workspaceId, projectId, taskId, userId, {
      limit: 1,
    });

    expect(page.items).toEqual([
      expect.objectContaining({ id: commentId, content: 'A comment' }),
    ]);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(commentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId, taskId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 2,
        select: expect.any(Object),
      }),
    );

    commentFindMany.mockResolvedValue([second]);
    await expect(
      service.findAll(workspaceId, projectId, taskId, userId),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ content: null })],
      nextCursor: null,
    });
    expect(
      (await service.findAll(workspaceId, projectId, taskId, userId)).items[0],
    ).toMatchObject({
      content: null,
      author: { id: userId, displayName: 'User' },
    });
  });

  it('rejects invalid cursors before querying comments', async () => {
    await expect(
      service.findAll(workspaceId, projectId, taskId, userId, {
        cursor: 'invalid',
      }),
    ).rejects.toEqual(new BadRequestException('Invalid cursor'));
    expect(commentFindMany).not.toHaveBeenCalled();
  });

  it('allows only the author to edit and never edits a tombstone', async () => {
    commentFindFirst.mockResolvedValue({ authorId: userId, deletedAt: null });
    commentUpdate.mockResolvedValue(comment({ content: 'Edited' }));

    await expect(
      service.update(workspaceId, projectId, taskId, commentId, userId, {
        content: 'Edited',
      }),
    ).resolves.toMatchObject({ content: 'Edited' });

    commentFindFirst.mockResolvedValueOnce({
      authorId: 'other-user',
      deletedAt: null,
    });
    await expect(
      service.update(workspaceId, projectId, taskId, commentId, userId, {
        content: 'Nope',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    commentFindFirst.mockResolvedValueOnce({
      authorId: userId,
      deletedAt: new Date(),
    });
    await expect(
      service.update(workspaceId, projectId, taskId, commentId, userId, {
        content: 'Nope',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('returns an identical normalized comment without updating or emitting an event', async () => {
    const current = comment({ content: 'Same body' });
    commentFindFirst.mockResolvedValue(current);

    await expect(
      service.update(workspaceId, projectId, taskId, commentId, userId, {
        content: '  Same body  ',
      }),
    ).resolves.toEqual({
      id: commentId,
      workspaceId,
      taskId,
      author: { id: userId, displayName: 'User' },
      content: 'Same body',
      deletedAt: null,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
    });

    expect(commentUpdate).not.toHaveBeenCalled();
    expect(activityWrite).not.toHaveBeenCalled();
  });

  it('does not use an identical update to bypass author or membership checks', async () => {
    commentFindFirst.mockResolvedValue({
      ...comment(),
      authorId: 'other-user',
    });

    await expect(
      service.update(workspaceId, projectId, taskId, commentId, userId, {
        content: 'A comment',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(commentUpdate).not.toHaveBeenCalled();
    expect(activityWrite).not.toHaveBeenCalled();

    requireMembership.mockRejectedValueOnce(
      new NotFoundException('Membership not found'),
    );
    await expect(
      service.update(workspaceId, projectId, taskId, commentId, userId, {
        content: 'A comment',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(commentFindFirst).toHaveBeenCalledOnce();
    expect(commentUpdate).not.toHaveBeenCalled();
    expect(activityWrite).not.toHaveBeenCalled();
  });

  it('does not emit duplicate events when a no-op transaction is retried', async () => {
    commentFindFirst.mockResolvedValue(comment({ content: 'A comment' }));
    const p2034 = Object.assign(
      Object.create(Prisma.PrismaClientKnownRequestError.prototype),
      { code: 'P2034' },
    );
    transaction
      .mockImplementationOnce(async (callback) => {
        await callback(transactionClient);
        throw p2034;
      })
      .mockImplementationOnce(async (callback) => callback(transactionClient));

    await expect(
      service.update(workspaceId, projectId, taskId, commentId, userId, {
        content: 'A comment',
      }),
    ).resolves.toMatchObject({ content: 'A comment' });

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(commentUpdate).not.toHaveBeenCalled();
    expect(activityWrite).not.toHaveBeenCalled();
  });

  it('allows manager moderation, redacts content, and makes repeated delete idempotent', async () => {
    requireMembership.mockResolvedValue({ role: WorkspaceRole.ADMIN });
    commentFindFirst.mockResolvedValue({
      authorId: 'other-user',
      deletedAt: null,
    });

    await expect(
      service.remove(workspaceId, projectId, taskId, commentId, userId),
    ).resolves.toBeUndefined();
    expect(commentUpdate).toHaveBeenCalledWith({
      where: { workspaceId_id: { workspaceId, id: commentId } },
      data: { content: null, deletedAt: expect.any(Date), deletedById: userId },
    });

    commentFindFirst.mockResolvedValueOnce({
      authorId: 'other-user',
      deletedAt: new Date(),
    });
    await expect(
      service.remove(workspaceId, projectId, taskId, commentId, userId),
    ).resolves.toBeUndefined();
    expect(commentUpdate).toHaveBeenCalledOnce();
  });

  it('writes metadata-only comment update and delete events', async () => {
    commentFindFirst.mockResolvedValue({
      authorId: userId,
      deletedAt: null,
      content: 'Original body',
    });
    commentUpdate.mockResolvedValue(comment({ content: 'Edited body' }));

    await service.update(workspaceId, projectId, taskId, commentId, userId, {
      content: 'Edited body',
    });
    expect(activityWrite).toHaveBeenCalledWith(
      transactionClient,
      expect.objectContaining({
        type: 'COMMENT_UPDATED',
        payload: expect.objectContaining({
          changes: { contentLength: { from: 13, to: 11 } },
        }),
      }),
    );

    activityWrite.mockClear();
    commentFindFirst.mockResolvedValue({
      authorId: userId,
      deletedAt: null,
      content: 'Edited body',
    });
    await service.remove(workspaceId, projectId, taskId, commentId, userId);
    expect(activityWrite).toHaveBeenCalledWith(
      transactionClient,
      expect.objectContaining({
        type: 'COMMENT_DELETED',
        payload: expect.objectContaining({
          snapshot: expect.objectContaining({ deleted: true }),
        }),
      }),
    );
    expect(activityWrite.mock.calls[0][1].payload).not.toHaveProperty(
      'content',
    );
  });

  it('blocks member deletion of another author and author deletion on archived task', async () => {
    commentFindFirst.mockResolvedValue({
      authorId: 'other-user',
      deletedAt: null,
    });
    await expect(
      service.remove(workspaceId, projectId, taskId, commentId, userId),
    ).rejects.toBeInstanceOf(ForbiddenException);

    commentFindFirst.mockResolvedValue({ authorId: userId, deletedAt: null });
    taskFindFirst.mockResolvedValue({ id: taskId, archivedAt: new Date() });
    await expect(
      service.remove(workspaceId, projectId, taskId, commentId, userId),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(commentUpdate).not.toHaveBeenCalled();
  });

  it('retries the complete create transaction on P2034', async () => {
    commentCreate.mockResolvedValue(comment());
    const p2034 = Object.assign(
      Object.create(Prisma.PrismaClientKnownRequestError.prototype),
      { code: 'P2034' },
    );
    transaction
      .mockImplementationOnce(async (callback) => {
        await callback(transactionClient);
        throw p2034;
      })
      .mockImplementationOnce(async (callback) => callback(transactionClient));

    await expect(
      service.create(workspaceId, projectId, taskId, user, {
        content: 'Comment',
      }),
    ).resolves.toMatchObject({ id: commentId });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(requireMembership).toHaveBeenCalledTimes(2);
    expect(commentCreate).toHaveBeenCalledTimes(2);
  });
});
