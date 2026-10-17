-- Redact legacy TASK_UPDATED description values before the new writer is used.
-- The trigger is disabled only for this transactional maintenance update and
-- is explicitly re-enabled before the migration completes.
ALTER TABLE "task_activities" DISABLE TRIGGER "task_activities_immutable_trigger";

UPDATE "task_activities"
SET "payload" = jsonb_set(
    "payload",
    '{changes}',
    ("payload"->'changes')
      - 'description'
      || jsonb_build_object('descriptionChanged', true),
    false
)
WHERE "type" = 'TASK_UPDATED'
  AND jsonb_typeof("payload"->'changes') = 'object'
  AND jsonb_typeof("payload"->'changes'->'description') = 'object'
  AND (
    ("payload"->'changes'->'description') ? 'from'
    OR ("payload"->'changes'->'description') ? 'to'
  );

ALTER TABLE "task_activities" ENABLE TRIGGER "task_activities_immutable_trigger";
