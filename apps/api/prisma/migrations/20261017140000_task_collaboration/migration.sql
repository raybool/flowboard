-- CreateEnum
CREATE TYPE "TaskActivityType" AS ENUM ('TASK_CREATED', 'TASK_UPDATED', 'TASK_STATUS_CHANGED', 'TASK_PRIORITY_CHANGED', 'TASK_ASSIGNEE_CHANGED', 'TASK_ARCHIVED', 'COMMENT_CREATED', 'COMMENT_UPDATED', 'COMMENT_DELETED', 'LABEL_ADDED', 'LABEL_REMOVED');

-- CreateTable
CREATE TABLE "task_comments" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "author_id" TEXT,
    "author_display_name" TEXT NOT NULL,
    "content" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labels" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "labels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_labels" (
    "workspace_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "label_id" TEXT NOT NULL,

    CONSTRAINT "task_labels_pkey" PRIMARY KEY ("workspace_id", "task_id", "label_id")
);

-- CreateTable
CREATE TABLE "task_activities" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_display_name" TEXT,
    "type" "TaskActivityType" NOT NULL,
    "event_version" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "correlation_id" TEXT,
    "request_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tasks_workspaceId_id_key" ON "tasks"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "task_comments_workspace_id_id_key" ON "task_comments"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "task_comments_workspace_id_task_id_created_at_id_idx" ON "task_comments"("workspace_id", "task_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "task_comments_workspace_id_author_id_created_at_id_idx" ON "task_comments"("workspace_id", "author_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "labels_workspace_id_id_key" ON "labels"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "labels_workspace_id_name_key_key" ON "labels"("workspace_id", "name_key");

-- CreateIndex
CREATE INDEX "labels_workspace_id_created_at_id_idx" ON "labels"("workspace_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "task_labels_workspace_id_label_id_task_id_idx" ON "task_labels"("workspace_id", "label_id", "task_id");

-- CreateIndex
CREATE INDEX "task_labels_workspace_id_task_id_label_id_idx" ON "task_labels"("workspace_id", "task_id", "label_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_activities_workspace_id_id_key" ON "task_activities"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "task_activities_workspace_id_task_id_created_at_id_idx" ON "task_activities"("workspace_id", "task_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "task_activities_workspace_id_actor_id_created_at_id_idx" ON "task_activities"("workspace_id", "actor_id", "created_at", "id");

-- AddCheckConstraint
ALTER TABLE "task_comments"
    ADD CONSTRAINT "task_comments_content_length_check"
    CHECK ("content" IS NULL OR (char_length("content") BETWEEN 1 AND 10000));

-- AddCheckConstraint
ALTER TABLE "task_comments"
    ADD CONSTRAINT "task_comments_deleted_content_check"
    CHECK ("deleted_at" IS NULL OR "content" IS NULL);

-- AddCheckConstraint
ALTER TABLE "labels"
    ADD CONSTRAINT "labels_name_length_check"
    CHECK (char_length("name") BETWEEN 1 AND 50 AND btrim("name") <> '');

-- AddCheckConstraint
ALTER TABLE "labels"
    ADD CONSTRAINT "labels_name_key_check"
    CHECK (char_length("name_key") BETWEEN 1 AND 50 AND btrim("name_key") <> '');

-- AddCheckConstraint
ALTER TABLE "labels"
    ADD CONSTRAINT "labels_color_format_check"
    CHECK ("color" ~ '^#[0-9A-F]{6}$');

-- AddCheckConstraint
ALTER TABLE "task_activities"
    ADD CONSTRAINT "task_activities_event_version_check"
    CHECK ("event_version" > 0);

-- AddCheckConstraint
ALTER TABLE "task_activities"
    ADD CONSTRAINT "task_activities_payload_check"
    CHECK (
        jsonb_typeof("payload") = 'object'
        AND jsonb_typeof("payload"->'schemaVersion') = 'number'
        AND CASE
            WHEN "payload"->>'schemaVersion' ~ '^[1-9][0-9]*$'
            THEN ("payload"->>'schemaVersion')::integer = "event_version"
            ELSE false
        END
    );

-- AddForeignKey
ALTER TABLE "task_comments"
    ADD CONSTRAINT "task_comments_workspace_id_task_id_fkey"
    FOREIGN KEY ("workspace_id", "task_id") REFERENCES "tasks"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comments"
    ADD CONSTRAINT "task_comments_author_id_fkey"
    FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comments"
    ADD CONSTRAINT "task_comments_deleted_by_id_fkey"
    FOREIGN KEY ("deleted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labels"
    ADD CONSTRAINT "labels_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_labels"
    ADD CONSTRAINT "task_labels_workspace_id_task_id_fkey"
    FOREIGN KEY ("workspace_id", "task_id") REFERENCES "tasks"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_labels"
    ADD CONSTRAINT "task_labels_workspace_id_label_id_fkey"
    FOREIGN KEY ("workspace_id", "label_id") REFERENCES "labels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_activities"
    ADD CONSTRAINT "task_activities_workspace_id_task_id_fkey"
    FOREIGN KEY ("workspace_id", "task_id") REFERENCES "tasks"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_activities"
    ADD CONSTRAINT "task_activities_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Protect product activity history from direct updates/deletes while allowing parent cascades.
CREATE FUNCTION "prevent_task_activities_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;

    RAISE EXCEPTION 'task_activities are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "task_activities_immutable_trigger"
BEFORE UPDATE OR DELETE ON "task_activities"
FOR EACH ROW
EXECUTE FUNCTION "prevent_task_activities_mutation"();
