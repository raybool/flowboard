import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  Prisma,
  PrismaClient,
  TaskPriority,
  TaskStatus,
  WorkspaceRole,
} from '../src/generated/prisma/client';

import type { PrismaService } from '../src/database/prisma.service';
import { runSerializableTransaction } from '../src/database/serializable-transaction';
import { ProjectsService } from '../src/modules/projects/projects.service';
import { ActivityWriterService } from '../src/modules/task-activity/task-activity.writer';
import { TasksService } from '../src/modules/tasks/tasks.service';
import { WorkspaceMembersService } from '../src/modules/workspaces/workspace-members.service';
import { WorkspacesService } from '../src/modules/workspaces/workspaces.service';

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    'TEST_DATABASE_URL is required for the Projects and Tasks PostgreSQL integration suite',
  );
}

function assertTestDatabase(url: string): void {
  const parsed = new URL(url);
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));

  if (
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) ||
    !databaseName.endsWith('_test')
  ) {
    throw new Error(
      'TEST_DATABASE_URL must point to a local database ending in _test',
    );
  }
}

type FixtureUser = { id: string; email: string };

type ExplainRow = { 'QUERY PLAN': unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectPlanDiagnostics(node: Record<string, unknown>): {
  nodeTypes: string[];
  indexNames: string[];
} {
  const nodeTypes =
    typeof node['Node Type'] === 'string' ? [node['Node Type']] : [];
  const indexNames =
    typeof node['Index Name'] === 'string' ? [node['Index Name']] : [];

  if (Array.isArray(node.Plans)) {
    for (const child of node.Plans) {
      if (isRecord(child)) {
        const childDiagnostics = collectPlanDiagnostics(child);
        nodeTypes.push(...childDiagnostics.nodeTypes);
        indexNames.push(...childDiagnostics.indexNames);
      }
    }
  }

  return { nodeTypes, indexNames };
}

function analyseExplainPlan(
  rows: ExplainRow[],
  label: string,
): {
  nodeTypes: string[];
  indexNames: string[];
  planningTime: number;
  executionTime: number;
} {
  expect(rows).toHaveLength(1);
  const rawQueryPlan = rows[0]?.['QUERY PLAN'];
  const queryPlan =
    typeof rawQueryPlan === 'string' ? JSON.parse(rawQueryPlan) : rawQueryPlan;

  if (!Array.isArray(queryPlan) || queryPlan.length !== 1) {
    throw new Error(`${label}: expected one JSON EXPLAIN document`);
  }

  const document = queryPlan[0];
  if (
    !isRecord(document) ||
    !isRecord(document.Plan) ||
    typeof document['Planning Time'] !== 'number' ||
    typeof document['Execution Time'] !== 'number'
  ) {
    throw new Error(`${label}: invalid JSON EXPLAIN document`);
  }

  const diagnostics = collectPlanDiagnostics(document.Plan);
  if (diagnostics.nodeTypes.length === 0) {
    throw new Error(`${label}: EXPLAIN document has no plan nodes`);
  }

  return {
    ...diagnostics,
    planningTime: document['Planning Time'],
    executionTime: document['Execution Time'],
  };
}

describe('Projects and Tasks service PostgreSQL integration', () => {
  let prisma: PrismaClient;
  let workspaceMembersService: WorkspaceMembersService;
  let workspacesService: WorkspacesService;
  let projectsService: ProjectsService;
  let tasksService: TasksService;
  const workspaceIds = new Set<string>();
  const userIds = new Set<string>();

  beforeAll(async () => {
    assertTestDatabase(databaseUrl);
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
    });
    await prisma.$connect();

    const prismaService = prisma as unknown as PrismaService;
    workspaceMembersService = new WorkspaceMembersService(prismaService);
    workspacesService = new WorkspacesService(
      prismaService,
      workspaceMembersService,
    );
    projectsService = new ProjectsService(
      prismaService,
      workspaceMembersService,
    );
    tasksService = new TasksService(
      prismaService,
      workspaceMembersService,
      new ActivityWriterService(),
    );
  });

  afterEach(async () => {
    if (workspaceIds.size > 0) {
      await prisma.workspace.deleteMany({
        where: { id: { in: [...workspaceIds] } },
      });
      workspaceIds.clear();
    }
  });

  afterAll(async () => {
    if (userIds.size > 0) {
      await prisma.user.deleteMany({ where: { id: { in: [...userIds] } } });
    }
    await prisma?.$disconnect();
  });

  async function createUser(label: string): Promise<FixtureUser> {
    const id = randomUUID();
    const email = `${label}-${id}@example.test`;
    userIds.add(id);
    return prisma.user.create({
      data: { id, email, name: label, passwordHash: 'fixture' },
      select: { id: true, email: true },
    });
  }

  async function createWorkspace(
    members: Array<{ userId: string; role: WorkspaceRole }>,
  ) {
    const workspace = await prisma.workspace.create({
      data: {
        name: `Integration ${randomUUID()}`,
        slug: `integration-${randomUUID()}`,
        members: { create: members },
      },
    });
    workspaceIds.add(workspace.id);
    return workspace;
  }

  async function membership(workspaceId: string, userId: string) {
    return prisma.workspaceMember.findUniqueOrThrow({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
  }

  async function createProject(
    workspaceId: string,
    userId: string,
    key: string,
  ) {
    return projectsService.create(workspaceId, userId, {
      name: `Project ${key}`,
      key,
    });
  }

  async function createTask(
    workspaceId: string,
    projectId: string,
    userId: string,
    title: string,
    options: {
      assigneeId?: string;
      priority?: TaskPriority;
    } = {},
  ) {
    return tasksService.create(workspaceId, projectId, userId, {
      title,
      ...options,
    });
  }

  function expectExpectedConcurrencyFailure(reason: unknown): void {
    expect(reason).toBeInstanceOf(ServiceUnavailableException);
    expect((reason as ServiceUnavailableException).getStatus()).toBe(503);
  }

  it('enforces project roles, workspace isolation, archive rules, and revocation', async () => {
    const owner = await createUser('project-owner');
    const admin = await createUser('project-admin');
    const member = await createUser('project-member');
    const outsider = await createUser('project-outsider');
    const otherWorkspaceOwner = await createUser('project-other-owner');
    const workspace = await createWorkspace([
      { userId: owner.id, role: WorkspaceRole.OWNER },
      { userId: admin.id, role: WorkspaceRole.ADMIN },
      { userId: member.id, role: WorkspaceRole.MEMBER },
    ]);
    const otherWorkspace = await createWorkspace([
      { userId: otherWorkspaceOwner.id, role: WorkspaceRole.OWNER },
    ]);

    const ownerProject = await createProject(workspace.id, owner.id, 'OWN');
    const adminProject = await createProject(workspace.id, admin.id, 'ADM');
    const sameKeyOtherWorkspace = await createProject(
      otherWorkspace.id,
      otherWorkspaceOwner.id,
      'OWN',
    );

    expect(ownerProject.workspaceId).toBe(workspace.id);
    expect(adminProject.workspaceId).toBe(workspace.id);
    expect(sameKeyOtherWorkspace.key).toBe(ownerProject.key);
    await expect(
      createProject(workspace.id, owner.id, 'OWN'),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      createProject(workspace.id, member.id, 'MEM'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await expect(
      projectsService.findOne(
        otherWorkspace.id,
        ownerProject.id,
        otherWorkspaceOwner.id,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      projectsService.update(
        otherWorkspace.id,
        ownerProject.id,
        otherWorkspaceOwner.id,
        {
          name: 'Should not update',
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    await projectsService.archive(workspace.id, ownerProject.id, owner.id);
    await expect(
      projectsService.archive(workspace.id, ownerProject.id, owner.id),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      projectsService.update(workspace.id, ownerProject.id, owner.id, {
        name: 'Archived update',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    const regularProjects = await projectsService.findAll(
      workspace.id,
      member.id,
    );
    expect(regularProjects.items.map((project) => project.id)).not.toContain(
      ownerProject.id,
    );
    const archivedProjects = await projectsService.findAll(
      workspace.id,
      member.id,
      {
        includeArchived: true,
      },
    );
    expect(archivedProjects.items.map((project) => project.id)).toContain(
      ownerProject.id,
    );

    const memberRecord = await membership(workspace.id, member.id);
    await workspacesService.removeMember(
      workspace.id,
      owner.id,
      memberRecord.id,
    );
    await expect(
      projectsService.findAll(workspace.id, member.id),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      projectsService.findOne(workspace.id, adminProject.id, member.id),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      projectsService.findAll(workspace.id, outsider.id),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not leave a project after a failed transactional write', async () => {
    const owner = await createUser('project-rollback-owner');
    const workspace = await createWorkspace([
      { userId: owner.id, role: WorkspaceRole.OWNER },
    ]);
    await createProject(workspace.id, owner.id, 'ROLL');

    await expect(
      createProject(workspace.id, owner.id, 'ROLL'),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      prisma.project.count({ where: { workspaceId: workspace.id } }),
    ).resolves.toBe(1);
  });

  it('enforces task creation, assignment, RBAC, project scope, and archive rules', async () => {
    const owner = await createUser('task-owner');
    const admin = await createUser('task-admin');
    const creator = await createUser('task-creator');
    const assignee = await createUser('task-assignee');
    const otherMember = await createUser('task-other-member');
    const outsider = await createUser('task-outsider');
    const otherWorkspaceOwner = await createUser('task-other-owner');
    const workspace = await createWorkspace([
      { userId: owner.id, role: WorkspaceRole.OWNER },
      { userId: admin.id, role: WorkspaceRole.ADMIN },
      { userId: creator.id, role: WorkspaceRole.MEMBER },
      { userId: assignee.id, role: WorkspaceRole.MEMBER },
      { userId: otherMember.id, role: WorkspaceRole.MEMBER },
    ]);
    const otherWorkspace = await createWorkspace([
      { userId: otherWorkspaceOwner.id, role: WorkspaceRole.OWNER },
    ]);
    const project = await createProject(workspace.id, owner.id, 'TASK');
    const otherProject = await createProject(
      otherWorkspace.id,
      otherWorkspaceOwner.id,
      'TASK',
    );

    const task = await createTask(
      workspace.id,
      project.id,
      creator.id,
      'Owned',
      {
        assigneeId: assignee.id,
        priority: TaskPriority.HIGH,
      },
    );
    expect(task).toMatchObject({
      creatorId: creator.id,
      assigneeMemberId: (await membership(workspace.id, assignee.id)).id,
      taskNumber: 'TASK-1',
    });

    await expect(
      createTask(workspace.id, otherProject.id, creator.id, 'Cross project'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      createTask(
        workspace.id,
        project.id,
        creator.id,
        'Cross workspace assignment',
        {
          assigneeId: otherWorkspaceOwner.id,
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      createTask(workspace.id, project.id, outsider.id, 'Non member'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      prisma.task.count({ where: { projectId: project.id } }),
    ).resolves.toBe(1);

    await tasksService.update(workspace.id, project.id, task.id, admin.id, {
      title: 'Admin update',
    });
    await tasksService.update(workspace.id, project.id, task.id, owner.id, {
      description: 'Owner update',
    });
    await expect(
      tasksService.update(workspace.id, project.id, task.id, otherMember.id, {
        title: 'Other member update',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await tasksService.updateStatus(
      workspace.id,
      project.id,
      task.id,
      assignee.id,
      {
        status: TaskStatus.IN_PROGRESS,
      },
    );
    await tasksService.assign(workspace.id, project.id, task.id, assignee.id, {
      assigneeId: assignee.id,
    });

    const secondTask = await createTask(
      workspace.id,
      project.id,
      creator.id,
      'Second task',
    );
    await expect(
      tasksService.update(
        workspace.id,
        project.id,
        secondTask.id,
        otherMember.id,
        {
          title: 'Not allowed',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await tasksService.update(
      workspace.id,
      project.id,
      secondTask.id,
      creator.id,
      {
        title: 'Creator update',
      },
    );

    await tasksService.archive(workspace.id, project.id, task.id, admin.id);
    await expect(
      tasksService.updateStatus(workspace.id, project.id, task.id, admin.id, {
        status: TaskStatus.DONE,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      tasksService.assign(workspace.id, project.id, task.id, admin.id, {
        assigneeId: null,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      tasksService.findOne(
        otherWorkspace.id,
        otherProject.id,
        task.id,
        otherWorkspaceOwner.id,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      tasksService.findOne(workspace.id, otherProject.id, task.id, owner.id),
    ).rejects.toBeInstanceOf(NotFoundException);

    await projectsService.archive(workspace.id, project.id, owner.id);
    await expect(
      createTask(workspace.id, project.id, creator.id, 'Archived project task'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rolls back task allocation and creation when a transaction fails', async () => {
    const owner = await createUser('task-rollback-owner');
    const workspace = await createWorkspace([
      { userId: owner.id, role: WorkspaceRole.OWNER },
    ]);
    const project = await createProject(workspace.id, owner.id, 'TBCK');
    const before = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      select: { nextTaskSequence: true },
    });

    await expect(
      runSerializableTransaction(
        prisma as unknown as PrismaService,
        async (transaction) => {
          const allocated = await transaction.project.update({
            where: {
              workspaceId_id: { workspaceId: workspace.id, id: project.id },
            },
            data: { nextTaskSequence: { increment: 1 } },
          });
          await transaction.task.create({
            data: {
              workspaceId: workspace.id,
              projectId: project.id,
              sequence: allocated.nextTaskSequence - 1,
              title: 'Rolled back',
              creatorId: owner.id,
            },
          });
          throw new Error('force task rollback');
        },
      ),
    ).rejects.toThrow('force task rollback');

    await expect(
      prisma.task.count({ where: { projectId: project.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.project.findUniqueOrThrow({
        where: { id: project.id },
        select: { nextTaskSequence: true },
      }),
    ).resolves.toEqual(before);
  });

  it('allocates unique task sequences under real PostgreSQL contention', async () => {
    const owner = await createUser('concurrent-owner');
    const workspace = await createWorkspace([
      { userId: owner.id, role: WorkspaceRole.OWNER },
    ]);
    const project = await createProject(workspace.id, owner.id, 'RACE');
    const results = await Promise.allSettled(
      Array.from({ length: 16 }, (_, index) =>
        createTask(workspace.id, project.id, owner.id, `Concurrent ${index}`),
      ),
    );
    const successful = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    rejected.forEach((result) =>
      expectExpectedConcurrencyFailure(result.reason),
    );
    expect(successful.length).toBeGreaterThan(0);
    expect(new Set(successful.map((task) => task.id)).size).toBe(
      successful.length,
    );
    expect(new Set(successful.map((task) => task.sequence)).size).toBe(
      successful.length,
    );

    const persisted = await prisma.task.findMany({
      where: { projectId: project.id },
      orderBy: { sequence: 'asc' },
      select: { id: true, sequence: true },
    });
    expect(persisted).toHaveLength(successful.length);
    expect(persisted.map((task) => task.sequence)).toEqual(
      Array.from({ length: successful.length }, (_, index) => index + 1),
    );
    await expect(
      prisma.project.findUniqueOrThrow({
        where: { id: project.id },
        select: { nextTaskSequence: true },
      }),
    ).resolves.toEqual({ nextTaskSequence: successful.length + 1 });
  });

  it('removes assignments atomically and preserves task creators and other assignments', async () => {
    const owner = await createUser('remove-owner');
    const removed = await createUser('remove-member');
    const retained = await createUser('retained-member');
    const workspace = await createWorkspace([
      { userId: owner.id, role: WorkspaceRole.OWNER },
      { userId: removed.id, role: WorkspaceRole.MEMBER },
      { userId: retained.id, role: WorkspaceRole.MEMBER },
    ]);
    const project = await createProject(workspace.id, owner.id, 'RMOV');
    const removedMembership = await membership(workspace.id, removed.id);
    const retainedMembership = await membership(workspace.id, retained.id);
    const removedTask = await createTask(
      workspace.id,
      project.id,
      owner.id,
      'Removed assignment',
      { assigneeId: removed.id },
    );
    const retainedTask = await createTask(
      workspace.id,
      project.id,
      owner.id,
      'Retained assignment',
      { assigneeId: retained.id },
    );

    await workspacesService.removeMember(
      workspace.id,
      owner.id,
      removedMembership.id,
    );
    const [removedTaskAfter, retainedTaskAfter, ownerAfter] = await Promise.all(
      [
        prisma.task.findUniqueOrThrow({ where: { id: removedTask.id } }),
        prisma.task.findUniqueOrThrow({ where: { id: retainedTask.id } }),
        membership(workspace.id, owner.id),
      ],
    );
    expect(removedTaskAfter).toMatchObject({
      creatorId: owner.id,
      assigneeMemberId: null,
    });
    expect(retainedTaskAfter.assigneeMemberId).toBe(retainedMembership.id);
    expect(ownerAfter.role).toBe(WorkspaceRole.OWNER);
    await expect(
      prisma.workspaceMember.findUnique({
        where: { id: removedMembership.id },
      }),
    ).resolves.toBeNull();

    await expect(
      runSerializableTransaction(
        prisma as unknown as PrismaService,
        async (transaction) => {
          await transaction.task.updateMany({
            where: {
              id: retainedTask.id,
              assigneeMemberId: retainedMembership.id,
            },
            data: { assigneeMemberId: null },
          });
          throw new Error('force membership rollback');
        },
      ),
    ).rejects.toThrow('force membership rollback');
    await expect(
      prisma.task.findUniqueOrThrow({ where: { id: retainedTask.id } }),
    ).resolves.toMatchObject({ assigneeMemberId: retainedMembership.id });
  });

  it('keeps assignment foreign keys valid when assignment races membership removal', async () => {
    const owner = await createUser('race-remove-owner');
    const member = await createUser('race-remove-member');
    const workspace = await createWorkspace([
      { userId: owner.id, role: WorkspaceRole.OWNER },
      { userId: member.id, role: WorkspaceRole.MEMBER },
    ]);
    const project = await createProject(workspace.id, owner.id, 'RACE2');
    const task = await createTask(
      workspace.id,
      project.id,
      owner.id,
      'Assignment race',
    );
    const memberRecord = await membership(workspace.id, member.id);

    const [assignment, removal] = await Promise.allSettled([
      tasksService.assign(workspace.id, project.id, task.id, owner.id, {
        assigneeId: member.id,
      }),
      workspacesService.removeMember(workspace.id, owner.id, memberRecord.id),
    ]);
    for (const result of [assignment, removal]) {
      if (result.status === 'rejected') {
        expect(result.reason).not.toMatchObject({ code: 'P2003' });
        if (result.reason instanceof ServiceUnavailableException) {
          expect(result.reason.getStatus()).toBe(503);
        } else {
          expect(result.reason).toBeInstanceOf(NotFoundException);
        }
      }
    }

    const finalTask = await prisma.task.findUniqueOrThrow({
      where: { id: task.id },
    });
    const finalMembership = await prisma.workspaceMember.findUnique({
      where: { id: memberRecord.id },
    });
    if (!finalMembership) {
      expect(finalTask.assigneeMemberId).toBeNull();
    } else if (finalTask.assigneeMemberId !== null) {
      expect(finalTask.assigneeMemberId).toBe(finalMembership.id);
    }
    await expect(
      prisma.task.findUnique({ where: { id: task.id } }),
    ).resolves.toMatchObject({ creatorId: owner.id });
  });

  it('provides deterministic project and task cursor pages with filters and no scope leaks', async () => {
    const owner = await createUser('page-owner');
    const member = await createUser('page-member');
    const outsider = await createUser('page-outsider');
    const otherOwner = await createUser('page-other-owner');
    const workspace = await createWorkspace([
      { userId: owner.id, role: WorkspaceRole.OWNER },
      { userId: member.id, role: WorkspaceRole.MEMBER },
    ]);
    const otherWorkspace = await createWorkspace([
      { userId: otherOwner.id, role: WorkspaceRole.OWNER },
    ]);
    const fixedCreatedAt = new Date('2026-01-02T03:04:05.000Z');
    const projectKeys = ['PAGEA', 'PAGEB', 'PAGEC', 'PAGED'];
    const projects = await Promise.all(
      projectKeys.map((key) =>
        prisma.project.create({
          data: {
            workspaceId: workspace.id,
            name: key,
            key,
            createdAt: fixedCreatedAt,
          },
        }),
      ),
    );
    await prisma.project.create({
      data: {
        workspaceId: otherWorkspace.id,
        name: 'Foreign',
        key: 'PAGEA',
        createdAt: fixedCreatedAt,
      },
    });
    await projectsService.archive(workspace.id, projects[0].id, owner.id);

    const allProjectIds: string[] = [];
    let projectPage = await projectsService.findAll(workspace.id, member.id, {
      limit: 1,
    });
    while (true) {
      allProjectIds.push(...projectPage.items.map((project) => project.id));
      if (!projectPage.nextCursor) break;
      projectPage = await projectsService.findAll(workspace.id, member.id, {
        limit: 1,
        cursor: projectPage.nextCursor,
      });
    }
    expect(allProjectIds).toHaveLength(3);
    expect(new Set(allProjectIds).size).toBe(3);
    expect(allProjectIds).toEqual(
      [...projects]
        .filter((project) => project.id !== projects[0].id)
        .sort((left, right) => right.id.localeCompare(left.id))
        .map((project) => project.id),
    );
    await expect(
      projectsService.findAll(workspace.id, member.id, { cursor: 'invalid' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      projectsService.findAll(otherWorkspace.id, outsider.id, { limit: 1 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      tasksService.findAll(workspace.id, projects[2].id, owner.id, {
        limit: 1,
      }),
    ).resolves.toEqual({ items: [], nextCursor: null });

    const assigneeMembership = await membership(workspace.id, member.id);
    const taskInputs = [
      { title: 'Todo high', priority: TaskPriority.HIGH },
      { title: 'Done high', priority: TaskPriority.HIGH },
      { title: 'Done low', priority: TaskPriority.LOW },
      { title: 'Todo none', priority: TaskPriority.NONE },
    ];
    const tasks: Awaited<ReturnType<typeof createTask>>[] = [];
    for (const input of taskInputs) {
      tasks.push(
        await createTask(workspace.id, projects[1].id, owner.id, input.title, {
          priority: input.priority,
          assigneeId: member.id,
        }),
      );
    }
    await tasksService.updateStatus(
      workspace.id,
      projects[1].id,
      tasks[1].id,
      owner.id,
      { status: TaskStatus.DONE },
    );
    await tasksService.updateStatus(
      workspace.id,
      projects[1].id,
      tasks[2].id,
      owner.id,
      { status: TaskStatus.DONE },
    );
    await tasksService.archive(
      workspace.id,
      projects[1].id,
      tasks[3].id,
      owner.id,
    );
    await prisma.task.updateMany({
      where: { projectId: projects[1].id },
      data: { createdAt: fixedCreatedAt },
    });

    const filtered = await tasksService.findAll(
      workspace.id,
      projects[1].id,
      member.id,
      {
        status: TaskStatus.DONE,
        priority: TaskPriority.HIGH,
        assigneeId: member.id,
        limit: 1,
      },
    );
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]).toMatchObject({
      id: tasks[1].id,
      status: TaskStatus.DONE,
      priority: TaskPriority.HIGH,
      assigneeMemberId: assigneeMembership.id,
      taskNumber: 'PAGEB-2',
    });
    expect(filtered.nextCursor).toBeNull();

    const taskIds: string[] = [];
    let taskPage = await tasksService.findAll(
      workspace.id,
      projects[1].id,
      owner.id,
      {
        limit: 1,
      },
    );
    while (true) {
      taskIds.push(...taskPage.items.map((task) => task.id));
      if (!taskPage.nextCursor) break;
      taskPage = await tasksService.findAll(
        workspace.id,
        projects[1].id,
        owner.id,
        {
          limit: 1,
          cursor: taskPage.nextCursor,
        },
      );
    }
    expect(taskIds).toHaveLength(3);
    expect(new Set(taskIds).size).toBe(3);
    expect(taskIds).toEqual(
      [...tasks]
        .filter((task) => task.id !== tasks[3].id)
        .sort((left, right) => right.id.localeCompare(left.id))
        .map((task) => task.id),
    );
    const archivedTaskPage = await tasksService.findAll(
      workspace.id,
      projects[1].id,
      owner.id,
      { includeArchived: true, limit: 1 },
    );
    expect(archivedTaskPage.items).toHaveLength(1);
    expect(archivedTaskPage.nextCursor).not.toBeNull();
    await expect(
      tasksService.findAll(workspace.id, projects[1].id, owner.id, {
        cursor: 'not-a-cursor',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      tasksService.findAll(otherWorkspace.id, projects[1].id, otherOwner.id),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      tasksService.findAll(workspace.id, projects[1].id, outsider.id),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('executes representative list and cursor queries for PostgreSQL plan inspection', async () => {
    const owner = await createUser('plan-owner');
    const workspace = await createWorkspace([
      { userId: owner.id, role: WorkspaceRole.OWNER },
    ]);
    const project = await createProject(workspace.id, owner.id, 'PLAN');

    await prisma.project.createMany({
      data: Array.from({ length: 120 }, (_, index) => ({
        workspaceId: workspace.id,
        name: `Plan ${index}`,
        key: `P${String(index).padStart(3, '0')}`,
      })),
    });
    await prisma.task.createMany({
      data: Array.from({ length: 240 }, (_, index) => ({
        workspaceId: workspace.id,
        projectId: project.id,
        sequence: index + 1,
        title: `Plan task ${index}`,
        creatorId: owner.id,
        status: index % 2 === 0 ? TaskStatus.TODO : TaskStatus.DONE,
        priority: index % 3 === 0 ? TaskPriority.HIGH : TaskPriority.NONE,
      })),
    });

    const explain = async (query: Prisma.Sql) =>
      prisma.$queryRaw<ExplainRow[]>(query);
    const projectPlan = await explain(Prisma.sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT "id", "createdAt"
      FROM "projects"
      WHERE "workspaceId" = ${workspace.id} AND "archivedAt" IS NULL
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT 50
    `);
    const taskProjectPlan = await explain(Prisma.sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT "id", "createdAt"
      FROM "tasks"
      WHERE "workspaceId" = ${workspace.id} AND "projectId" = ${project.id}
        AND "archivedAt" IS NULL
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT 50
    `);
    const taskFilterPlan = await explain(Prisma.sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT "id"
      FROM "tasks"
      WHERE "workspaceId" = ${workspace.id} AND "projectId" = ${project.id}
        AND "status" = ${TaskStatus.DONE} AND "priority" = ${TaskPriority.NONE}
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT 50
    `);
    const taskAssigneePlan = await explain(Prisma.sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT t."id"
      FROM "tasks" t
      JOIN "workspace_members" m
        ON m."workspaceId" = t."workspaceId" AND m."id" = t."assigneeMemberId"
      WHERE t."workspaceId" = ${workspace.id} AND t."projectId" = ${project.id}
        AND m."userId" = ${owner.id}
      ORDER BY t."createdAt" DESC, t."id" DESC
      LIMIT 50
    `);
    const cursorPlan = await explain(Prisma.sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT "id", "createdAt"
      FROM "tasks"
      WHERE "workspaceId" = ${workspace.id} AND "projectId" = ${project.id}
        AND ("createdAt" < ${new Date()} OR ("createdAt" = ${new Date()} AND "id" < ${randomUUID()}))
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT 50
    `);
    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>(
      Prisma.sql`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public' AND tablename IN ('projects', 'tasks')
      `,
    );

    const planDiagnostics = [
      { label: 'projects list', plan: projectPlan },
      { label: 'tasks by project', plan: taskProjectPlan },
      { label: 'tasks by filters', plan: taskFilterPlan },
      { label: 'tasks by assignee', plan: taskAssigneePlan },
      { label: 'tasks by cursor', plan: cursorPlan },
    ].map(({ label, plan }) => ({
      label,
      ...analyseExplainPlan(plan, label),
    }));

    // Performance diagnostics describe the chosen plan without requiring a
    // particular scan type for small, fixture-sized datasets.
    expect(planDiagnostics).toHaveLength(5);
    expect(
      planDiagnostics.every(
        ({ planningTime, executionTime }) =>
          Number.isFinite(planningTime) && Number.isFinite(executionTime),
      ),
    ).toBe(true);
    expect(indexes.map((index) => index.indexname)).toEqual(
      expect.arrayContaining([
        'projects_workspaceId_archivedAt_idx',
        'tasks_workspaceId_projectId_idx',
        'tasks_projectId_createdAt_id_idx',
        'tasks_workspaceId_createdAt_id_idx',
      ]),
    );
  });
});
