BEGIN;

-- team-key-recipient-binding (#1076). A wrapped team key is written for a
-- recipient only while the public key the distributing client says it wrapped
-- to is the recipient's current one, and a recipient's key is not retired while
-- a wrapped key or a distributed flag for them survives
-- (docs/archive/review/team-key-recipient-binding-plan.md C1-C3, C9).
--
-- recipient_key_fingerprint is the lowercase hex SHA-256 of the UTF-8 bytes of
-- the exact users.ecdh_public_key string the client wrapped to
-- (recipientKeyFingerprint, src/lib/crypto/crypto-team.ts). It is the client's
-- claim: the server cannot see what a ciphertext was wrapped to, so this closes
-- the honest-client race of #1076, not a malicious distributor (who already
-- holds the team key). Rows written before this migration keep NULL.
--
-- Serialisation: the key-row guard reads the recipient's users row FOR KEY
-- SHARE, the lock the FK check on team_member_keys.user_id takes anyway. A
-- plain UPDATE of users takes FOR NO KEY UPDATE, which KEY SHARE does not
-- block, so the users guard upgrades its own row to FOR UPDATE before retiring
-- a key (P -> NULL); under READ COMMITTED its later read then sees any key row
-- a writer committed meanwhile. The upgrade happens inside the UPDATE, so a
-- transaction holding KEY SHARE on the row that then updates the same row can
-- deadlock with a raw retirement; vault reset, the one P -> NULL writer, takes
-- users FOR UPDATE first. Vault setup (NULL -> P) takes no upgrade.
--
-- Trigger order: same-event BEFORE triggers fire by name.
-- trg_team_member_keys_recipient_guard sorts after
-- trg_team_member_keys_departed_member_guard (a departed recipient gets that
-- guard's token first), and trg_users_ecdh_key_guard sorts after
-- trg_enforce_tenant_id_users, which writes only tenant_id. A later BEFORE
-- UPDATE trigger on users that sorts after trg_users_ecdh_key_guard and
-- rewrites ecdh_public_key would bypass it.
--
-- Both functions are SECURITY INVOKER with a pinned search_path and
-- schema-qualified names (an unpinned invoker function resolves `users` through
-- the caller's search_path, where a temp table shadows it). Their cross-table
-- reads use departed_member_guard's pattern: the caller's bypass settings are
-- saved, set to exactly the tables read, and restored before any RAISE. There
-- is no exception sub-block (it would give every row's lock read its own
-- subtransaction): an error from the read aborts the statement, and the
-- transaction-local settings roll back with it.
-- Messages carry the written row's own ids and a fixed arm token only.

ALTER TABLE "team_member_keys" ADD COLUMN "recipient_key_fingerprint" VARCHAR(64);
ALTER TABLE "team_member_keys" ADD CONSTRAINT "team_member_keys_recipient_key_fingerprint_check"
  CHECK ("recipient_key_fingerprint" IS NULL OR "recipient_key_fingerprint" ~ '^[0-9a-f]{64}$');

-- Judged: every INSERT, and an UPDATE that changes the wrap, its recipient,
-- its version or its fingerprint. Not judged: other UPDATEs, and DELETE.
CREATE OR REPLACE FUNCTION public.team_key_recipient_guard() RETURNS trigger
  LANGUAGE plpgsql
  VOLATILE
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_prev_rls text := current_setting('app.bypass_rls', true);
  v_prev_tables text := current_setting('app.bypass_tables', true);
  v_prev_purpose text := current_setting('app.bypass_purpose', true);
  v_wrap_changed boolean := true;
  v_key text;
  v_found boolean;
  v_refusal text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_wrap_changed := NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.encrypted_team_key IS DISTINCT FROM OLD.encrypted_team_key
      OR NEW.team_key_iv IS DISTINCT FROM OLD.team_key_iv
      OR NEW.team_key_auth_tag IS DISTINCT FROM OLD.team_key_auth_tag
      OR NEW.ephemeral_public_key IS DISTINCT FROM OLD.ephemeral_public_key
      OR NEW.hkdf_salt IS DISTINCT FROM OLD.hkdf_salt
      OR NEW.wrap_version IS DISTINCT FROM OLD.wrap_version
      OR NEW.key_version IS DISTINCT FROM OLD.key_version;
    IF NOT v_wrap_changed
       AND NEW.recipient_key_fingerprint IS NOT DISTINCT FROM OLD.recipient_key_fingerprint THEN
      RETURN NEW;
    END IF;
  END IF;

  IF NEW.recipient_key_fingerprint IS NULL THEN
    v_refusal := 'fingerprint_missing';
  ELSIF NOT v_wrap_changed THEN
    -- A fingerprint attached to a wrap nobody rewrote asserts an unchecked binding.
    v_refusal := 'fingerprint_rebind';
  ELSE
    PERFORM set_config('app.bypass_rls', 'on', true);
    PERFORM set_config('app.bypass_tables', 'users', true);
    PERFORM set_config('app.bypass_purpose', 'team_key_recipient_guard', true);

    SELECT u.ecdh_public_key, true INTO v_key, v_found
      FROM public.users u WHERE u.id = NEW.user_id
      FOR KEY SHARE;
    PERFORM set_config('app.bypass_rls', COALESCE(v_prev_rls, ''), true);
    PERFORM set_config('app.bypass_tables', COALESCE(v_prev_tables, ''), true);
    PERFORM set_config('app.bypass_purpose', COALESCE(v_prev_purpose, ''), true);

    IF v_found IS NOT TRUE OR v_key IS NULL THEN
      v_refusal := 'recipient_no_key';
    ELSIF encode(sha256(convert_to(v_key, 'UTF8')), 'hex') IS DISTINCT FROM NEW.recipient_key_fingerprint THEN
      v_refusal := 'recipient_key_changed';
    END IF;
  END IF;

  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'TEAM_KEY_RECIPIENT_GUARD:%: % (team %, user %)', v_refusal, TG_TABLE_NAME, NEW.team_id, NEW.user_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.team_key_recipient_guard() FROM PUBLIC;

CREATE TRIGGER trg_team_member_keys_recipient_guard
  BEFORE INSERT OR UPDATE ON "team_member_keys"
  FOR EACH ROW EXECUTE FUNCTION public.team_key_recipient_guard();

-- users.ecdh_public_key changes only NULL -> P (vault setup) or P -> NULL
-- (vault reset). Retiring a key is refused while the user holds a key row or a
-- distributed flag: every writer that sets key_distributed = true writes a key
-- row in the same transaction, so it holds this row FOR KEY SHARE and the
-- upgrade below waits for it. NULL -> P is not judged: no wrap can be bound to
-- a NULL key (the key-row guard refuses it).
CREATE OR REPLACE FUNCTION public.users_ecdh_key_guard() RETURNS trigger
  LANGUAGE plpgsql
  VOLATILE
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_prev_rls text := current_setting('app.bypass_rls', true);
  v_prev_tables text := current_setting('app.bypass_tables', true);
  v_prev_purpose text := current_setting('app.bypass_purpose', true);
  v_found boolean;
  v_refusal text;
BEGIN
  IF NEW.ecdh_public_key IS NOT DISTINCT FROM OLD.ecdh_public_key OR OLD.ecdh_public_key IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.ecdh_public_key IS NOT NULL THEN
    v_refusal := 'ecdh_key_overwrite';
  ELSE
    PERFORM set_config('app.bypass_rls', 'on', true);
    PERFORM set_config('app.bypass_tables', 'users,team_members,team_member_keys', true);
    PERFORM set_config('app.bypass_purpose', 'users_ecdh_key_guard', true);

    PERFORM 1 FROM public.users u WHERE u.id = NEW.id FOR UPDATE;
    v_found := FOUND;
    IF v_found AND (
         EXISTS (SELECT 1 FROM public.team_member_keys k WHERE k.user_id = NEW.id)
         OR EXISTS (SELECT 1 FROM public.team_members m WHERE m.user_id = NEW.id AND m.key_distributed)) THEN
      v_refusal := 'ecdh_key_change_with_keys';
    END IF;
    PERFORM set_config('app.bypass_rls', COALESCE(v_prev_rls, ''), true);
    PERFORM set_config('app.bypass_tables', COALESCE(v_prev_tables, ''), true);
    PERFORM set_config('app.bypass_purpose', COALESCE(v_prev_purpose, ''), true);

    IF NOT v_found THEN
      v_refusal := 'recipient_row_unlocked';
    END IF;
  END IF;

  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'TEAM_KEY_RECIPIENT_GUARD:%: % (user %)', v_refusal, TG_TABLE_NAME, NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.users_ecdh_key_guard() FROM PUBLIC;

CREATE TRIGGER trg_users_ecdh_key_guard
  BEFORE UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION public.users_ecdh_key_guard();

-- C9: rows bound to a NULL key are pre-fix race residue (a confirm-key that
-- committed after a vault reset). Vault reset, the one P -> NULL writer, erases
-- the encrypted private key in the same UPDATE, so no key the user holds can
-- open these wraps; they only block redistribution (KEY_ALREADY_DISTRIBUTED)
-- and, for a flagged member, every rotation of the team. Repairing them makes
-- the member pending again.
--
-- Placement: after CREATE TRIGGER on team_member_keys, whose SHARE ROW
-- EXCLUSIVE lock is held to this migration's commit. It waits for any
-- transaction that already wrote a key row, so the repair sees that row, and
-- blocks later key writes until commit, after which the key-row guard refuses
-- them. Run before the triggers, residue committed in between would be missed.
--
-- Every table is under FORCE RLS and the RDS migrate role is NOSUPERUSER
-- NOBYPASSRLS, so the block grants itself exactly these tables, transaction-
-- locally, and restores the previous settings. `prisma migrate deploy` does not
-- print the NOTICE; it reaches the server log at log_min_messages = notice or
-- lower, or a psql run of the block.
-- BEGIN BACKFILL team-key-residue
DO $$
DECLARE
  v_prev_rls text := current_setting('app.bypass_rls', true);
  v_prev_tables text := current_setting('app.bypass_tables', true);
  v_prev_purpose text := current_setting('app.bypass_purpose', true);
  v_prev_tenant text := current_setting('app.tenant_id', true);
  n_keys integer;
  n_flags integer;
BEGIN
  PERFORM set_config('app.bypass_rls', 'on', true);
  PERFORM set_config('app.bypass_tables', 'users,team_members,team_member_keys', true);
  PERFORM set_config('app.bypass_purpose', 'system_maintenance', true);
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true);

  DELETE FROM team_member_keys k
   USING users u
   WHERE u.id = k.user_id AND u.ecdh_public_key IS NULL;
  GET DIAGNOSTICS n_keys = ROW_COUNT;

  UPDATE team_members m
     SET key_distributed = false
    FROM users u
   WHERE u.id = m.user_id AND u.ecdh_public_key IS NULL AND m.key_distributed;
  GET DIAGNOSTICS n_flags = ROW_COUNT;

  RAISE NOTICE 'team-key-residue: key_rows=% flags=%', n_keys, n_flags;

  PERFORM set_config('app.bypass_rls', COALESCE(v_prev_rls, ''), true);
  PERFORM set_config('app.bypass_tables', COALESCE(v_prev_tables, ''), true);
  PERFORM set_config('app.bypass_purpose', COALESCE(v_prev_purpose, ''), true);
  PERFORM set_config('app.tenant_id', COALESCE(v_prev_tenant, ''), true);
END $$;
-- END BACKFILL team-key-residue

COMMIT;
