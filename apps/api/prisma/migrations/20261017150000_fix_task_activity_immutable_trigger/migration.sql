-- Allow PostgreSQL's internal ON DELETE SET NULL action to update actor_id
-- while keeping direct application UPDATE/DELETE operations blocked.
CREATE OR REPLACE FUNCTION "prevent_task_activities_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF pg_trigger_depth() > 1 THEN
        IF TG_OP = 'UPDATE' THEN
            RETURN NEW;
        END IF;

        RETURN OLD;
    END IF;

    RAISE EXCEPTION 'task_activities are immutable' USING ERRCODE = '55000';
END;
$$;
