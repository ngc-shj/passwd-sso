BEGIN;

-- #921 (enforce flip). `rls_bypass_admits` already raises the WARNING for a
-- table outside the bypass's grant; with this function returning true it then
-- raises 42501 `RLS_BYPASS_NOT_GRANTED`, so the statement is refused instead of
-- admitted. The WARNING is still raised first, so the report keeps counting.
--
-- Un-flip: the same function returning false, run as the migration role; see
-- docs/operations/deployment.md.

CREATE OR REPLACE FUNCTION public.rls_bypass_enforced() RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT true $$;

COMMIT;
