-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('BACKLOG', 'TODO', 'IN_PROGRESS', 'DONE', 'CANCELED');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('NONE', 'LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "nextTaskSequence" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'BACKLOG',
    "priority" "TaskPriority" NOT NULL DEFAULT 'NONE',
    "creatorId" TEXT NOT NULL,
    "assigneeMemberId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "projects_workspaceId_key_key" ON "projects"("workspaceId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "projects_workspaceId_id_key" ON "projects"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "projects_workspaceId_idx" ON "projects"("workspaceId");

-- CreateIndex
CREATE INDEX "projects_workspaceId_archivedAt_idx" ON "projects"("workspaceId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_projectId_sequence_key" ON "tasks"("projectId", "sequence");

-- CreateIndex
CREATE INDEX "tasks_workspaceId_idx" ON "tasks"("workspaceId");

-- CreateIndex
CREATE INDEX "tasks_workspaceId_projectId_idx" ON "tasks"("workspaceId", "projectId");

-- CreateIndex
CREATE INDEX "tasks_projectId_status_idx" ON "tasks"("projectId", "status");

-- CreateIndex
CREATE INDEX "tasks_workspaceId_status_idx" ON "tasks"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "tasks_assigneeMemberId_idx" ON "tasks"("assigneeMemberId");

-- CreateIndex
CREATE INDEX "tasks_workspaceId_assigneeMemberId_idx" ON "tasks"("workspaceId", "assigneeMemberId");

-- CreateIndex
CREATE INDEX "tasks_projectId_createdAt_id_idx" ON "tasks"("projectId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "tasks_workspaceId_createdAt_id_idx" ON "tasks"("workspaceId", "createdAt", "id");

-- AddCheckConstraint
ALTER TABLE "projects"
    ADD CONSTRAINT "projects_key_format_check"
    CHECK ("key" ~ '^[A-Z][A-Z0-9]{1,9}$');

-- AddCheckConstraint
ALTER TABLE "projects"
    ADD CONSTRAINT "projects_next_task_sequence_check"
    CHECK ("nextTaskSequence" > 0);

-- AddCheckConstraint
ALTER TABLE "tasks"
    ADD CONSTRAINT "tasks_sequence_check"
    CHECK ("sequence" > 0);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_workspaceId_id_key" ON "workspace_members"("workspaceId", "id");

-- AddForeignKey
ALTER TABLE "projects"
    ADD CONSTRAINT "projects_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks"
    ADD CONSTRAINT "tasks_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks"
    ADD CONSTRAINT "tasks_workspaceId_projectId_fkey"
    FOREIGN KEY ("workspaceId", "projectId") REFERENCES "projects"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks"
    ADD CONSTRAINT "tasks_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks"
    ADD CONSTRAINT "tasks_workspaceId_assigneeMemberId_fkey"
    FOREIGN KEY ("workspaceId", "assigneeMemberId") REFERENCES "workspace_members"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
