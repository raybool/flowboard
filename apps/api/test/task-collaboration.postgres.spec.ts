import { randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';

import {
  PrismaClient,
  TaskActivityType,
  TaskPriority,
  TaskStatus,
  WorkspaceRole,
} from '../src/generated/prisma/client';
import { PrismaService } from '../src/database/prisma.service';
import { LabelsService } from '../src/modules/labels/labels.service';
import { normalizeLabelNameKey } from '../src/modules/labels/label-name-normalization';
import { TasksService } from '../src/modules/tasks/tasks.service';
import { TaskActivityService } from '../src/modules/task-activity/task-activity.service';
import { ActivityWriterService } from '../src/modules/task-activity/task-activity.writer';
import { TaskCommentsService } from '../src/modules/task-comments/task-comments.service';
import { WorkspaceMembersService } from '../src/modules/workspaces/workspace-members.service';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe('Task collaboration PostgreSQL integrity', () => {
  let prisma: PrismaClient;
  let tasksService: TasksService;
  let taskCommentsService: TaskCommentsService;
  let labelsService: LabelsService;
  let taskActivityService: TaskActivityService;
  const workspaceIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    const parsed = new URL(databaseUrl!);
    const databaseName = decodeURIComponent(parsed.pathname.slice(1));

    if (
      !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) ||
      !databaseName.endsWith('_test')
    ) {
      throw new Error(
        'TEST_DATABASE_URL must point to a local database ending in _test',
      );
    }

    const developmentUrl = process.env.DATABASE_URL;
    if (developmentUrl) {
      const development = new URL(developmentUrl);
      if (
        parsed.hostname === development.hostname &&
        parsed.port === development.port &&
        parsed.pathname === development.pathname
      ) {
        throw new Error(
          'TEST_DATABASE_URL must not point to the development database',
        );
      }
    }

    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
    });
    await prisma.$connect();

    const prismaService = prisma as unknown as PrismaService;
    const workspaceMembersService = new WorkspaceMembersService(prismaService);
    const activityWriter = new ActivityWriterService();
    tasksService = new TasksService(
      prismaService,
      workspaceMembersService,
      activityWriter,
    );
    taskCommentsService = new TaskCommentsService(
      prismaService,
      workspaceMembersService,
      activityWriter,
    );
    labelsService = new LabelsService(
      prismaService,
      workspaceMembersService,
      activityWriter,
    );
    taskActivityService = new TaskActivityService(
      prismaService,
      workspaceMembersService,
    );
  });

  afterEach(async () => {
    if (workspaceIds.length > 0) {
      await prisma.workspace.deleteMany({
        where: { id: { in: workspaceIds.splice(0) } },
      });
    }
  });

  afterAll(async () => {
    if (userIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await prisma.$disconnect();
  });

  async function createUser(label: string) {
    const id = randomUUID();
    userIds.push(id);
    return prisma.user.create({
      data: {
        id,
        email: `${label}-${id}@example.test`,
        name: label,
        passwordHash: 'fixture',
      },
    });
  }

  async function createFixture(label: string) {
    const creator = await createUser(`${label}-creator`);
    const workspace = await prisma.workspace.create({
      data: {
        name: `Workspace ${label}`,
        slug: `workspace-${label}-${randomUUID()}`,
        members: {
          create: { userId: creator.id, role: WorkspaceRole.OWNER },
        },
      },
    });
    workspaceIds.push(workspace.id);

    const project = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: `Project ${label}`,
        key: label.slice(0, 4).toUpperCase(),
      },
    });
    const task = await prisma.task.create({
      data: {
        workspaceId: workspace.id,
        projectId: project.id,
        sequence: 1,
        title: `Task ${label}`,
        creatorId: creator.id,
        status: TaskStatus.TODO,
        priority: TaskPriority.MEDIUM,
      },
    });
    await prisma.project.update({
      where: { id: project.id },
      data: { nextTaskSequence: 2 },
    });

    return { creator, workspace, project, task };
  }

  async function addMember(
    workspaceId: string,
    userId: string,
    role: WorkspaceRole = WorkspaceRole.MEMBER,
  ) {
    return prisma.workspaceMember.create({
      data: { workspaceId, userId, role },
    });
  }

  function authUser(user: { id: string; email: string; name: string | null }) {
    return user;
  }

  async function activityRows(taskId: string) {
    return prisma.taskActivity.findMany({
      where: { taskId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  function expectNestStatus(error: unknown, status: number) {
    expect(
      typeof (error as { getStatus?: () => number })?.getStatus === 'function'
        ? (error as { getStatus: () => number }).getStatus()
        : (error as { status?: number })?.status,
    ).toBe(status);
  }

  it('verifies migration constraints, indexes, composite foreign keys, and trigger', async () => {
    const constraints = await prisma.$queryRawUnsafe<
      Array<{ name: string; definition: string }>
    >(
      `SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname IN ('task_comments', 'task_labels', 'task_activities', 'labels')
       ORDER BY c.conname`,
    );
    const indexes = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT indexname AS name
       FROM pg_indexes
       WHERE tablename IN ('task_comments', 'task_labels', 'task_activities', 'labels')`,
    );
    const trigger = await prisma.$queryRawUnsafe<
      Array<{ name: string; enabled: string }>
    >(
      `SELECT tgname AS name, tgenabled::text AS enabled
       FROM pg_trigger
       WHERE tgrelid = 'task_activities'::regclass
         AND NOT tgisinternal`,
    );

    const constraintNames = constraints.map(({ name }) => name);
    expect(constraintNames).toEqual(
      expect.arrayContaining([
        'task_comments_workspace_id_task_id_fkey',
        'task_labels_workspace_id_label_id_fkey',
        'task_activities_workspace_id_task_id_fkey',
      ]),
    );
    expect(
      constraints.find(
        ({ name }) => name === 'task_comments_workspace_id_task_id_fkey',
      )?.definition,
    ).toContain('FOREIGN KEY (workspace_id, task_id)');
    expect(
      constraints.find(
        ({ name }) => name === 'task_labels_workspace_id_label_id_fkey',
      )?.definition,
    ).toContain('ON DELETE CASCADE');
    expect(indexes.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'task_comments_workspace_id_task_id_created_at_id_idx',
        'task_labels_workspace_id_label_id_task_id_idx',
        'task_activities_workspace_id_task_id_created_at_id_idx',
        'labels_workspace_id_created_at_id_idx',
        'labels_workspace_id_name_key_key',
      ]),
    );
    expect(trigger).toEqual([
      { name: 'task_activities_immutable_trigger', enabled: 'O' },
    ]);
  });

  it('creates TaskComment, Label, TaskLabel, and TaskActivity rows', async () => {
    const fixture = await createFixture('create');

    const comment = await prisma.taskComment.create({
      data: {
        workspaceId: fixture.workspace.id,
        taskId: fixture.task.id,
        authorId: fixture.creator.id,
        authorDisplayName: fixture.creator.name!,
        content: 'A collaboration comment',
      },
    });
    const label = await prisma.label.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: 'Bug',
        nameKey: 'bug',
        color: '#FF0000',
      },
    });
    const taskLabel = await prisma.taskLabel.create({
      data: {
        workspaceId: fixture.workspace.id,
        taskId: fixture.task.id,
        labelId: label.id,
      },
    });
    const activity = await prisma.taskActivity.create({
      data: {
        workspaceId: fixture.workspace.id,
        taskId: fixture.task.id,
        actorId: fixture.creator.id,
        actorDisplayName: fixture.creator.name,
        type: TaskActivityType.COMMENT_CREATED,
        payload: {
          schemaVersion: 1,
          entity: 'task',
          snapshot: { taskId: fixture.task.id },
        },
      },
    });

    expect(comment.taskId).toBe(fixture.task.id);
    expect(label.workspaceId).toBe(fixture.workspace.id);
    expect(taskLabel).toMatchObject({
      workspaceId: fixture.workspace.id,
      taskId: fixture.task.id,
      labelId: label.id,
    });
    expect(activity).toMatchObject({
      workspaceId: fixture.workspace.id,
      taskId: fixture.task.id,
      type: TaskActivityType.COMMENT_CREATED,
      eventVersion: 1,
    });
  });

  it('rejects cross-workspace comments, activities, and label assignments', async () => {
    const first = await createFixture('first');
    const second = await createFixture('second');
    const secondLabel = await prisma.label.create({
      data: {
        workspaceId: second.workspace.id,
        name: 'Shared name',
        nameKey: 'shared-name',
        color: '#00FF00',
      },
    });

    await expect(
      prisma.taskComment.create({
        data: {
          workspaceId: second.workspace.id,
          taskId: first.task.id,
          authorDisplayName: 'Foreign',
          content: 'must fail',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });

    await expect(
      prisma.taskActivity.create({
        data: {
          workspaceId: second.workspace.id,
          taskId: first.task.id,
          type: TaskActivityType.TASK_UPDATED,
          payload: { schemaVersion: 1, entity: 'task' },
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });

    await expect(
      prisma.taskLabel.create({
        data: {
          workspaceId: first.workspace.id,
          taskId: first.task.id,
          labelId: secondLabel.id,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('enforces normalized label uniqueness and TaskLabel uniqueness', async () => {
    const fixture = await createFixture('unique');
    const label = await prisma.label.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: 'Bug',
        nameKey: 'bug',
        color: '#ABCDEF',
      },
    });

    await expect(
      prisma.label.create({
        data: {
          workspaceId: fixture.workspace.id,
          name: ' bug ',
          nameKey: 'bug',
          color: '#ABCDEF',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    await prisma.taskLabel.create({
      data: {
        workspaceId: fixture.workspace.id,
        taskId: fixture.task.id,
        labelId: label.id,
      },
    });
    await expect(
      prisma.taskLabel.create({
        data: {
          workspaceId: fixture.workspace.id,
          taskId: fixture.task.id,
          labelId: label.id,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('enforces comment, label, and activity payload checks', async () => {
    const fixture = await createFixture('checks');

    await expect(
      prisma.taskComment.create({
        data: {
          workspaceId: fixture.workspace.id,
          taskId: fixture.task.id,
          authorDisplayName: 'Invalid',
          content: 'x'.repeat(10001),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2039' });

    await expect(
      prisma.label.create({
        data: {
          workspaceId: fixture.workspace.id,
          name: 'Invalid color',
          nameKey: 'invalid-color',
          color: '#fff',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2039' });

    await expect(
      prisma.taskActivity.create({
        data: {
          workspaceId: fixture.workspace.id,
          taskId: fixture.task.id,
          type: TaskActivityType.TASK_UPDATED,
          payload: { entity: 'task' },
        },
      }),
    ).rejects.toMatchObject({ code: 'P2039' });
  });

  it('preserves attribution across membership removal and nulls user references on deletion', async () => {
    const fixture = await createFixture('lifecycle');
    const author = await createUser('comment-author');
    const actor = await createUser('activity-actor');
    const membership = await prisma.workspaceMember.findUniqueOrThrow({
      where: {
        workspaceId_userId: {
          workspaceId: fixture.workspace.id,
          userId: fixture.creator.id,
        },
      },
    });
    const comment = await prisma.taskComment.create({
      data: {
        workspaceId: fixture.workspace.id,
        taskId: fixture.task.id,
        authorId: author.id,
        authorDisplayName: author.name!,
        content: 'Attribution survives membership changes',
      },
    });
    const activity = await prisma.taskActivity.create({
      data: {
        workspaceId: fixture.workspace.id,
        taskId: fixture.task.id,
        actorId: actor.id,
        actorDisplayName: actor.name,
        type: TaskActivityType.TASK_UPDATED,
        payload: { schemaVersion: 1, entity: 'task' },
      },
    });

    await prisma.workspaceMember.delete({ where: { id: membership.id } });
    await expect(
      prisma.taskComment.findUnique({ where: { id: comment.id } }),
    ).resolves.toMatchObject({ authorId: author.id });
    await expect(
      prisma.taskActivity.findUnique({ where: { id: activity.id } }),
    ).resolves.toMatchObject({ actorId: actor.id });

    await prisma.user.delete({ where: { id: author.id } });
    await prisma.user.delete({ where: { id: actor.id } });
    await expect(
      prisma.taskComment.findUnique({ where: { id: comment.id } }),
    ).resolves.toMatchObject({
      authorId: null,
      authorDisplayName: author.name,
    });
    await expect(
      prisma.taskActivity.findUnique({ where: { id: activity.id } }),
    ).resolves.toMatchObject({ actorId: null, actorDisplayName: actor.name });
  });

  it('cascades domain rows and keeps label snapshots in activity history', async () => {
    const fixture = await createFixture('cascade');
    const label = await prisma.label.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: 'Release',
        nameKey: 'release',
        color: '#112233',
      },
    });
    await prisma.taskLabel.create({
      data: {
        workspaceId: fixture.workspace.id,
        taskId: fixture.task.id,
        labelId: label.id,
      },
    });
    const comment = await prisma.taskComment.create({
      data: {
        workspaceId: fixture.workspace.id,
        taskId: fixture.task.id,
        authorDisplayName: 'Cascade',
        content: 'Cascade me',
      },
    });
    const activity = await prisma.taskActivity.create({
      data: {
        workspaceId: fixture.workspace.id,
        taskId: fixture.task.id,
        type: TaskActivityType.LABEL_ADDED,
        payload: {
          schemaVersion: 1,
          entity: 'task',
          snapshot: { labelId: label.id, name: label.name, color: label.color },
        },
      },
    });

    await prisma.label.delete({ where: { id: label.id } });
    await expect(
      prisma.taskLabel.findUnique({
        where: {
          workspaceId_taskId_labelId: {
            workspaceId: fixture.workspace.id,
            taskId: fixture.task.id,
            labelId: label.id,
          },
        },
      }),
    ).resolves.toBeNull();
    await expect(
      prisma.taskActivity.findUnique({ where: { id: activity.id } }),
    ).resolves.toMatchObject({
      payload: { snapshot: { name: 'Release', color: '#112233' } },
    });

    await prisma.task.delete({ where: { id: fixture.task.id } });
    await expect(
      prisma.taskComment.findUnique({ where: { id: comment.id } }),
    ).resolves.toBeNull();
    await expect(
      prisma.taskActivity.findUnique({ where: { id: activity.id } }),
    ).resolves.toBeNull();
  });

  it('rolls back comments and activity written in one transaction', async () => {
    const fixture = await createFixture('rollback');

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.taskComment.create({
          data: {
            workspaceId: fixture.workspace.id,
            taskId: fixture.task.id,
            authorDisplayName: 'Rollback',
            content: 'Should not persist',
          },
        });
        await tx.taskActivity.create({
          data: {
            workspaceId: fixture.workspace.id,
            taskId: fixture.task.id,
            type: TaskActivityType.COMMENT_CREATED,
            payload: { schemaVersion: 1, entity: 'task' },
          },
        });
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');

    await expect(
      prisma.taskComment.count({ where: { taskId: fixture.task.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.taskActivity.count({ where: { taskId: fixture.task.id } }),
    ).resolves.toBe(0);
  });

  it('blocks direct activity mutation but permits parent cascade deletion', async () => {
    const fixture = await createFixture('immutable');
    const activity = await prisma.taskActivity.create({
      data: {
        workspaceId: fixture.workspace.id,
        taskId: fixture.task.id,
        type: TaskActivityType.TASK_CREATED,
        payload: { schemaVersion: 1, entity: 'task' },
      },
    });

    await expect(
      prisma.taskActivity.update({
        where: { id: activity.id },
        data: { actorDisplayName: 'tampered' },
      }),
    ).rejects.toThrow(/task_activities are immutable/);
    await expect(
      prisma.taskActivity.delete({ where: { id: activity.id } }),
    ).rejects.toThrow(/task_activities are immutable/);

    await prisma.task.delete({ where: { id: fixture.task.id } });
    await expect(
      prisma.taskActivity.findUnique({ where: { id: activity.id } }),
    ).resolves.toBeNull();
  });

  it('covers comments service isolation, moderation, tombstones, cursor pagination, and revoked membership', async () => {
    const fixture = await createFixture('comments-service');
    const member = await createUser('comments-member');
    await addMember(fixture.workspace.id, member.id);
    const owner = authUser(fixture.creator);
    const memberUser = authUser(member);

    const first = await taskCommentsService.create(
      fixture.workspace.id,
      fixture.project.id,
      fixture.task.id,
      owner,
      { content: 'first comment' },
    );
    await taskCommentsService.create(
      fixture.workspace.id,
      fixture.project.id,
      fixture.task.id,
      owner,
      { content: 'second comment' },
    );
    const moderated = await taskCommentsService.create(
      fixture.workspace.id,
      fixture.project.id,
      fixture.task.id,
      memberUser,
      { content: 'moderated comment' },
    );

    await expect(
      taskCommentsService.update(
        fixture.workspace.id,
        fixture.project.id,
        fixture.task.id,
        first.id,
        member.id,
        { content: 'IDOR edit' },
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectNestStatus(error, 403);
      return true;
    });

    await taskCommentsService.update(
      fixture.workspace.id,
      fixture.project.id,
      fixture.task.id,
      first.id,
      fixture.creator.id,
      { content: 'edited by author' },
    );

    const beforeNoopComment = await prisma.taskComment.findUniqueOrThrow({
      where: { id: first.id },
    });
    const beforeNoopEvents = await prisma.taskActivity.count({
      where: {
        taskId: fixture.task.id,
        type: TaskActivityType.COMMENT_UPDATED,
      },
    });
    await expect(
      taskCommentsService.update(
        fixture.workspace.id,
        fixture.project.id,
        fixture.task.id,
        first.id,
        fixture.creator.id,
        { content: '  edited by author  ' },
      ),
    ).resolves.toMatchObject({ content: 'edited by author' });
    const afterNoopComment = await prisma.taskComment.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(afterNoopComment.updatedAt).toEqual(beforeNoopComment.updatedAt);
    await expect(
      prisma.taskActivity.count({
        where: {
          taskId: fixture.task.id,
          type: TaskActivityType.COMMENT_UPDATED,
        },
      }),
    ).resolves.toBe(beforeNoopEvents);

    await taskCommentsService.remove(
      fixture.workspace.id,
      fixture.project.id,
      fixture.task.id,
      moderated.id,
      fixture.creator.id,
    );

    const page = await taskCommentsService.findAll(
      fixture.workspace.id,
      fixture.project.id,
      fixture.task.id,
      fixture.creator.id,
      { limit: 2 },
    );
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(page.items.some((item) => item.content === null)).toBe(true);
    const nextPage = await taskCommentsService.findAll(
      fixture.workspace.id,
      fixture.project.id,
      fixture.task.id,
      fixture.creator.id,
      { limit: 2, cursor: page.nextCursor! },
    );
    expect(nextPage.items).toHaveLength(1);
    expect(
      new Set([...page.items, ...nextPage.items].map((item) => item.id)).size,
    ).toBe(3);

    const secondTask = await prisma.task.create({
      data: {
        workspaceId: fixture.workspace.id,
        projectId: fixture.project.id,
        sequence: 2,
        title: 'Second task',
        creatorId: fixture.creator.id,
        status: TaskStatus.TODO,
        priority: TaskPriority.MEDIUM,
      },
    });
    await expect(
      taskCommentsService.update(
        fixture.workspace.id,
        fixture.project.id,
        secondTask.id,
        first.id,
        fixture.creator.id,
        { content: 'cross-task' },
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectNestStatus(error, 404);
      return true;
    });

    const foreign = await createFixture('comments-foreign');
    await expect(
      taskCommentsService.findAll(
        foreign.workspace.id,
        foreign.project.id,
        foreign.task.id,
        fixture.creator.id,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectNestStatus(error, 404);
      return true;
    });

    await prisma.workspaceMember.delete({
      where: {
        workspaceId_userId: {
          workspaceId: fixture.workspace.id,
          userId: member.id,
        },
      },
    });
    await expect(
      taskCommentsService.create(
        fixture.workspace.id,
        fixture.project.id,
        fixture.task.id,
        memberUser,
        { content: 'revoked' },
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectNestStatus(error, 404);
      return true;
    });
  });

  it('covers label lifecycle, workspace uniqueness, task ownership, idempotency, filters, and archives', async () => {
    const fixture = await createFixture('labels-service');
    const member = await createUser('labels-member');
    await addMember(fixture.workspace.id, member.id);
    const foreign = await createFixture('labels-foreign');

    const label = await labelsService.create(
      fixture.workspace.id,
      fixture.creator.id,
      {
        name: ' Bug ',
        color: '#aabbcc',
      },
    );
    const foreignLabel = await labelsService.create(
      foreign.workspace.id,
      foreign.creator.id,
      { name: 'Bug', color: '#AABBCC' },
    );
    expect(label).toMatchObject({ name: 'Bug', color: '#AABBCC' });
    await expect(
      labelsService.create(fixture.workspace.id, fixture.creator.id, {
        name: 'bug',
        color: '#FFFFFF',
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectNestStatus(error, 409);
      return true;
    });
    await labelsService.update(
      fixture.workspace.id,
      label.id,
      fixture.creator.id,
      {
        name: 'Bug Updated',
        color: '#112233',
      },
    );

    await expect(
      labelsService.addToTask(
        fixture.workspace.id,
        fixture.project.id,
        fixture.task.id,
        label.id,
        member.id,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectNestStatus(error, 403);
      return true;
    });
    await labelsService.addToTask(
      fixture.workspace.id,
      fixture.project.id,
      fixture.task.id,
      label.id,
      fixture.creator.id,
    );
    await labelsService.addToTask(
      fixture.workspace.id,
      fixture.project.id,
      fixture.task.id,
      label.id,
      fixture.creator.id,
    );
    await labelsService.removeFromTask(
      fixture.workspace.id,
      fixture.project.id,
      fixture.task.id,
      label.id,
      fixture.creator.id,
    );
    await labelsService.removeFromTask(
      fixture.workspace.id,
      fixture.project.id,
      fixture.task.id,
      label.id,
      fixture.creator.id,
    );
    expect(
      await prisma.taskLabel.count({
        where: { workspaceId: fixture.workspace.id, taskId: fixture.task.id },
      }),
    ).toBe(0);
    expect(
      await prisma.taskActivity.count({
        where: {
          taskId: fixture.task.id,
          type: {
            in: [TaskActivityType.LABEL_ADDED, TaskActivityType.LABEL_REMOVED],
          },
        },
      }),
    ).toBe(2);

    await expect(
      labelsService.addToTask(
        fixture.workspace.id,
        fixture.project.id,
        fixture.task.id,
        foreignLabel.id,
        fixture.creator.id,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectNestStatus(error, 404);
      return true;
    });

    const filterLabel = await labelsService.create(
      fixture.workspace.id,
      fixture.creator.id,
      { name: 'Filter', color: '#334455' },
    );
    const taskA = await tasksService.create(
      fixture.workspace.id,
      fixture.project.id,
      fixture.creator.id,
      { title: 'Filter A' },
    );
    const taskB = await tasksService.create(
      fixture.workspace.id,
      fixture.project.id,
      fixture.creator.id,
      { title: 'Filter B' },
    );
    await labelsService.addToTask(
      fixture.workspace.id,
      fixture.project.id,
      taskA.id,
      filterLabel.id,
      fixture.creator.id,
    );
    await labelsService.addToTask(
      fixture.workspace.id,
      fixture.project.id,
      taskB.id,
      filterLabel.id,
      fixture.creator.id,
    );
    const filtered = await tasksService.findAll(
      fixture.workspace.id,
      fixture.project.id,
      fixture.creator.id,
      { labelIds: [filterLabel.id, filterLabel.id], limit: 1 },
    );
    expect(filtered.items).toHaveLength(1);
    expect(filtered.nextCursor).toEqual(expect.any(String));
    const filteredNext = await tasksService.findAll(
      fixture.workspace.id,
      fixture.project.id,
      fixture.creator.id,
      { labelIds: [filterLabel.id], limit: 1, cursor: filtered.nextCursor! },
    );
    expect(
      new Set([...filtered.items, ...filteredNext.items].map((item) => item.id))
        .size,
    ).toBe(2);

    await tasksService.archive(
      fixture.workspace.id,
      fixture.project.id,
      fixture.task.id,
      fixture.creator.id,
    );
    await expect(
      labelsService.addToTask(
        fixture.workspace.id,
        fixture.project.id,
        fixture.task.id,
        filterLabel.id,
        fixture.creator.id,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectNestStatus(error, 409);
      return true;
    });
  });

  it('blocks legacy-equivalent label names while preserving workspace isolation', async () => {
    const fixture = await createFixture('legacy-labels');
    const foreign = await createFixture('legacy-labels-foreign');
    const legacy = await prisma.label.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: 'Straße',
        nameKey: 'straße',
        color: '#ABCDEF',
      },
    });
    const target = await prisma.label.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: 'Target',
        nameKey: 'target',
        color: '#ABCDEF',
      },
    });

    await expect(
      labelsService.create(fixture.workspace.id, fixture.creator.id, {
        name: 'STRASSE',
        color: '#FFFFFF',
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectNestStatus(error, 409);
      return true;
    });
    await expect(
      labelsService.update(
        fixture.workspace.id,
        target.id,
        fixture.creator.id,
        { name: 'STRASSE' },
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectNestStatus(error, 409);
      return true;
    });

    await prisma.label.update({
      where: {
        workspaceId_id: { workspaceId: fixture.workspace.id, id: legacy.id },
      },
      data: { name: 'École', nameKey: 'école' },
    });
    await expect(
      labelsService.update(
        fixture.workspace.id,
        target.id,
        fixture.creator.id,
        { name: 'école' },
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectNestStatus(error, 409);
      return true;
    });

    const foreignLabel = await labelsService.create(
      foreign.workspace.id,
      foreign.creator.id,
      { name: 'STRASSE', color: '#FFFFFF' },
    );
    expect(foreignLabel.name).toBe('STRASSE');
  });

  it('serializes concurrent equivalent creates within one workspace', async () => {
    const fixture = await createFixture('label-concurrency');
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        labelsService.create(fixture.workspace.id, fixture.creator.id, {
          name: index % 2 === 0 ? 'Straße' : 'STRASSE',
          color: '#FFFFFF',
        }),
      ),
    );

    expect(
      attempts.filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === 'rejected')).toSatisfy(
      (rejected: PromiseRejectedResult[]) => {
        rejected.forEach(({ reason }) => expectNestStatus(reason, 409));
        return true;
      },
    );

    const labels = await prisma.label.findMany({
      where: { workspaceId: fixture.workspace.id },
      select: { name: true },
    });
    expect(labels).toHaveLength(1);
    expect(normalizeLabelNameKey(labels[0]!.name)).toBe('strasse');
  });

  it('serializes concurrent create and update of equivalent names', async () => {
    const fixture = await createFixture('label-create-update-concurrency');
    const target = await labelsService.create(
      fixture.workspace.id,
      fixture.creator.id,
      { name: 'Target', color: '#FFFFFF' },
    );

    const attempts = await Promise.allSettled([
      labelsService.create(fixture.workspace.id, fixture.creator.id, {
        name: 'Straße',
        color: '#FFFFFF',
      }),
      labelsService.update(
        fixture.workspace.id,
        target.id,
        fixture.creator.id,
        { name: 'STRASSE' },
      ),
    ]);

    expect(
      attempts.filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === 'rejected')).toSatisfy(
      (rejected: PromiseRejectedResult[]) => {
        rejected.forEach(({ reason }) => expectNestStatus(reason, 409));
        return true;
      },
    );

    const labels = await prisma.label.findMany({
      where: { workspaceId: fixture.workspace.id },
      select: { name: true },
    });
    expect(
      labels.filter(({ name }) => normalizeLabelNameKey(name) === 'strasse'),
    ).toHaveLength(1);
  });

  it.each([999, 1_000, 1_001])(
    'enforces the bounded label scan for a workspace with %s labels',
    async (labelCount) => {
      const fixture = await createFixture(`label-limit-${labelCount}`);
      const targetId = randomUUID();

      await prisma.label.createMany({
        data: Array.from({ length: labelCount }, (_, index) => ({
          id: index === 0 ? targetId : randomUUID(),
          workspaceId: fixture.workspace.id,
          name:
            index === 0
              ? `Target ${labelCount}`
              : `Label ${labelCount}-${index}`,
          nameKey:
            index === 0
              ? `target-${labelCount}`
              : `label-${labelCount}-${index}`,
          color: '#ABCDEF',
        })),
      });

      const before = await prisma.label.findUniqueOrThrow({
        where: {
          workspaceId_id: { workspaceId: fixture.workspace.id, id: targetId },
        },
      });

      if (labelCount <= 1_000) {
        await expect(
          labelsService.update(
            fixture.workspace.id,
            targetId,
            fixture.creator.id,
            { name: `Renamed ${labelCount}` },
          ),
        ).resolves.toMatchObject({ name: `Renamed ${labelCount}` });

        const after = await prisma.label.findUniqueOrThrow({
          where: {
            workspaceId_id: {
              workspaceId: fixture.workspace.id,
              id: targetId,
            },
          },
        });
        expect(after.name).toBe(`Renamed ${labelCount}`);
      } else {
        await expect(
          labelsService.update(
            fixture.workspace.id,
            targetId,
            fixture.creator.id,
            { name: 'Should not persist' },
          ),
        ).rejects.toSatisfy((error: unknown) => {
          expectNestStatus(error, 503);
          return true;
        });

        await expect(
          labelsService.create(fixture.workspace.id, fixture.creator.id, {
            name: 'Should also fail',
            color: '#FFFFFF',
          }),
        ).rejects.toSatisfy((error: unknown) => {
          expectNestStatus(error, 503);
          return true;
        });

        const after = await prisma.label.findUniqueOrThrow({
          where: {
            workspaceId_id: {
              workspaceId: fixture.workspace.id,
              id: targetId,
            },
          },
        });
        expect(after).toMatchObject({
          name: before.name,
          nameKey: before.nameKey,
          color: before.color,
          updatedAt: before.updatedAt,
        });

        const page = await labelsService.findAll(
          fixture.workspace.id,
          fixture.creator.id,
          { limit: 50 },
        );
        expect(page.items).toHaveLength(50);
        expect(page.nextCursor).toEqual(expect.any(String));
      }
    },
    30_000,
  );

  it('fans out label deletion activity across active and archived tasks', async () => {
    const fixture = await createFixture('label-delete');
    const secondTask = await tasksService.create(
      fixture.workspace.id,
      fixture.project.id,
      fixture.creator.id,
      { title: 'Archived label task' },
    );
    const label = await labelsService.create(
      fixture.workspace.id,
      fixture.creator.id,
      { name: 'Release', color: '#ABCDEF' },
    );
    const unused = await labelsService.create(
      fixture.workspace.id,
      fixture.creator.id,
      { name: 'Unused', color: '#123456' },
    );

    await labelsService.addToTask(
      fixture.workspace.id,
      fixture.project.id,
      fixture.task.id,
      label.id,
      fixture.creator.id,
    );
    await labelsService.addToTask(
      fixture.workspace.id,
      fixture.project.id,
      secondTask.id,
      label.id,
      fixture.creator.id,
    );
    await tasksService.archive(
      fixture.workspace.id,
      fixture.project.id,
      secondTask.id,
      fixture.creator.id,
    );

    await labelsService.remove(
      fixture.workspace.id,
      label.id,
      fixture.creator.id,
    );

    await expect(
      prisma.label.findUnique({ where: { id: label.id } }),
    ).resolves.toBeNull();
    await expect(
      prisma.taskLabel.count({ where: { labelId: label.id } }),
    ).resolves.toBe(0);

    for (const taskId of [fixture.task.id, secondTask.id]) {
      const events = await prisma.taskActivity.findMany({
        where: { taskId, type: TaskActivityType.LABEL_REMOVED },
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toEqual({
        schemaVersion: 1,
        entity: 'label',
        snapshot: { labelId: label.id, name: 'Release', color: '#ABCDEF' },
      });
    }

    await labelsService.remove(
      fixture.workspace.id,
      unused.id,
      fixture.creator.id,
    );
    await expect(
      prisma.taskActivity.count({
        where: {
          type: TaskActivityType.LABEL_REMOVED,
          payload: { path: ['snapshot', 'labelId'], equals: unused.id },
        },
      }),
    ).resolves.toBe(0);

    await expect(
      labelsService.remove(fixture.workspace.id, label.id, fixture.creator.id),
    ).rejects.toSatisfy((error: unknown) => {
      expectNestStatus(error, 404);
      return true;
    });
  });

  it('writes all eleven activity contracts, ordering, pagination, no-op behavior, and safe payloads', async () => {
    const fixture = await createFixture('activity-service');
    const initialDescription = 'initial task description secret';
    const updatedDescription = 'updated task description secret';
    const assignee = await createUser('activity-assignee');
    await addMember(fixture.workspace.id, assignee.id);
    const label = await labelsService.create(
      fixture.workspace.id,
      fixture.creator.id,
      { name: 'Activity', color: '#ABCDEF' },
    );

    const created = await tasksService.create(
      fixture.workspace.id,
      fixture.project.id,
      fixture.creator.id,
      { title: 'Activity task', description: initialDescription },
    );
    await tasksService.update(
      fixture.workspace.id,
      fixture.project.id,
      created.id,
      fixture.creator.id,
      { title: 'Activity task updated', description: updatedDescription },
    );
    await tasksService.updateStatus(
      fixture.workspace.id,
      fixture.project.id,
      created.id,
      fixture.creator.id,
      { status: TaskStatus.IN_PROGRESS },
    );
    await tasksService.update(
      fixture.workspace.id,
      fixture.project.id,
      created.id,
      fixture.creator.id,
      { priority: TaskPriority.HIGH },
    );
    await tasksService.assign(
      fixture.workspace.id,
      fixture.project.id,
      created.id,
      fixture.creator.id,
      { assigneeId: assignee.id },
    );
    const comment = await taskCommentsService.create(
      fixture.workspace.id,
      fixture.project.id,
      created.id,
      authUser(fixture.creator),
      { content: 'activity comment' },
    );
    await taskCommentsService.update(
      fixture.workspace.id,
      fixture.project.id,
      created.id,
      comment.id,
      fixture.creator.id,
      { content: 'updated comment' },
    );
    await taskCommentsService.remove(
      fixture.workspace.id,
      fixture.project.id,
      created.id,
      comment.id,
      fixture.creator.id,
    );
    await labelsService.addToTask(
      fixture.workspace.id,
      fixture.project.id,
      created.id,
      label.id,
      fixture.creator.id,
    );
    await labelsService.removeFromTask(
      fixture.workspace.id,
      fixture.project.id,
      created.id,
      label.id,
      fixture.creator.id,
    );
    await tasksService.archive(
      fixture.workspace.id,
      fixture.project.id,
      created.id,
      fixture.creator.id,
    );

    const beforeNoop = await prisma.taskActivity.count({
      where: { taskId: created.id },
    });
    await tasksService
      .update(
        fixture.workspace.id,
        fixture.project.id,
        created.id,
        fixture.creator.id,
        { title: 'Activity task updated' },
      )
      .catch(() => undefined);
    const afterNoop = await prisma.taskActivity.count({
      where: { taskId: created.id },
    });
    expect(afterNoop).toBe(beforeNoop);

    const rows = await activityRows(created.id);
    expect(new Set(rows.map((row) => row.type))).toEqual(
      new Set([
        TaskActivityType.TASK_CREATED,
        TaskActivityType.TASK_UPDATED,
        TaskActivityType.TASK_STATUS_CHANGED,
        TaskActivityType.TASK_PRIORITY_CHANGED,
        TaskActivityType.TASK_ASSIGNEE_CHANGED,
        TaskActivityType.TASK_ARCHIVED,
        TaskActivityType.COMMENT_CREATED,
        TaskActivityType.COMMENT_UPDATED,
        TaskActivityType.COMMENT_DELETED,
        TaskActivityType.LABEL_ADDED,
        TaskActivityType.LABEL_REMOVED,
      ]),
    );
    expect(rows.every((row) => row.workspaceId === fixture.workspace.id)).toBe(
      true,
    );
    expect(rows.every((row) => row.actorId === fixture.creator.id)).toBe(true);
    for (const row of rows) {
      expect(row.eventVersion).toBe(1);
      expect(row.payload).toHaveProperty('schemaVersion', 1);
      expect(JSON.stringify(row.payload)).not.toMatch(
        /password|passwordHash|session|refreshToken|email|jwt/i,
      );
    }
    const taskUpdated = rows.find(
      (row) => row.type === TaskActivityType.TASK_UPDATED,
    );
    expect(taskUpdated?.payload).toMatchObject({
      changes: { descriptionChanged: true },
    });
    expect(taskUpdated?.payload).not.toHaveProperty('changes.description');
    expect(JSON.stringify(rows)).not.toContain(initialDescription);
    expect(JSON.stringify(rows)).not.toContain(updatedDescription);

    const firstPage = await taskActivityService.findAll(
      fixture.workspace.id,
      fixture.project.id,
      created.id,
      fixture.creator.id,
      { limit: 4 },
    );
    expect(firstPage.items).toHaveLength(4);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const secondPage = await taskActivityService.findAll(
      fixture.workspace.id,
      fixture.project.id,
      created.id,
      fixture.creator.id,
      { limit: 20, cursor: firstPage.nextCursor! },
    );
    expect(
      new Set([...firstPage.items, ...secondPage.items].map((item) => item.id))
        .size,
    ).toBe(rows.length);

    const foreign = await createFixture('activity-foreign');
    await expect(
      taskActivityService.findAll(
        fixture.workspace.id,
        foreign.project.id,
        foreign.task.id,
        fixture.creator.id,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectNestStatus(error, 404);
      return true;
    });
  });

  it('rolls back business mutations when business or activity writes fail', async () => {
    const fixture = await createFixture('atomicity');
    const originalTitle = fixture.task.title;

    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.task.update({
          where: { id: fixture.task.id },
          data: { title: 'rolled back before activity' },
        });
        throw new Error('business mutation failed');
      }),
    ).rejects.toThrow('business mutation failed');
    await expect(
      prisma.task.findUnique({ where: { id: fixture.task.id } }),
    ).resolves.toMatchObject({ title: originalTitle });
    await expect(
      prisma.taskActivity.count({ where: { taskId: fixture.task.id } }),
    ).resolves.toBe(0);

    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.task.update({
          where: { id: fixture.task.id },
          data: { title: 'rolled back after activity failure' },
        });
        await transaction.taskActivity.create({
          data: {
            workspaceId: fixture.workspace.id,
            taskId: fixture.task.id,
            actorId: fixture.creator.id,
            type: TaskActivityType.TASK_UPDATED,
            payload: { entity: 'task' },
          },
        });
      }),
    ).rejects.toMatchObject({ code: 'P2039' });
    await expect(
      prisma.task.findUnique({ where: { id: fixture.task.id } }),
    ).resolves.toMatchObject({ title: originalTitle });
    await expect(
      prisma.taskActivity.count({ where: { taskId: fixture.task.id } }),
    ).resolves.toBe(0);
  });

  it('handles concurrent serializable status and label mutations without duplicate committed events', async () => {
    const fixture = await createFixture('concurrency');
    const admin = await createUser('concurrency-admin');
    await addMember(fixture.workspace.id, admin.id, WorkspaceRole.ADMIN);
    const label = await labelsService.create(
      fixture.workspace.id,
      fixture.creator.id,
      { name: 'Concurrent', color: '#123456' },
    );

    const statusResults = await Promise.allSettled([
      tasksService.updateStatus(
        fixture.workspace.id,
        fixture.project.id,
        fixture.task.id,
        fixture.creator.id,
        { status: TaskStatus.DONE },
      ),
      tasksService.updateStatus(
        fixture.workspace.id,
        fixture.project.id,
        fixture.task.id,
        admin.id,
        { status: TaskStatus.DONE },
      ),
    ]);
    for (const result of statusResults) {
      if (result.status === 'rejected') {
        expectNestStatus(result.reason, 503);
      }
    }

    const labelResults = await Promise.allSettled([
      labelsService.addToTask(
        fixture.workspace.id,
        fixture.project.id,
        fixture.task.id,
        label.id,
        fixture.creator.id,
      ),
      labelsService.addToTask(
        fixture.workspace.id,
        fixture.project.id,
        fixture.task.id,
        label.id,
        admin.id,
      ),
    ]);
    for (const result of labelResults) {
      if (result.status === 'rejected') {
        expectNestStatus(result.reason, 503);
      }
    }

    await expect(
      prisma.task.findUnique({ where: { id: fixture.task.id } }),
    ).resolves.toMatchObject({ status: TaskStatus.DONE });
    await expect(
      prisma.taskLabel.count({
        where: {
          workspaceId: fixture.workspace.id,
          taskId: fixture.task.id,
          labelId: label.id,
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.taskActivity.count({
        where: {
          taskId: fixture.task.id,
          type: TaskActivityType.LABEL_ADDED,
        },
      }),
    ).resolves.toBe(1);
    const statusEvents = await prisma.taskActivity.findMany({
      where: {
        taskId: fixture.task.id,
        type: TaskActivityType.TASK_STATUS_CHANGED,
      },
    });
    expect(statusEvents.length).toBeLessThanOrEqual(1);
    expect(statusEvents.every((event) => event.payload)).toBe(true);
  });

  it('does not trust caller actor or author fields and preserves atomic membership revoke outcomes', async () => {
    const fixture = await createFixture('security');
    const member = await createUser('security-member');
    await addMember(fixture.workspace.id, member.id);
    const foreign = await createFixture('security-foreign');

    const comment = await taskCommentsService.create(
      fixture.workspace.id,
      fixture.project.id,
      fixture.task.id,
      authUser(fixture.creator),
      {
        content: 'safe',
        authorId: member.id,
        actorId: member.id,
      } as { content: string },
    );
    expect(comment.author.id).toBe(fixture.creator.id);
    const event = await prisma.taskActivity.findFirstOrThrow({
      where: {
        taskId: fixture.task.id,
        type: TaskActivityType.COMMENT_CREATED,
      },
    });
    expect(event.actorId).toBe(fixture.creator.id);
    expect(JSON.stringify(event.payload)).not.toContain(member.email);

    await expect(
      taskCommentsService.findAll(
        foreign.workspace.id,
        foreign.project.id,
        foreign.task.id,
        fixture.creator.id,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectNestStatus(error, 404);
      return true;
    });

    const membership = await prisma.workspaceMember.findUniqueOrThrow({
      where: {
        workspaceId_userId: {
          workspaceId: fixture.workspace.id,
          userId: member.id,
        },
      },
    });
    const revoke = prisma.workspaceMember.delete({
      where: { id: membership.id },
    });
    const concurrentWrite = taskCommentsService.create(
      fixture.workspace.id,
      fixture.project.id,
      fixture.task.id,
      authUser(member),
      { content: 'revoke race' },
    );
    const [revokeResult, writeResult] = await Promise.allSettled([
      revoke,
      concurrentWrite,
    ]);
    expect(revokeResult.status).toBe('fulfilled');
    if (writeResult.status === 'rejected') {
      expectNestStatus(writeResult.reason, 404);
    }
    const racedComments = await prisma.taskComment.findMany({
      where: { taskId: fixture.task.id, authorId: member.id },
    });
    const racedEvents = await prisma.taskActivity.findMany({
      where: {
        taskId: fixture.task.id,
        type: TaskActivityType.COMMENT_CREATED,
        actorId: member.id,
      },
    });
    expect(racedEvents.length).toBe(racedComments.length);
  });
});
