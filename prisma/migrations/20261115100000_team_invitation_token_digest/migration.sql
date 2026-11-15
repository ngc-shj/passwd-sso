-- #1054. team_invitations.token held the invitation secret itself; every other
-- stored bearer secret is a SHA-256 digest (token_hash). The column is hashed in
-- place and renamed, so an invitation already sent stays acceptable: the value
-- is the one hashToken computes (SHA-256 of the UTF-8 string, lowercase hex).
--
-- ALTER COLUMN ... TYPE ... USING rewrites the table as DDL: row-level security
-- and the enforce_tenant_id_from_context trigger do not apply, so the RDS
-- migrate role (NOSUPERUSER NOBYPASSRLS, the table owner) converts every row.
--
-- One release, no expand/contract: deploy.sh migrates before it replaces the
-- app, so until the rollout completes the previous release's instances fail
-- to issue or accept an invitation (they name a column that no longer exists).

BEGIN;

ALTER TABLE "team_invitations" RENAME COLUMN "token" TO "token_hash";

ALTER TABLE "team_invitations"
  ALTER COLUMN "token_hash" SET DATA TYPE VARCHAR(64)
  USING encode(sha256(convert_to("token_hash", 'UTF8')), 'hex');

ALTER INDEX "team_invitations_token_key" RENAME TO "team_invitations_token_hash_key";

COMMIT;
