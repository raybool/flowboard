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
  WorkspaceRole,
} from '../src/generated/prisma/client';

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    'TEST_DATABASE_URL is required for the HTTP PostgreSQL integration suite',
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
  nonMember: FixtureUser;
  invitee: FixtureUser;
  secondInvitee: FixtureUser;
  thirdInvitee: FixtureUser;
  workspaceId: string;
  memberIds: {
    owner: string;
    admin: string;
    member: string;
  };
};

describe('Workspace RBAC HTTP PostgreSQL', () => {
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
      'flowboard-http-rbac-test-secret-with-32-chars',
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
        name: `HTTP RBAC ${randomUUID()}`,
        slug: `http-rbac-${randomUUID()}`,
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
    const nonMember = await createUser('non-member');
    const invitee = await createUser('invitee');
    const secondInvitee = await createUser('second-invitee');
    const thirdInvitee = await createUser('third-invitee');
    const workspaceId = await createWorkspace([
      { userId: owner.id, role: WorkspaceRole.OWNER },
      { userId: admin.id, role: WorkspaceRole.ADMIN },
      { userId: member.id, role: WorkspaceRole.MEMBER },
    ]);
    const memberships = await prisma.workspaceMember.findMany({
      where: { workspaceId },
      select: { id: true, userId: true },
    });
    const memberId = (userId: string) =>
      memberships.find((membership) => membership.userId === userId)!.id;

    return {
      owner,
      admin,
      member,
      nonMember,
      invitee,
      secondInvitee,
      thirdInvitee,
      workspaceId,
      memberIds: {
        owner: memberId(owner.id),
        admin: memberId(admin.id),
        member: memberId(member.id),
      },
    };
  }

  function tokenFor(user: FixtureUser): string {
    return jwt.sign({
      sub: user.id,
      sid: user.sessionId,
      type: 'access',
    });
  }

  function get(path: string, user?: FixtureUser) {
    const test = request(httpApp.getHttpServer()).get(path);
    return user ? test.set('Authorization', `Bearer ${tokenFor(user)}`) : test;
  }

  function patch(path: string, user: FixtureUser) {
    return request(httpApp.getHttpServer())
      .patch(path)
      .set('Authorization', `Bearer ${tokenFor(user)}`);
  }

  function post(path: string, user: FixtureUser) {
    return request(httpApp.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${tokenFor(user)}`);
  }

  function remove(path: string, user: FixtureUser) {
    return request(httpApp.getHttpServer())
      .delete(path)
      .set('Authorization', `Bearer ${tokenFor(user)}`);
  }

  it('connects fixtures and the Nest application to the same test database', async () => {
    const fixture = await createFixture();
    const appPrisma = httpApp.get(PrismaService);

    await expect(
      appPrisma.user.findUnique({ where: { id: fixture.owner.id } }),
    ).resolves.toMatchObject({ email: fixture.owner.email });
    const [fixtureDatabase] = await prisma.$queryRaw<Array<{ db: string }>>(
      Prisma.sql`SELECT current_database() AS db`,
    );
    const [appDatabase] = await appPrisma.$queryRaw<Array<{ db: string }>>(
      Prisma.sql`SELECT current_database() AS db`,
    );
    expect(appDatabase.db).toBe(fixtureDatabase.db);
    expect(appDatabase.db).toBe(databaseName);
    expect(databaseName).toMatch(/_test$/);
  });

  it('issues a JWT over HTTP and validates its session through /auth/me', async () => {
    const fixture = await createFixture();
    const response = await request(httpApp.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: fixture.owner.email, password: 'fixture-password' })
      .expect(200);

    expect(response.body.accessToken).toEqual(expect.any(String));
    const payload = await jwt.verifyAsync(response.body.accessToken);
    expect(payload).toMatchObject({
      sub: fixture.owner.id,
      type: 'access',
    });

    await request(httpApp.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${response.body.accessToken}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          id: fixture.owner.id,
          email: fixture.owner.email,
        });
      });
  });

  it('lets OWNER, ADMIN, and MEMBER read the workspace and member list', async () => {
    const fixture = await createFixture();

    for (const user of [fixture.owner, fixture.admin, fixture.member]) {
      await get(`/api/v1/workspaces/${fixture.workspaceId}`, user).expect(200);
      await get(`/api/v1/workspaces/${fixture.workspaceId}/members`, user)
        .expect(200)
        .expect(({ body }) => expect(body).toHaveLength(3));
    }
  });

  it('allows OWNER and ADMIN to update a workspace but rejects MEMBER', async () => {
    const fixture = await createFixture();

    await patch(`/api/v1/workspaces/${fixture.workspaceId}`, fixture.owner)
      .send({ name: 'Owner update' })
      .expect(200);
    await patch(`/api/v1/workspaces/${fixture.workspaceId}`, fixture.admin)
      .send({ name: 'Admin update' })
      .expect(200);
    await patch(`/api/v1/workspaces/${fixture.workspaceId}`, fixture.member)
      .send({ name: 'Member update' })
      .expect(403);
  });

  it('allows OWNER and ADMIN to add MEMBER but rejects MEMBER', async () => {
    const fixture = await createFixture();

    await post(
      `/api/v1/workspaces/${fixture.workspaceId}/members`,
      fixture.owner,
    )
      .send({ email: fixture.invitee.email, role: WorkspaceRole.MEMBER })
      .expect(201);
    await post(
      `/api/v1/workspaces/${fixture.workspaceId}/members`,
      fixture.admin,
    )
      .send({ email: fixture.secondInvitee.email, role: WorkspaceRole.MEMBER })
      .expect(201);
    await post(
      `/api/v1/workspaces/${fixture.workspaceId}/members`,
      fixture.member,
    )
      .send({ email: fixture.thirdInvitee.email, role: WorkspaceRole.MEMBER })
      .expect(403);
  });

  it('allows only OWNER to add ADMIN', async () => {
    const fixture = await createFixture();

    await post(
      `/api/v1/workspaces/${fixture.workspaceId}/members`,
      fixture.admin,
    )
      .send({ email: fixture.invitee.email, role: WorkspaceRole.ADMIN })
      .expect(403);
    await post(
      `/api/v1/workspaces/${fixture.workspaceId}/members`,
      fixture.owner,
    )
      .send({ email: fixture.secondInvitee.email, role: WorkspaceRole.ADMIN })
      .expect(201);
  });

  it('allows only OWNER to change member roles', async () => {
    const fixture = await createFixture();

    await patch(
      `/api/v1/workspaces/${fixture.workspaceId}/members/${fixture.memberIds.admin}`,
      fixture.owner,
    )
      .send({ role: WorkspaceRole.MEMBER })
      .expect(200);
    await patch(
      `/api/v1/workspaces/${fixture.workspaceId}/members/${fixture.memberIds.member}`,
      fixture.admin,
    )
      .send({ role: WorkspaceRole.ADMIN })
      .expect(403);
  });

  it('lets ADMIN delete MEMBER but not ADMIN', async () => {
    const fixture = await createFixture();

    await remove(
      `/api/v1/workspaces/${fixture.workspaceId}/members/${fixture.memberIds.member}`,
      fixture.admin,
    ).expect(204);
    await remove(
      `/api/v1/workspaces/${fixture.workspaceId}/members/${fixture.memberIds.admin}`,
      fixture.admin,
    ).expect(403);
  });

  it('does not allow deleting or assigning OWNER through ordinary endpoints', async () => {
    const fixture = await createFixture();

    await remove(
      `/api/v1/workspaces/${fixture.workspaceId}/members/${fixture.memberIds.owner}`,
      fixture.owner,
    ).expect(403);
    await patch(
      `/api/v1/workspaces/${fixture.workspaceId}/members/${fixture.memberIds.owner}`,
      fixture.owner,
    )
      .send({ role: WorkspaceRole.MEMBER })
      .expect(403);
    await post(
      `/api/v1/workspaces/${fixture.workspaceId}/members`,
      fixture.owner,
    )
      .send({ email: fixture.invitee.email, role: WorkspaceRole.OWNER })
      .expect(400);
  });

  it('returns 404 for a non-member on workspace and member-list reads', async () => {
    const fixture = await createFixture();

    await get(
      `/api/v1/workspaces/${fixture.workspaceId}`,
      fixture.nonMember,
    ).expect(404);
    await get(
      `/api/v1/workspaces/${fixture.workspaceId}/members`,
      fixture.nonMember,
    ).expect(404);
  });

  it('returns 401 for requests without a JWT', async () => {
    const fixture = await createFixture();

    await get(`/api/v1/workspaces/${fixture.workspaceId}`).expect(401);
    await request(httpApp.getHttpServer())
      .post(`/api/v1/workspaces/${fixture.workspaceId}/members`)
      .send({ email: fixture.invitee.email, role: WorkspaceRole.MEMBER })
      .expect(401);
  });

  it('returns 404 when memberId belongs to another workspace', async () => {
    const fixture = await createFixture();
    const foreignOwner = await createUser('foreign-owner');
    const foreignWorkspaceId = await createWorkspace([
      { userId: foreignOwner.id, role: WorkspaceRole.OWNER },
      { userId: fixture.invitee.id, role: WorkspaceRole.MEMBER },
    ]);
    const foreignMember = await prisma.workspaceMember.findUniqueOrThrow({
      where: {
        workspaceId_userId: {
          workspaceId: foreignWorkspaceId,
          userId: fixture.invitee.id,
        },
      },
    });

    await patch(
      `/api/v1/workspaces/${fixture.workspaceId}/members/${foreignMember.id}`,
      fixture.owner,
    )
      .send({ role: WorkspaceRole.MEMBER })
      .expect(404);
  });

  it('returns 400 for an invalid workspaceId', async () => {
    const fixture = await createFixture();

    await get('/api/v1/workspaces/not-a-uuid', fixture.owner).expect(400);
  });
});
