import { randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';

import {
  PrismaClient,
  TaskPriority,
  TaskStatus,
  WorkspaceRole,
} from '../src/generated/prisma/client';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe('Projects and Tasks PostgreSQL integrity', () => {
  let prisma: PrismaClient;
  const workspaceIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    const parsed = new URL(databaseUrl!);
    const name = decodeURIComponent(parsed.pathname.slice(1));
    if (
      !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) ||
      !name.endsWith('_test')
    ) {
      throw new Error(
        'TEST_DATABASE_URL must point to a local database ending in _test',
      );
    }

    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
    });
    await prisma.$connect();
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

  async function createWorkspace(
    members: Array<{ userId: string; role: WorkspaceRole }>,
  ) {
    const workspace = await prisma.workspace.create({
      data: {
        name: `Workspace ${randomUUID()}`,
        slug: `workspace-${randomUUID()}`,
        members: { create: members },
      },
    });
    workspaceIds.push(workspace.id);
    return workspace;
  }

  async function createProject(workspaceId: string, key = 'FLOW') {
    return prisma.project.create({
      data: {
        workspaceId,
        name: `Project ${key}`,
        key,
      },
    });
  }

  async function createTask(
    workspaceId: string,
    projectId: string,
    creatorId: string,
    sequence = 1,
    assigneeMemberId?: string,
  ) {
    return prisma.task.create({
      data: {
        workspaceId,
        projectId,
        sequence,
        title: `Task ${sequence}`,
        creatorId,
        assigneeMemberId,
        status: TaskStatus.TODO,
        priority: TaskPriority.MEDIUM,
      },
    });
  }

  it('creates a project and task with defaults and relations', async () => {
    const creator = await createUser('creator');
    const workspace = await createWorkspace([
      { userId: creator.id, role: WorkspaceRole.OWNER },
    ]);
    const project = await createProject(workspace.id);
    const task = await createTask(workspace.id, project.id, creator.id);

    expect(project.nextTaskSequence).toBe(1);
    expect(task).toMatchObject({
      workspaceId: workspace.id,
      projectId: project.id,
      sequence: 1,
      status: TaskStatus.TODO,
      priority: TaskPriority.MEDIUM,
    });
  });

  it('enforces composite project and assignee foreign keys', async () => {
    const creatorA = await createUser('creator-a');
    const creatorB = await createUser('creator-b');
    const assigneeB = await createUser('assignee-b');
    const workspaceA = await createWorkspace([
      { userId: creatorA.id, role: WorkspaceRole.OWNER },
    ]);
    const workspaceB = await createWorkspace([
      { userId: creatorB.id, role: WorkspaceRole.OWNER },
      { userId: assigneeB.id, role: WorkspaceRole.MEMBER },
    ]);
    const projectA = await createProject(workspaceA.id, 'AAPP');
    const memberB = await prisma.workspaceMember.findUniqueOrThrow({
      where: {
        workspaceId_userId: {
          workspaceId: workspaceB.id,
          userId: assigneeB.id,
        },
      },
    });

    await expect(
      createTask(workspaceB.id, projectA.id, creatorB.id),
    ).rejects.toMatchObject({
      code: 'P2003',
    });

    const projectB = await createProject(workspaceB.id, 'BAPP');
    await expect(
      createTask(workspaceA.id, projectB.id, creatorA.id, 1, memberB.id),
    ).rejects.toMatchObject({
      code: 'P2003',
    });
  });

  it('enforces project key, sequence, and positive-value checks', async () => {
    const creator = await createUser('constraints');
    const workspace = await createWorkspace([
      { userId: creator.id, role: WorkspaceRole.OWNER },
    ]);
    const project = await createProject(workspace.id, 'TASK');

    await expect(createProject(workspace.id, 'TASK')).rejects.toMatchObject({
      code: 'P2002',
    });
    await expect(createProject(workspace.id, 'task')).rejects.toMatchObject({
      code: 'P2039',
    });
    await expect(
      prisma.project.create({
        data: {
          workspaceId: workspace.id,
          name: 'Invalid sequence',
          key: 'ZERO',
          nextTaskSequence: 0,
        },
      }),
    ).rejects.toMatchObject({
      code: 'P2039',
    });
    await expect(
      createTask(workspace.id, project.id, creator.id, 0),
    ).rejects.toMatchObject({
      code: 'P2039',
    });
    await createTask(workspace.id, project.id, creator.id, 1);
    await expect(
      createTask(workspace.id, project.id, creator.id, 1),
    ).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('rejects a task with a missing creator', async () => {
    const workspace = await createWorkspace([]);
    const project = await createProject(workspace.id, 'AUTH');

    await expect(
      createTask(workspace.id, project.id, randomUUID()),
    ).rejects.toMatchObject({
      code: 'P2003',
    });
  });

  it('cascades projects and tasks when a workspace is deleted', async () => {
    const creator = await createUser('cascade');
    const workspace = await createWorkspace([
      { userId: creator.id, role: WorkspaceRole.OWNER },
    ]);
    const project = await createProject(workspace.id, 'CASC');
    const task = await createTask(workspace.id, project.id, creator.id);

    await prisma.workspace.delete({ where: { id: workspace.id } });
    workspaceIds.splice(workspaceIds.indexOf(workspace.id), 1);

    await expect(
      prisma.project.findUnique({ where: { id: project.id } }),
    ).resolves.toBeNull();
    await expect(
      prisma.task.findUnique({ where: { id: task.id } }),
    ).resolves.toBeNull();
  });

  it('restricts member deletion while tasks remain assigned', async () => {
    const creator = await createUser('assigned-creator');
    const assignee = await createUser('assigned-member');
    const workspace = await createWorkspace([
      { userId: creator.id, role: WorkspaceRole.OWNER },
      { userId: assignee.id, role: WorkspaceRole.MEMBER },
    ]);
    const member = await prisma.workspaceMember.findUniqueOrThrow({
      where: {
        workspaceId_userId: {
          workspaceId: workspace.id,
          userId: assignee.id,
        },
      },
    });
    const project = await createProject(workspace.id, 'MEMB');
    const task = await createTask(
      workspace.id,
      project.id,
      creator.id,
      1,
      member.id,
    );

    await expect(
      prisma.workspaceMember.delete({ where: { id: member.id } }),
    ).rejects.toMatchObject({
      code: 'P2003',
    });

    await prisma.task.update({
      where: { id: task.id },
      data: { assigneeMemberId: null },
    });
    await expect(
      prisma.workspaceMember.delete({ where: { id: member.id } }),
    ).resolves.toMatchObject({ id: member.id });
  });
});
