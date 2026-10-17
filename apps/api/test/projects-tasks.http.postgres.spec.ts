import { createHash, randomUUID } from 'node:crypto';

import * as argon2 from 'argon2';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import type { App } from 'supertest/types';

import { PrismaService } from '../src/database/prisma.service';
import {
  Prisma,
  PrismaClient,
  TaskPriority,
  TaskStatus,
  WorkspaceRole,
} from '../src/generated/prisma/client';

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    'TEST_DATABASE_URL is required for the Projects and Tasks HTTP PostgreSQL suite',
  );
}

function assertTestDatabase(url: string): string {
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

  return databaseName;
}

type FixtureUser = {
  id: string;
  email: string;
  sessionId: string;
};

type Fixture = {
  owner: FixtureUser;
  admin: FixtureUser;
  member: FixtureUser;
  secondMember: FixtureUser;
  nonMember: FixtureUser;
  workspaceId: string;
};

describe('Projects and Tasks HTTP PostgreSQL', () => {
  let httpApp: import('@nestjs/common').INestApplication<App>;
  let prisma: PrismaClient;
  let jwt: JwtService;
  let passwordHash: string;
  const databaseName = assertTestDatabase(databaseUrl);
  const createdUserIds = new Set<string>();
  const createdWorkspaceIds = new Set<string>();

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', databaseUrl);
    vi.stubEnv(
      'JWT_ACCESS_SECRET',
      'flowboard-projects-tasks-http-test-secret-32-chars',
    );
    vi.stubEnv('JWT_ACCESS_EXPIRES_IN', '15m');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SWAGGER_ENABLED', 'false');

    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
    });
    await prisma.$connect();
    passwordHash = await argon2.hash('fixture-password');

    const { AppModule } = await import('../src/app.module');
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    httpApp = moduleFixture.createNestApplication();
    httpApp.setGlobalPrefix('api');
    httpApp.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: '1',
    });
    httpApp.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        forbidUnknownValues: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );
    await httpApp.init();
    jwt = httpApp.get(JwtService);
  });

  afterAll(async () => {
    await httpApp?.close();

    if (prisma) {
      await prisma.workspace.deleteMany({
        where: { id: { in: [...createdWorkspaceIds] } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [...createdUserIds] } },
      });
      await prisma.$disconnect();
    }

    vi.unstubAllEnvs();
  });

  async function createUser(label: string): Promise<FixtureUser> {
    const id = randomUUID();
    const sessionId = randomUUID();
    const email = `${label}-${id}@example.test`;
    const refreshTokenHash = createHash('sha256')
      .update(`fixture-refresh-${sessionId}`)
      .digest('hex');

    createdUserIds.add(id);
    await prisma.user.create({
      data: {
        id,
        email,
        name: label,
        passwordHash,
        sessions: {
          create: {
            id: sessionId,
            refreshTokenHash,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          },
        },
      },
    });

    return { id, email, sessionId };
  }

  async function createWorkspace(
    members: Array<{ userId: string; role: WorkspaceRole }>,
  ): Promise<string> {
    const workspace = await prisma.workspace.create({
      data: {
        name: `HTTP Projects ${randomUUID()}`,
        slug: `http-projects-${randomUUID()}`,
        members: { create: members },
      },
    });
    createdWorkspaceIds.add(workspace.id);
    return workspace.id;
  }

  async function createFixture(): Promise<Fixture> {
    const owner = await createUser('owner');
    const admin = await createUser('admin');
    const member = await createUser('member');
    const secondMember = await createUser('second-member');
    const nonMember = await createUser('non-member');
    const workspaceId = await createWorkspace([
      { userId: owner.id, role: WorkspaceRole.OWNER },
      { userId: admin.id, role: WorkspaceRole.ADMIN },
      { userId: member.id, role: WorkspaceRole.MEMBER },
      { userId: secondMember.id, role: WorkspaceRole.MEMBER },
    ]);

    return {
      owner,
      admin,
      member,
      secondMember,
      nonMember,
      workspaceId,
    };
  }

  function tokenFor(user: FixtureUser): string {
    return jwt.sign({
      sub: user.id,
      sid: user.sessionId,
      type: 'access',
    });
  }

  async function authApiToken(user: FixtureUser): Promise<string> {
    const response = await request(httpApp.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'fixture-password' })
      .expect(200);

    expect(response.body.accessToken).toEqual(expect.any(String));
    return response.body.accessToken as string;
  }

  function get(path: string, user?: FixtureUser, bearer?: string) {
    const test = request(httpApp.getHttpServer()).get(path);
    const accessToken = bearer ?? (user ? tokenFor(user) : undefined);
    return accessToken ? test.set('Authorization', `Bearer ${accessToken}`) : test;
  }

  function post(path: string, user: FixtureUser) {
    return request(httpApp.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${tokenFor(user)}`);
  }

  function patch(path: string, user: FixtureUser) {
    return request(httpApp.getHttpServer())
      .patch(path)
      .set('Authorization', `Bearer ${tokenFor(user)}`);
  }

  function remove(path: string, user: FixtureUser) {
    return request(httpApp.getHttpServer())
      .delete(path)
      .set('Authorization', `Bearer ${tokenFor(user)}`);
  }

  async function createProject(
    fixture: Fixture,
    user: FixtureUser,
    key: string,
  ) {
    return post(`/api/v1/workspaces/${fixture.workspaceId}/projects`, user)
      .send({ name: `Project ${key}`, key })
      .expect(201);
  }

  async function createTask(
    fixture: Fixture,
    projectId: string,
    user: FixtureUser,
    body: Record<string, unknown> = { title: 'HTTP task' },
  ) {
    return post(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${projectId}/tasks`,
      user,
    )
      .send(body)
      .expect(201);
  }

  it('uses the isolated PostgreSQL database and obtains a JWT through Auth API', async () => {
    const fixture = await createFixture();
    const appPrisma = httpApp.get(PrismaService);
    const [fixtureDatabase] = await prisma.$queryRaw<Array<{ db: string }>>(
      Prisma.sql`SELECT current_database() AS db`,
    );
    const [appDatabase] = await appPrisma.$queryRaw<Array<{ db: string }>>(
      Prisma.sql`SELECT current_database() AS db`,
    );

    expect(fixtureDatabase.db).toBe(databaseName);
    expect(appDatabase.db).toBe(databaseName);
    const accessToken = await authApiToken(fixture.owner);

    await get(`/api/v1/workspaces/${fixture.workspaceId}/projects`, undefined, accessToken)
      .expect(200);
  });

  it('enforces project RBAC, uniqueness, archive lifecycle, and cross-workspace IDOR protection', async () => {
    const fixture = await createFixture();
    const project = await createProject(fixture, fixture.owner, 'FLOW');
    const adminProject = await createProject(fixture, fixture.admin, 'ADMIN');

    await post(`/api/v1/workspaces/${fixture.workspaceId}/projects`, fixture.member)
      .send({ name: 'Member project', key: 'MEMBER' })
      .expect(403);

    for (const user of [fixture.owner, fixture.admin, fixture.member]) {
      await get(`/api/v1/workspaces/${fixture.workspaceId}/projects`, user).expect(200);
      await get(
        `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}`,
        user,
      ).expect(200);
    }

    await patch(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}`,
      fixture.owner,
    )
      .send({ name: 'Owner renamed' })
      .expect(200);
    await patch(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${adminProject.body.id}`,
      fixture.admin,
    )
      .send({ description: 'Admin description' })
      .expect(200);
    await patch(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}`,
      fixture.member,
    )
      .send({ name: 'Member cannot rename' })
      .expect(403);
    await patch(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}`,
      fixture.owner,
    )
      .send({ key: 'CHANGED', nextTaskSequence: 99 })
      .expect(400);

    await post(`/api/v1/workspaces/${fixture.workspaceId}/projects`, fixture.owner)
      .send({ name: 'Duplicate', key: 'FLOW' })
      .expect(409);

    const otherOwner = await createUser('other-owner');
    const otherWorkspaceId = await createWorkspace([
      { userId: otherOwner.id, role: WorkspaceRole.OWNER },
    ]);
    const otherProject = await post(
      `/api/v1/workspaces/${otherWorkspaceId}/projects`,
      otherOwner,
    )
      .send({ name: 'Same key elsewhere', key: 'FLOW' })
      .expect(201);

    await get(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${otherProject.body.id}`,
      fixture.owner,
    ).expect(404);
    await patch(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${otherProject.body.id}`,
      fixture.owner,
    )
      .send({ name: 'IDOR' })
      .expect(404);

    await post(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}/archive`,
      fixture.owner,
    ).expect(200);
    await post(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}/archive`,
      fixture.owner,
    ).expect(409);
    await patch(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}`,
      fixture.admin,
    )
      .send({ name: 'Archived update' })
      .expect(409);

    await get(
      `/api/v1/workspaces/${fixture.workspaceId}/projects?includeArchived=true`,
      fixture.member,
    ).expect(200)
      .expect(({ body }) => {
        expect(body.items.some((item: { id: string }) => item.id === project.body.id)).toBe(true);
      });
  });

  it('creates sequenced tasks for every member and applies ownership/assignment update rules', async () => {
    const fixture = await createFixture();
    const project = await createProject(fixture, fixture.owner, 'TASK');
    const first = await createTask(fixture, project.body.id, fixture.member, {
      title: 'Created by member',
      priority: TaskPriority.LOW,
    });
    const second = await createTask(fixture, project.body.id, fixture.secondMember, {
      title: 'Created by second member',
    });
    const ownerTask = await createTask(fixture, project.body.id, fixture.owner, {
      title: 'Created by owner',
    });
    const adminTask = await createTask(fixture, project.body.id, fixture.admin, {
      title: 'Created by admin',
    });

    expect(first.body.taskNumber).toBe('TASK-1');
    expect(second.body.taskNumber).toBe('TASK-2');
    expect(ownerTask.body.taskNumber).toBe('TASK-3');
    expect(adminTask.body.taskNumber).toBe('TASK-4');
    expect(first.body.sequence).toBe(1);
    expect(second.body.sequence).toBe(2);

    await patch(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}/tasks/${first.body.id}`,
      fixture.member,
    )
      .send({ title: 'Creator update' })
      .expect(200);
    await patch(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}/tasks/${first.body.id}/assignee`,
      fixture.owner,
    )
      .send({ assigneeId: fixture.secondMember.id })
      .expect(200);
    await patch(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}/tasks/${first.body.id}`,
      fixture.secondMember,
    )
      .send({ description: 'Assigned member update' })
      .expect(200);
    await patch(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}/tasks/${second.body.id}`,
      fixture.member,
    )
      .send({ title: 'Unrelated member update' })
      .expect(403);
    await patch(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}/tasks/${second.body.id}`,
      fixture.admin,
    )
      .send({ title: 'Admin update' })
      .expect(200);

    await post(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}/tasks`,
      fixture.member,
    )
      .send({
        title: 'Mass assignment',
        workspaceId: fixture.workspaceId,
        projectId: project.body.id,
        creatorId: fixture.owner.id,
        sequence: 99,
      })
      .expect(400);
  });

  it('enforces task workflow, archive guards, and project/task scope isolation', async () => {
    const fixture = await createFixture();
    const project = await createProject(fixture, fixture.owner, 'FLOW');
    const foreignProject = await createProject(fixture, fixture.admin, 'OTHER');
    const task = await createTask(fixture, project.body.id, fixture.member, {
      title: 'Workflow task',
    });

    await patch(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}/tasks/${task.body.id}/status`,
      fixture.member,
    )
      .send({ status: TaskStatus.IN_PROGRESS })
      .expect(200);
    await patch(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}/tasks/${task.body.id}/assignee`,
      fixture.member,
    )
      .send({ assigneeId: fixture.member.id })
      .expect(200);
    await patch(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}/tasks/${task.body.id}/assignee`,
      fixture.member,
    )
      .send({ assigneeId: fixture.secondMember.id })
      .expect(403);
    await patch(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}/tasks/${task.body.id}/assignee`,
      fixture.member,
    )
      .send({ assigneeId: null })
      .expect(200);
    await patch(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}/tasks/${task.body.id}/assignee`,
      fixture.secondMember,
    )
      .send({ assigneeId: null })
      .expect(403);
    await post(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}/tasks/${task.body.id}/archive`,
      fixture.member,
    ).expect(403);
    await post(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}/tasks/${task.body.id}/archive`,
      fixture.admin,
    ).expect(201);
    await patch(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}/tasks/${task.body.id}/status`,
      fixture.admin,
    )
      .send({ status: TaskStatus.DONE })
      .expect(409);

    const activeTask = await createTask(
      fixture,
      foreignProject.body.id,
      fixture.member,
      { title: 'Scope task' },
    );
    await get(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}/tasks/${activeTask.body.id}`,
      fixture.owner,
    ).expect(404);
    await patch(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}/tasks/${activeTask.body.id}`,
      fixture.owner,
    )
      .send({ title: 'Cross project IDOR' })
      .expect(404);
  });

  it('rejects task creation and changes for archived projects', async () => {
    const fixture = await createFixture();
    const project = await createProject(fixture, fixture.owner, 'ARCH');
    const task = await createTask(fixture, project.body.id, fixture.member);

    await post(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}/archive`,
      fixture.owner,
    ).expect(200);
    await post(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}/tasks`,
      fixture.member,
    )
      .send({ title: 'Archived project task creation' })
      .expect(409);
    await patch(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}/tasks/${task.body.id}`,
      fixture.owner,
    )
      .send({ title: 'Archived project task' })
      .expect(409);
  });

  it('supports cursor pagination, tie-safe traversal, filters, archived records, and invalid query rejection', async () => {
    const fixture = await createFixture();
    const projectA = await createProject(fixture, fixture.owner, 'PGA');
    const projectB = await createProject(fixture, fixture.owner, 'PGB');
    const projectC = await createProject(fixture, fixture.owner, 'PGC');
    const tiedCreatedAt = new Date('2026-01-01T00:00:00.000Z');
    await prisma.project.updateMany({
      where: { id: { in: [projectA.body.id, projectB.body.id, projectC.body.id] } },
      data: { createdAt: tiedCreatedAt },
    });

    const projectIds: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor
        ? `?limit=1&cursor=${encodeURIComponent(cursor)}`
        : '?limit=1';
      const response: request.Response = await get(
        `/api/v1/workspaces/${fixture.workspaceId}/projects${query}`,
        fixture.member,
      ).expect(200);
      expect(response.body.items).toHaveLength(1);
      projectIds.push(response.body.items[0].id);
      cursor = response.body.nextCursor;
    } while (cursor);

    expect(new Set(projectIds).size).toBe(projectIds.length);
    expect(projectIds).toEqual(expect.arrayContaining([projectA.body.id, projectB.body.id, projectC.body.id]));

    const archivedProject = await createProject(fixture, fixture.owner, 'PGA2');
    await post(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${archivedProject.body.id}/archive`,
      fixture.owner,
    ).expect(200);
    await get(`/api/v1/workspaces/${fixture.workspaceId}/projects`, fixture.member)
      .expect(200)
      .expect(({ body }) => {
        expect(body.items.some((item: { id: string }) => item.id === archivedProject.body.id)).toBe(false);
      });
    await get(
      `/api/v1/workspaces/${fixture.workspaceId}/projects?includeArchived=true`,
      fixture.member,
    )
      .expect(200)
      .expect(({ body }) => {
        expect(body.items.some((item: { id: string }) => item.id === archivedProject.body.id)).toBe(true);
      });

    const first = await createTask(fixture, projectA.body.id, fixture.member, {
      title: 'Filter todo high',
      priority: TaskPriority.HIGH,
      assigneeId: fixture.member.id,
    });
    const second = await createTask(fixture, projectA.body.id, fixture.secondMember, {
      title: 'Filter done low',
      priority: TaskPriority.LOW,
    });
    await patch(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${projectA.body.id}/tasks/${second.body.id}/status`,
      fixture.secondMember,
    )
      .send({ status: TaskStatus.DONE })
      .expect(200);
    const archivedTask = await createTask(fixture, projectA.body.id, fixture.owner, {
      title: 'Archived task',
    });
    await prisma.task.updateMany({
      where: { id: { in: [first.body.id, second.body.id, archivedTask.body.id] } },
      data: { createdAt: tiedCreatedAt },
    });
    await post(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${projectA.body.id}/tasks/${archivedTask.body.id}/archive`,
      fixture.owner,
    ).expect(201);

    await get(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${projectA.body.id}/tasks?status=${TaskStatus.DONE}&priority=${TaskPriority.LOW}`,
      fixture.member,
    )
      .expect(200)
      .expect(({ body }) => {
        expect(body.items.map((item: { id: string }) => item.id)).toEqual([second.body.id]);
      });
    await get(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${projectA.body.id}/tasks?assigneeId=${fixture.member.id}`,
      fixture.member,
    )
      .expect(200)
      .expect(({ body }) => {
        expect(body.items.map((item: { id: string }) => item.id)).toContain(first.body.id);
      });
    await get(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${projectA.body.id}/tasks?includeArchived=true`,
      fixture.member,
    )
      .expect(200)
      .expect(({ body }) => {
        expect(body.items.map((item: { id: string }) => item.id)).toContain(archivedTask.body.id);
      });

    const taskIds: string[] = [];
    cursor = null;
    do {
      const query: string = cursor
        ? `?limit=1&cursor=${encodeURIComponent(cursor)}`
        : '?limit=1';
      const response: request.Response = await get(
        `/api/v1/workspaces/${fixture.workspaceId}/projects/${projectA.body.id}/tasks${query}`,
        fixture.member,
      ).expect(200);
      taskIds.push(...response.body.items.map((item: { id: string }) => item.id));
      cursor = response.body.nextCursor;
    } while (cursor);
    expect(new Set(taskIds).size).toBe(taskIds.length);
    expect(taskIds).not.toContain(archivedTask.body.id);

    await get(`/api/v1/workspaces/${fixture.workspaceId}/projects?limit=0`, fixture.member).expect(400);
    await get(`/api/v1/workspaces/${fixture.workspaceId}/projects?includeArchived=maybe`, fixture.member).expect(400);
    await get(`/api/v1/workspaces/${fixture.workspaceId}/projects?cursor=not-a-cursor`, fixture.member).expect(400);
    await get(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${projectA.body.id}/tasks?status=INVALID`,
      fixture.member,
    ).expect(400);
    await get(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${projectA.body.id}/tasks?assigneeId=not-a-uuid`,
      fixture.member,
    ).expect(400);
  });

  it('returns 401/400 safely and blocks revoked memberships on new requests', async () => {
    const fixture = await createFixture();
    const project = await createProject(fixture, fixture.owner, 'AUTH');
    const expiredToken = jwt.sign(
      { sub: fixture.member.id, sid: fixture.member.sessionId, type: 'access' },
      { expiresIn: -1 },
    );

    await get(`/api/v1/workspaces/${fixture.workspaceId}/projects`).expect(401);
    await get(`/api/v1/workspaces/${fixture.workspaceId}/projects`, undefined, 'not-a-jwt').expect(401);
    await get(`/api/v1/workspaces/${fixture.workspaceId}/projects`, undefined, expiredToken).expect(401);
    await get(`/api/v1/workspaces/${fixture.workspaceId}/projects`, fixture.nonMember).expect(404);
    await get('/api/v1/workspaces/not-a-uuid/projects', fixture.owner)
      .expect(400)
      .expect(({ body }) => {
        expect(JSON.stringify(body)).not.toMatch(/Prisma|DATABASE_URL|password|stack/i);
      });

    await remove(
      `/api/v1/workspaces/${fixture.workspaceId}/members/${await memberId(fixture.workspaceId, fixture.member.id)}`,
      fixture.owner,
    ).expect(204);
    await get(`/api/v1/workspaces/${fixture.workspaceId}/projects`, fixture.member).expect(404);
    await get(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}`,
      fixture.member,
    ).expect(404);
  });

  async function memberId(workspaceId: string, userId: string): Promise<string> {
    const member = await prisma.workspaceMember.findUniqueOrThrow({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    return member.id;
  }
});
