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
  TaskActivityType,
  TaskPriority,
  TaskStatus,
  WorkspaceRole,
} from '../src/generated/prisma/client';

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    'TEST_DATABASE_URL is required for the Task Collaboration HTTP PostgreSQL suite',
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

describe('Task collaboration HTTP PostgreSQL', () => {
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
      'flowboard-task-collaboration-http-test-secret-32-chars',
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
        name: `HTTP Collaboration ${randomUUID()}`,
        slug: `http-collaboration-${randomUUID()}`,
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
    expect(response.body.user).not.toHaveProperty('passwordHash');
    expect(response.body.user).not.toHaveProperty('sessions');
    return response.body.accessToken as string;
  }

  function get(path: string, user?: FixtureUser, bearer?: string) {
    const test = request(httpApp.getHttpServer()).get(path);
    const accessToken = bearer ?? (user ? tokenFor(user) : undefined);
    return accessToken
      ? test.set('Authorization', `Bearer ${accessToken}`)
      : test;
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

  function put(path: string, user: FixtureUser) {
    return request(httpApp.getHttpServer())
      .put(path)
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
    body: Record<string, unknown> = { title: 'HTTP collaboration task' },
  ) {
    return post(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${projectId}/tasks`,
      user,
    )
      .send(body)
      .expect(201);
  }

  async function createLabel(
    fixture: Fixture,
    user: FixtureUser,
    name: string,
  ) {
    return post(`/api/v1/workspaces/${fixture.workspaceId}/labels`, user)
      .send({ name, color: '#2563EB' })
      .expect(201);
  }

  function taskPath(fixture: Fixture, projectId: string, taskId: string) {
    return `/api/v1/workspaces/${fixture.workspaceId}/projects/${projectId}/tasks/${taskId}`;
  }

  it('boots the real AppModule on the isolated PostgreSQL database and authenticates through Auth API', async () => {
    const fixture = await createFixture();
    const project = await createProject(fixture, fixture.owner, 'AUTH');
    const appPrisma = httpApp.get(PrismaService);
    const [fixtureDatabase] = await prisma.$queryRaw<Array<{ db: string }>>(
      Prisma.sql`SELECT current_database() AS db`,
    );
    const [appDatabase] = await appPrisma.$queryRaw<Array<{ db: string }>>(
      Prisma.sql`SELECT current_database() AS db`,
    );
    const accessToken = await authApiToken(fixture.owner);

    expect(fixtureDatabase.db).toBe(databaseName);
    expect(appDatabase.db).toBe(databaseName);
    await get(
      `/api/v1/workspaces/${fixture.workspaceId}/projects`,
      undefined,
      accessToken,
    ).expect(200);
    await get(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}/tasks`,
      undefined,
      accessToken,
    ).expect(200);
  });

  it('covers comments HTTP lifecycle, moderation, tombstones, pagination, IDOR, and revoked membership', async () => {
    const fixture = await createFixture();
    const project = await createProject(fixture, fixture.owner, 'COMM');
    const task = await createTask(fixture, project.body.id, fixture.member, {
      title: 'Comment task',
    });
    const base = `${taskPath(fixture, project.body.id, task.body.id)}/comments`;

    await get(base).expect(401);
    await get(`${base}/not-a-uuid`, fixture.member).expect(404);

    const first = await post(base, fixture.member)
      .send({ content: ' first comment ' })
      .expect(201);
    const second = await post(base, fixture.secondMember)
      .send({ content: 'second comment' })
      .expect(201);
    const third = await post(base, fixture.secondMember)
      .send({ content: 'third comment' })
      .expect(201);

    expect(first.body).toMatchObject({
      taskId: task.body.id,
      author: { id: fixture.member.id, displayName: 'member' },
      content: 'first comment',
    });
    expect(JSON.stringify(first.body)).not.toMatch(
      /password|session|refreshToken|email/i,
    );

    await patch(`${base}/${first.body.id}`, fixture.member)
      .send({ content: 'edited comment' })
      .expect(200)
      .expect(({ body }) => expect(body.content).toBe('edited comment'));
    await patch(`${base}/${second.body.id}`, fixture.member)
      .send({ content: ' чужой комментарий ' })
      .expect(403);
    await remove(`${base}/${third.body.id}`, fixture.admin).expect(204);
    await remove(`${base}/${second.body.id}`, fixture.owner).expect(204);

    let cursor: string | null = null;
    const listed: Array<{ id: string; content: string | null }> = [];
    do {
      const query: string = cursor
        ? `?limit=1&cursor=${encodeURIComponent(cursor)}`
        : '?limit=1';
      const response: request.Response = await get(
        `${base}${query}`,
        fixture.member,
      ).expect(200);
      expect(response.body.items).toHaveLength(1);
      listed.push(response.body.items[0]);
      cursor = response.body.nextCursor;
    } while (cursor);

    expect(new Set(listed.map((item) => item.id))).toEqual(
      new Set([first.body.id, second.body.id, third.body.id]),
    );
    expect(
      listed.find((item) => item.id === third.body.id)?.content,
    ).toBeNull();
    expect(
      listed.find((item) => item.id === second.body.id)?.content,
    ).toBeNull();
    expect(JSON.stringify(listed)).not.toContain('third comment');
    expect(JSON.stringify(listed)).not.toContain('second comment');

    const otherOwner = await createUser('comment-foreign-owner');
    const otherWorkspaceId = await createWorkspace([
      { userId: otherOwner.id, role: WorkspaceRole.OWNER },
    ]);
    const foreignProject = await post(
      `/api/v1/workspaces/${otherWorkspaceId}/projects`,
      otherOwner,
    )
      .send({ name: 'Foreign project', key: 'FOREIGN' })
      .expect(201);
    const foreignTask = await post(
      `/api/v1/workspaces/${otherWorkspaceId}/projects/${foreignProject.body.id}/tasks`,
      otherOwner,
    )
      .send({ title: 'Foreign task' })
      .expect(201);

    await get(
      `${taskPath(fixture, project.body.id, foreignTask.body.id)}/comments`,
      fixture.member,
    ).expect(404);
    await post(base, fixture.nonMember)
      .send({ content: 'non-member' })
      .expect(404);

    const revoked = await createUser('revoked-comment-member');
    await prisma.workspaceMember.create({
      data: { workspaceId: fixture.workspaceId, userId: revoked.id },
    });
    await prisma.workspaceMember.delete({
      where: {
        workspaceId_userId: {
          workspaceId: fixture.workspaceId,
          userId: revoked.id,
        },
      },
    });
    await post(base, revoked).send({ content: 'revoked' }).expect(404);

    await remove(`${base}/${first.body.id}`, fixture.member).expect(204);
    await remove(`${base}/${first.body.id}`, fixture.member).expect(204);
    const eventCount = await prisma.taskActivity.count({
      where: { taskId: task.body.id, type: TaskActivityType.COMMENT_DELETED },
    });
    expect(eventCount).toBe(3);
  });

  it('covers workspace labels HTTP RBAC, normalization, validation, pagination, IDOR, and deletion contract', async () => {
    const fixture = await createFixture();
    const first = await createLabel(fixture, fixture.owner, ' Bug ');
    const second = await createLabel(fixture, fixture.admin, 'Feature');
    const third = await createLabel(fixture, fixture.owner, 'Docs');
    const base = `/api/v1/workspaces/${fixture.workspaceId}/labels`;

    expect(first.body).toMatchObject({ name: 'Bug', color: '#2563EB' });
    await post(base, fixture.member)
      .send({ name: 'Member label', color: '#FFFFFF' })
      .expect(403);
    await patch(`${base}/${first.body.id}`, fixture.member)
      .send({ name: 'Forbidden rename' })
      .expect(403);
    await patch(`${base}/${second.body.id}`, fixture.owner)
      .send({ name: 'bug' })
      .expect(409);
    await post(base, fixture.owner)
      .send({ name: 'Bad color', color: '#12345' })
      .expect(400);
    await post(base, fixture.owner)
      .send({
        name: 'Mass assignment',
        color: '#123456',
        workspaceId: fixture.workspaceId,
      })
      .expect(400);
    await patch(`${base}/${first.body.id}`, fixture.owner)
      .send({ name: 'Bug renamed', color: ' #112233 ' })
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({ name: 'Bug renamed', color: '#112233' }),
      );

    let cursor: string | null = null;
    const labelIds: string[] = [];
    do {
      const query: string = cursor
        ? `?limit=1&cursor=${encodeURIComponent(cursor)}`
        : '?limit=1';
      const response: request.Response = await get(
        `${base}${query}`,
        fixture.member,
      ).expect(200);
      expect(response.body.items).toHaveLength(1);
      labelIds.push(response.body.items[0].id);
      cursor = response.body.nextCursor;
    } while (cursor);
    expect(new Set(labelIds)).toEqual(
      new Set([first.body.id, second.body.id, third.body.id]),
    );

    const otherOwner = await createUser('label-foreign-owner');
    const otherWorkspaceId = await createWorkspace([
      { userId: otherOwner.id, role: WorkspaceRole.OWNER },
    ]);
    const foreignLabel = await post(
      `/api/v1/workspaces/${otherWorkspaceId}/labels`,
      otherOwner,
    )
      .send({ name: 'Foreign', color: '#ABCDEF' })
      .expect(201);
    await patch(`${base}/${foreignLabel.body.id}`, fixture.owner)
      .send({ name: 'IDOR' })
      .expect(404);
    await remove(`${base}/${foreignLabel.body.id}`, fixture.owner).expect(404);

    await remove(`${base}/${third.body.id}`, fixture.admin).expect(204);
    await remove(`${base}/${third.body.id}`, fixture.admin).expect(404);
  });

  it('covers task-label HTTP ownership, idempotency, archive guards, AND filters, and cursor pagination', async () => {
    const fixture = await createFixture();
    const project = await createProject(fixture, fixture.owner, 'LABL');
    const taskA = await createTask(fixture, project.body.id, fixture.member, {
      title: 'Own task A',
    });
    const taskB = await createTask(fixture, project.body.id, fixture.member, {
      title: 'Own task B',
    });
    const taskC = await createTask(fixture, project.body.id, fixture.member, {
      title: 'Own task C',
    });
    const ownerTask = await createTask(
      fixture,
      project.body.id,
      fixture.owner,
      { title: 'Other task' },
    );
    const labelA = await createLabel(fixture, fixture.owner, 'Label A');
    const labelB = await createLabel(fixture, fixture.owner, 'Label B');
    const labelsPath = (taskId: string, labelId: string) =>
      `${taskPath(fixture, project.body.id, taskId)}/labels/${labelId}`;

    await put(labelsPath(taskA.body.id, labelA.body.id), fixture.member).expect(
      204,
    );
    await put(labelsPath(taskA.body.id, labelB.body.id), fixture.member).expect(
      204,
    );
    await put(labelsPath(taskB.body.id, labelA.body.id), fixture.member).expect(
      204,
    );
    await put(labelsPath(taskC.body.id, labelA.body.id), fixture.member).expect(
      204,
    );
    await put(labelsPath(taskC.body.id, labelB.body.id), fixture.member).expect(
      204,
    );
    await put(
      labelsPath(ownerTask.body.id, labelA.body.id),
      fixture.member,
    ).expect(403);
    await put(labelsPath(taskA.body.id, labelA.body.id), fixture.member).expect(
      204,
    );
    await remove(
      labelsPath(taskA.body.id, labelA.body.id),
      fixture.member,
    ).expect(204);
    await remove(
      labelsPath(taskA.body.id, labelA.body.id),
      fixture.member,
    ).expect(204);
    await put(labelsPath(taskA.body.id, labelA.body.id), fixture.member).expect(
      204,
    );

    const filterPath = `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}/tasks`;
    const first = await get(
      `${filterPath}?labelIds=${encodeURIComponent(labelA.body.id)}&labelIds=${encodeURIComponent(labelB.body.id)}&limit=1`,
      fixture.member,
    ).expect(200);
    expect(first.body.items).toHaveLength(1);
    expect([taskA.body.id, taskC.body.id]).toContain(first.body.items[0].id);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await get(
      `${filterPath}?labelIds=${encodeURIComponent(labelA.body.id)}&labelIds=${encodeURIComponent(labelB.body.id)}&limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
      fixture.member,
    ).expect(200);
    expect(second.body.items).toHaveLength(1);
    expect(new Set([first.body.items[0].id, second.body.items[0].id])).toEqual(
      new Set([taskA.body.id, taskC.body.id]),
    );

    await post(
      `${taskPath(fixture, project.body.id, taskA.body.id)}/archive`,
      fixture.admin,
    ).expect(201);
    await put(labelsPath(taskA.body.id, labelB.body.id), fixture.member).expect(
      409,
    );

    const archivedProject = await createProject(fixture, fixture.owner, 'ARCL');
    const archivedProjectTask = await createTask(
      fixture,
      archivedProject.body.id,
      fixture.member,
    );
    await post(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${archivedProject.body.id}/archive`,
      fixture.owner,
    ).expect(200);
    await put(
      `${taskPath(fixture, archivedProject.body.id, archivedProjectTask.body.id)}/labels/${labelA.body.id}`,
      fixture.member,
    ).expect(409);

    const foreign = await createFixture();
    const foreignProject = await createProject(foreign, foreign.owner, 'FBLD');
    const foreignTask = await createTask(
      foreign,
      foreignProject.body.id,
      foreign.owner,
    );
    const foreignLabel = await createLabel(
      foreign,
      foreign.owner,
      'Foreign label',
    );
    await put(
      labelsPath(foreignTask.body.id, foreignLabel.body.id),
      fixture.owner,
    ).expect(404);
  });

  it('exposes the eleven activity events safely through HTTP and keeps business/no-op/idempotent mutations atomic', async () => {
    const fixture = await createFixture();
    const initialDescription = 'initial HTTP task description secret';
    const updatedDescription = 'updated HTTP task description secret';
    const project = await createProject(fixture, fixture.owner, 'ACTV');
    const task = await createTask(fixture, project.body.id, fixture.owner, {
      title: 'Activity task',
      description: initialDescription,
    });
    const label = await createLabel(fixture, fixture.owner, 'Activity label');
    const base = taskPath(fixture, project.body.id, task.body.id);
    const commentPath = `${base}/comments`;
    const labelPath = `${base}/labels/${label.body.id}`;

    await patch(base, fixture.owner)
      .send({ title: 'Activity task updated', description: updatedDescription })
      .expect(200);
    await patch(`${base}/status`, fixture.owner)
      .send({ status: TaskStatus.IN_PROGRESS })
      .expect(200);
    await patch(base, fixture.owner)
      .send({ priority: TaskPriority.HIGH })
      .expect(200);
    await patch(`${base}/assignee`, fixture.owner)
      .send({ assigneeId: fixture.member.id })
      .expect(200);
    const comment = await post(commentPath, fixture.owner)
      .send({ content: 'secret comment text' })
      .expect(201);
    await patch(`${commentPath}/${comment.body.id}`, fixture.owner)
      .send({ content: 'updated secret comment text' })
      .expect(200);
    await remove(`${commentPath}/${comment.body.id}`, fixture.owner).expect(
      204,
    );
    await put(labelPath, fixture.owner).expect(204);
    await put(labelPath, fixture.owner).expect(204);
    await remove(labelPath, fixture.owner).expect(204);
    await remove(labelPath, fixture.owner).expect(204);

    await patch(base, fixture.owner)
      .send({ title: 'Activity task updated' })
      .expect(200);
    const afterTaskNoop = await prisma.taskActivity.count({
      where: { taskId: task.body.id },
    });
    await patch(base, fixture.owner)
      .send({ title: 'Activity task updated' })
      .expect(200);
    expect(
      await prisma.taskActivity.count({ where: { taskId: task.body.id } }),
    ).toBe(afterTaskNoop);

    await post(`${base}/archive`, fixture.owner).expect(201);
    const expectedTypes = new Set<TaskActivityType>([
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
    ]);

    const activityPath = `${base}/activity`;
    const first = await get(`${activityPath}?limit=4`, fixture.member).expect(
      200,
    );
    expect(first.body.items).toHaveLength(4);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await get(
      `${activityPath}?limit=20&cursor=${encodeURIComponent(first.body.nextCursor)}`,
      fixture.member,
    ).expect(200);
    const activities = [...first.body.items, ...second.body.items];
    expect(new Set(activities.map((item) => item.type))).toEqual(expectedTypes);
    expect(activities).toHaveLength(11);
    expect(activities.every((item) => item.actorId === fixture.owner.id)).toBe(
      true,
    );
    for (const item of activities) {
      expect(item).not.toHaveProperty('actor');
      expect(item).not.toHaveProperty('user');
      expect(item.eventVersion).toBe(1);
      expect(item.payload).toHaveProperty('schemaVersion', 1);
      expect(JSON.stringify(item.payload)).not.toMatch(
        /password|session|refreshToken|email|jwt/i,
      );
    }
    const taskUpdated = activities.find(
      (item) => item.type === TaskActivityType.TASK_UPDATED,
    );
    expect(taskUpdated?.payload).toMatchObject({
      changes: { descriptionChanged: true },
    });
    expect(taskUpdated?.payload).not.toHaveProperty('changes.description');
    const activityResponseJson =
      JSON.stringify(first.body) + JSON.stringify(second.body);
    expect(activityResponseJson).not.toContain(initialDescription);
    expect(activityResponseJson).not.toContain(updatedDescription);
    const commentPayloads = activities
      .filter((item) => item.type.startsWith('COMMENT_'))
      .map((item) => JSON.stringify(item.payload));
    expect(commentPayloads.join('\n')).not.toContain('secret comment text');
    expect(
      activities.find((item) => item.type === TaskActivityType.LABEL_ADDED)
        ?.payload,
    ).toMatchObject({
      snapshot: {
        labelId: label.body.id,
        name: 'Activity label',
        color: '#2563EB',
      },
    });

    await patch(`${activityPath}/${activities[0].id}`, fixture.owner)
      .send({ payload: { leaked: true } })
      .expect(404);
    await remove(`${activityPath}/${activities[0].id}`, fixture.owner).expect(
      404,
    );
    await post(activityPath, fixture.owner)
      .send({ type: 'TASK_UPDATED' })
      .expect(404);

    const foreign = await createFixture();
    const foreignProject = await createProject(foreign, foreign.owner, 'FIDA');
    const foreignTask = await createTask(
      foreign,
      foreignProject.body.id,
      foreign.owner,
    );
    await get(
      `${taskPath(fixture, project.body.id, foreignTask.body.id)}/activity`,
      fixture.member,
    ).expect(404);
    await get(`${activityPath}`, fixture.nonMember).expect(404);

    const revoked = await createUser('revoked-activity-member');
    await prisma.workspaceMember.create({
      data: { workspaceId: fixture.workspaceId, userId: revoked.id },
    });
    await prisma.workspaceMember.delete({
      where: {
        workspaceId_userId: {
          workspaceId: fixture.workspaceId,
          userId: revoked.id,
        },
      },
    });
    await get(activityPath, revoked).expect(404);

    const failed = await patch(base, fixture.owner)
      .send({ title: 42 })
      .expect(400);
    expect(JSON.stringify(failed.body)).not.toMatch(
      /PrismaClient|PrismaKnownRequest/i,
    );
    expect(
      await prisma.taskActivity.count({ where: { taskId: task.body.id } }),
    ).toBe(11);
  });

  it('rejects malformed cursors and UUIDs with HTTP 400 and keeps archived/foreign mutations out of activity', async () => {
    const fixture = await createFixture();
    const project = await createProject(fixture, fixture.owner, 'SECU');
    const task = await createTask(fixture, project.body.id, fixture.member);
    const comments = `${taskPath(fixture, project.body.id, task.body.id)}/comments`;
    const activity = `${taskPath(fixture, project.body.id, task.body.id)}/activity`;

    await get(
      '/api/v1/workspaces/not-a-uuid/projects/not-a-uuid/tasks/not-a-uuid/comments',
      fixture.member,
    ).expect(400);
    await get(`${comments}?cursor=not-a-valid-cursor`, fixture.member).expect(
      400,
    );
    await get(`${activity}?cursor=not-a-valid-cursor`, fixture.member).expect(
      400,
    );
    await get(
      `/api/v1/workspaces/${fixture.workspaceId}/projects/${project.body.id}/tasks?labelIds=not-a-uuid`,
      fixture.member,
    ).expect(400);
    await post(comments, fixture.member).send({ content: '   ' }).expect(400);
    await post(
      `/api/v1/workspaces/${fixture.workspaceId}/labels`,
      fixture.member,
    )
      .send({ name: 'bad', color: '#0000000' })
      .expect(403);
  });
});
