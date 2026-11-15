BEGIN;

-- departed-member-leaked-authority C2. When a team membership row is
-- re-activated (deactivated_at: NOT NULL -> NULL) on the SAME row, created_at
-- no longer says when the member was last admitted, so an actor-authority check
-- ("did this actor depart after they were admitted?") cannot read it. This
-- column records the re-activation instant; the effective admission time is
-- COALESCE(admitted_at, created_at).
--
-- A BEFORE row trigger owns the value so the application cannot set it:
--   INSERT                  -> NULL (a supplied value is discarded)
--   re-activating UPDATE    -> clock_timestamp() (wall-clock time of the
--                              statement, not the transaction start, so it is
--                              later than any departure committed before it)
--   any other UPDATE        -> unchanged (OLD value), whatever NEW carries
-- The trigger touches only NEW and OLD of the same row, so it is RLS-agnostic
-- and needs no bypass context.
--
-- No backfill: a row re-activated before this migration cannot be told apart
-- from one never re-activated, and guessing an admission time would either
-- revive departed authority or invent one. Such an actor reads as admitted at
-- created_at and is refused if departed since (fail-closed) until re-admitted.
ALTER TABLE "team_members" ADD COLUMN "admitted_at" TIMESTAMPTZ(3);

CREATE OR REPLACE FUNCTION team_members_set_admitted_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.admitted_at := NULL;
  ELSIF OLD.deactivated_at IS NOT NULL AND NEW.deactivated_at IS NULL THEN
    NEW.admitted_at := clock_timestamp();
  ELSE
    NEW.admitted_at := OLD.admitted_at;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION team_members_set_admitted_at() FROM PUBLIC;

CREATE TRIGGER team_members_set_admitted_at
  BEFORE INSERT OR UPDATE ON "team_members"
  FOR EACH ROW EXECUTE FUNCTION team_members_set_admitted_at();

COMMIT;
