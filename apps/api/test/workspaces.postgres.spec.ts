import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import {
  Prisma,
  PrismaClient,
  WorkspaceRole,
} from '../src/generated/prisma/client';
import type { PrismaService } from '../src/database/prisma.service';
import { runSerializableTransaction } from '../src/database/serializable-transaction';
import { WorkspaceMembersService } from '../src/modules/workspaces/workspace-members.service';
import { WorkspacesService } from '../src/modules/workspaces/workspaces.service';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe(
  'Workspace RBAC PostgreSQL security',
  () => {
    let prisma: PrismaClient;
    let service: WorkspacesService;
    let workspaceMembersService: WorkspaceMembersService;
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
      workspaceMembersService = new WorkspaceMembersService(
        prisma as unknown as PrismaService,
      );
      service = new WorkspacesService(
        prisma as unknown as PrismaService,
        workspaceMembersService,
      );
    });

    afterAll(async () => {
      if (!prisma) {
        return;
      }

      await prisma.workspace.deleteMany({
        where: { id: { in: workspaceIds } },
      });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
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

    it('rejects a member id belonging to another workspace', async () => {
      const ownerA = await createUser('owner-a');
      const ownerB = await createUser('owner-b');
      const targetB = await createUser('target-b');
      const workspaceA = await createWorkspace([
        { userId: ownerA.id, role: WorkspaceRole.OWNER },
      ]);
      const workspaceB = await createWorkspace([
        { userId: ownerB.id, role: WorkspaceRole.OWNER },
        { userId: targetB.id, role: WorkspaceRole.MEMBER },
      ]);
      const memberB = await prisma.workspaceMember.findFirstOrThrow({
        where: { workspaceId: workspaceB.id, userId: targetB.id },
      });

      await expect(
        service.updateMemberRole(workspaceA.id, ownerA.id, memberB.id, {
          role: WorkspaceRole.MEMBER,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('preserves owner/admin invariants and rejects OWNER assignment', async () => {
      const owner = await createUser('owner');
      const admin = await createUser('admin');
      const secondAdmin = await createUser('second-admin');
      const workspace = await createWorkspace([
        { userId: owner.id, role: WorkspaceRole.OWNER },
        { userId: admin.id, role: WorkspaceRole.ADMIN },
        { userId: secondAdmin.id, role: WorkspaceRole.ADMIN },
      ]);
      const ownerMember = await prisma.workspaceMember.findFirstOrThrow({
        where: { workspaceId: workspace.id, userId: owner.id },
      });
      const secondAdminMember = await prisma.workspaceMember.findFirstOrThrow({
        where: { workspaceId: workspace.id, userId: secondAdmin.id },
      });

      await expect(
        service.updateMemberRole(workspace.id, owner.id, secondAdminMember.id, {
          role: WorkspaceRole.OWNER,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.removeMember(workspace.id, admin.id, secondAdminMember.id),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.removeMember(workspace.id, owner.id, ownerMember.id),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.updateMemberRole(workspace.id, owner.id, ownerMember.id, {
          role: WorkspaceRole.MEMBER,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('serializes parallel membership additions and leaves one membership', async () => {
      const owner = await createUser('parallel-owner');
      const target = await createUser('parallel-target');
      const workspace = await createWorkspace([
        { userId: owner.id, role: WorkspaceRole.OWNER },
      ]);
      const dto = { email: target.email, role: WorkspaceRole.MEMBER };

      const results = await Promise.allSettled([
        service.addMember(workspace.id, owner.id, dto),
        service.addMember(workspace.id, owner.id, dto),
      ]);
      const rejected = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );

      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);
      await expect(
        prisma.workspaceMember.count({
          where: { workspaceId: workspace.id, userId: target.id },
        }),
      ).resolves.toBe(1);
    });

    it('returns 404 after membership is revoked before a scoped read', async () => {
      const owner = await createUser('read-owner');
      const member = await createUser('read-member');
      const workspace = await createWorkspace([
        { userId: owner.id, role: WorkspaceRole.OWNER },
        { userId: member.id, role: WorkspaceRole.MEMBER },
      ]);
      const membership = await prisma.workspaceMember.findFirstOrThrow({
        where: { workspaceId: workspace.id, userId: member.id },
      });

      await prisma.workspaceMember.delete({ where: { id: membership.id } });

      await expect(
        service.findOne(workspace.id, member.id),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.getMembers(workspace.id, member.id),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rolls back writes made before a transaction failure', async () => {
      const owner = await createUser('rollback-owner');
      const target = await createUser('rollback-target');
      const workspace = await createWorkspace([
        { userId: owner.id, role: WorkspaceRole.OWNER },
      ]);

      await expect(
        runSerializableTransaction(
          prisma as unknown as PrismaService,
          async (transaction) => {
            await transaction.workspaceMember.create({
              data: {
                workspaceId: workspace.id,
                userId: target.id,
                role: WorkspaceRole.MEMBER,
              },
            });
            throw new Error('force rollback');
          },
        ),
      ).rejects.toThrow('force rollback');

      await expect(
        prisma.workspaceMember.findFirst({
          where: { workspaceId: workspace.id, userId: target.id },
        }),
      ).resolves.toBeNull();
    });

    it('does not commit a workspace update after a concurrent role revocation', async () => {
      const owner = await createUser('race-owner');
      const workspace = await createWorkspace([
        { userId: owner.id, role: WorkspaceRole.OWNER },
      ]);
      const ownerMember = await prisma.workspaceMember.findFirstOrThrow({
        where: { workspaceId: workspace.id, userId: owner.id },
      });
      let resolveRoleLookupFinished!: () => void;
      const roleLookupFinished = new Promise<void>((resolve) => {
        resolveRoleLookupFinished = resolve;
      });
      const originalRequireRole = workspaceMembersService.requireRole.bind(
        workspaceMembersService,
      );
      const roleLookup = vi.spyOn(workspaceMembersService, 'requireRole');
      roleLookup.mockImplementation(async (...args) => {
        const result = await originalRequireRole(...args);
        resolveRoleLookupFinished();
        return result;
      });
      let releaseRevocation!: () => void;
      const revocationReady = new Promise<void>((resolve) => {
        releaseRevocation = resolve;
      });
      let resolveRevocationStarted!: () => void;
      const revocationStarted = new Promise<void>((resolve) => {
        resolveRevocationStarted = resolve;
      });
      const revocation = prisma.$transaction(
        async (transaction) => {
          await transaction.$queryRaw(
            Prisma.sql`SELECT "id" FROM "workspaces" WHERE "id" = ${workspace.id} FOR UPDATE`,
          );
          resolveRevocationStarted();
          await revocationReady;
          await transaction.workspaceMember.update({
            where: { id: ownerMember.id },
            data: { role: WorkspaceRole.MEMBER },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );

      await revocationStarted;
      const updatePromise = service.update(workspace.id, owner.id, {
        name: 'must not be committed after revoke',
      });
      await roleLookupFinished;
      releaseRevocation();
      const updateError = await updatePromise.catch((error: unknown) => error);
      await revocation;
      expect(updateError).toBeInstanceOf(ForbiddenException);
      expect(roleLookup).toHaveBeenCalledTimes(2);
      await expect(
        prisma.workspaceMember.findUnique({ where: { id: ownerMember.id } }),
      ).resolves.toMatchObject({ role: WorkspaceRole.MEMBER });
      await expect(
        prisma.workspace.findUnique({ where: { id: workspace.id } }),
      ).resolves.toMatchObject({
        name: workspace.name,
      });
    });
  },
);
