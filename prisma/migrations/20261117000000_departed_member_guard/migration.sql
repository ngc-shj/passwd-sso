BEGIN;

-- departed-member-db-invariants (#1060). The two departed-member invariants,
-- held by the database instead of by application code and an AST gate that
-- reads spellings (check-team-rotation-input-lock.mjs rule 8, retired):
--
--   I1 no grant reaches a leftover membership (an active team_members row whose
--      user departed the team's tenant at or after the row's admission), and no
--      membership is activated while its user's tenant row is departed;
--   I2 a transaction that departs a user from a tenant does not commit while the
--      user, departed, holds an active membership of the tenant's teams (or, with
--      the tenant row active at commit, a leftover one).
--
-- departure = GREATEST(tenant_members.deactivated_at, tenant_member_departures.departed_at),
-- admission = COALESCE(team_members.admitted_at, team_members.created_at); equality
-- refuses. The same predicate as actorDepartedSinceAdmission
-- (src/lib/team/tenant-departure-read.ts) and share_creator_admitted.
--
-- Not judged (docs/archive/review/departed-member-db-invariants-plan.md Q3, Q6):
-- undoing a departure (a return, or deleting the tenant row: the bootstrap
-- migration does both legitimately), TRUNCATE, re-homing a team, and a key row
-- for a user with no team_members row. Roles that can disable triggers bypass it.
--
-- Serialisation: an activation and the departure check take the advisory key
-- tenant-member:<tenant>:<user> (tenant-row-lock.ts advisoryKey), which every
-- application writer already holds at that point; grants take no lock (a grant
-- changes a row already active, which the departure check sees either way). The
-- lock argument needs READ COMMITTED, so the lock branches refuse anything else.
--
-- The trigger on team_members must fire after team_members_set_admitted_at
-- (NEW carries the trigger-owned admission) and after
-- trg_enforce_tenant_id_team_members (NEW carries a derived tenant_id):
-- same-event BEFORE triggers fire in name order, and trg_t... sorts last.
--
-- Cross-table reads use share_creator_admitted's pattern: the caller's bypass
-- settings are saved, set to exactly the four tables read, and restored before
-- any RAISE. Messages carry the written row's own ids and a fixed arm token only.
CREATE OR REPLACE FUNCTION public.departed_member_guard() RETURNS trigger
  LANGUAGE plpgsql
  VOLATILE
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_prev_rls text := current_setting('app.bypass_rls', true);
  v_prev_tables text := current_setting('app.bypass_tables', true);
  v_prev_purpose text := current_setting('app.bypass_purpose', true);
  v_tenant uuid;
  v_user uuid;
  v_activation boolean := false;
  v_grant boolean := false;
  v_new_rank integer;
  v_old_rank integer;
  v_team_tenant uuid;
  v_departed_at timestamptz;
  v_row_departed boolean;
  v_has_row boolean;
  v_has_record boolean;
  v_member_ended boolean;
  v_refusal text;
BEGIN
  IF TG_TABLE_NAME = 'tenant_member_departures' AND TG_WHEN = 'BEFORE' THEN
    IF NEW.departed_at < OLD.departed_at THEN
      RAISE EXCEPTION 'DEPARTED_MEMBER_GUARD:record_lowered: departure record (tenant %, user %)', NEW.tenant_id, NEW.user_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'team_members' THEN
    IF TG_OP = 'UPDATE' AND NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'DEPARTED_MEMBER_GUARD:created_at: team membership % (tenant %, user %)', NEW.id, NEW.tenant_id, NEW.user_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.deactivated_at IS NULL THEN
      IF TG_OP = 'INSERT' OR OLD.deactivated_at IS NOT NULL
         OR (NEW.tenant_id, NEW.user_id, NEW.team_id) IS DISTINCT FROM (OLD.tenant_id, OLD.user_id, OLD.team_id) THEN
        v_activation := true;
      ELSE
        v_new_rank := CASE NEW.role WHEN 'OWNER' THEN 3 WHEN 'ADMIN' THEN 2 WHEN 'MEMBER' THEN 1 WHEN 'VIEWER' THEN 0 END;
        v_old_rank := CASE OLD.role WHEN 'OWNER' THEN 3 WHEN 'ADMIN' THEN 2 WHEN 'MEMBER' THEN 1 WHEN 'VIEWER' THEN 0 END;
        IF v_new_rank IS NULL OR v_old_rank IS NULL THEN
          RAISE EXCEPTION 'DEPARTED_MEMBER_GUARD:unknown_role: team membership % (tenant %, user %)', NEW.id, NEW.tenant_id, NEW.user_id
            USING ERRCODE = 'check_violation';
        END IF;
        v_grant := v_new_rank > v_old_rank OR (NEW.key_distributed AND NOT OLD.key_distributed);
      END IF;
    END IF;
  END IF;

  v_tenant := NEW.tenant_id;
  v_user := NEW.user_id;

  -- Activations and departures serialise on the application's tenant-member key.
  IF v_activation OR TG_WHEN = 'AFTER' THEN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'DEPARTED_MEMBER_GUARD:isolation: % must run under READ COMMITTED (tenant %, user %)', TG_TABLE_NAME, v_tenant, v_user
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('tenant-member:' || v_tenant::text || ':' || v_user::text));
  END IF;

  BEGIN
    PERFORM set_config('app.bypass_rls', 'on', true);
    PERFORM set_config('app.bypass_tables', 'teams,team_members,tenant_members,tenant_member_departures', true);
    PERFORM set_config('app.bypass_purpose', 'departed_member_guard', true);

    SELECT EXISTS (SELECT 1 FROM tenant_members tm WHERE tm.tenant_id = v_tenant AND tm.user_id = v_user),
           EXISTS (SELECT 1 FROM tenant_members tm WHERE tm.tenant_id = v_tenant AND tm.user_id = v_user AND tm.deactivated_at IS NOT NULL),
           EXISTS (SELECT 1 FROM tenant_member_departures d WHERE d.tenant_id = v_tenant AND d.user_id = v_user),
           GREATEST(
             (SELECT tm.deactivated_at FROM tenant_members tm WHERE tm.tenant_id = v_tenant AND tm.user_id = v_user),
             (SELECT d.departed_at FROM tenant_member_departures d WHERE d.tenant_id = v_tenant AND d.user_id = v_user))
      INTO v_has_row, v_row_departed, v_has_record, v_departed_at;

    IF TG_TABLE_NAME = 'team_members' THEN
      SELECT t.tenant_id INTO v_team_tenant FROM teams t WHERE t.id = NEW.team_id;
      IF v_team_tenant IS DISTINCT FROM v_tenant THEN
        v_refusal := 'tenant_mismatch';
      ELSIF v_activation AND v_row_departed THEN
        v_refusal := 'activation_departed';
      ELSIF (v_activation OR v_grant)
            AND (v_departed_at >= COALESCE(NEW.admitted_at, NEW.created_at)) IS TRUE THEN
        v_refusal := CASE WHEN v_activation THEN 'activation_leftover' ELSE 'grant_leftover' END;
      END IF;
    ELSIF TG_TABLE_NAME = 'team_member_keys' THEN
      SELECT t.tenant_id INTO v_team_tenant FROM teams t WHERE t.id = NEW.team_id;
      SELECT m.deactivated_at IS NOT NULL INTO v_member_ended
        FROM team_members m WHERE m.team_id = NEW.team_id AND m.user_id = v_user;
      IF v_team_tenant IS DISTINCT FROM v_tenant THEN
        v_refusal := 'tenant_mismatch';
      ELSIF v_member_ended THEN
        v_refusal := 'key_inactive';
      ELSIF EXISTS (
              SELECT 1 FROM team_members m
               WHERE m.team_id = NEW.team_id AND m.user_id = v_user AND m.tenant_id = v_tenant
                 AND m.deactivated_at IS NULL
                 AND (v_departed_at >= COALESCE(m.admitted_at, m.created_at)) IS TRUE) THEN
        v_refusal := 'key_leftover';
      END IF;
    ELSE
      -- Deferred departure check, against the state at commit. Departed now: the
      -- tenant row is deactivated, or there is no row and a record exists.
      IF v_row_departed OR (NOT v_has_row AND v_has_record) THEN
        IF EXISTS (SELECT 1 FROM team_members m
                    WHERE m.tenant_id = v_tenant AND m.user_id = v_user AND m.deactivated_at IS NULL) THEN
          v_refusal := 'departure_active';
        END IF;
      ELSIF EXISTS (
              SELECT 1 FROM team_members m
               WHERE m.tenant_id = v_tenant AND m.user_id = v_user AND m.deactivated_at IS NULL
                 AND (v_departed_at >= COALESCE(m.admitted_at, m.created_at)) IS TRUE) THEN
        v_refusal := 'departure_leftover';
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE;
  END;
  PERFORM set_config('app.bypass_rls', COALESCE(v_prev_rls, ''), true);
  PERFORM set_config('app.bypass_tables', COALESCE(v_prev_tables, ''), true);
  PERFORM set_config('app.bypass_purpose', COALESCE(v_prev_purpose, ''), true);

  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'DEPARTED_MEMBER_GUARD:%: % (tenant %, user %)', v_refusal, TG_TABLE_NAME, v_tenant, v_user
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.departed_member_guard() FROM PUBLIC;

CREATE TRIGGER trg_team_members_departed_member_guard
  BEFORE INSERT OR UPDATE ON "team_members"
  FOR EACH ROW EXECUTE FUNCTION public.departed_member_guard();

CREATE TRIGGER trg_team_member_keys_departed_member_guard
  BEFORE INSERT OR UPDATE ON "team_member_keys"
  FOR EACH ROW EXECUTE FUNCTION public.departed_member_guard();

CREATE TRIGGER trg_tenant_member_departures_stamp_guard
  BEFORE UPDATE ON "tenant_member_departures"
  FOR EACH ROW EXECUTE FUNCTION public.departed_member_guard();

CREATE CONSTRAINT TRIGGER tenant_members_departure_ends_memberships_ins
  AFTER INSERT ON "tenant_members"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.deactivated_at IS NOT NULL)
  EXECUTE FUNCTION public.departed_member_guard();

CREATE CONSTRAINT TRIGGER tenant_members_departure_ends_memberships_upd
  AFTER UPDATE OF deactivated_at, tenant_id, user_id ON "tenant_members"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.deactivated_at IS NOT NULL
                     AND (NEW.deactivated_at, NEW.tenant_id, NEW.user_id) IS DISTINCT FROM (OLD.deactivated_at, OLD.tenant_id, OLD.user_id))
  EXECUTE FUNCTION public.departed_member_guard();

CREATE CONSTRAINT TRIGGER tenant_member_departures_ends_memberships
  AFTER INSERT OR UPDATE ON "tenant_member_departures"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.departed_member_guard();

-- The departure check reads a departing user's rows by (tenant_id, user_id).
CREATE INDEX "team_members_tenant_id_user_id_idx" ON "team_members"("tenant_id", "user_id");

COMMIT;
