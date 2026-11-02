-- #990. A team-entry share is client-encrypted (master_key_version = 0): the
-- server never holds its key. Checked for new rows only (NOT VALID): shares
-- created before E2E team sharing may remain, expired. share_creator_admitted
-- also treats any row with a team entry as a team share, so it does not rely on
-- this constraint.
ALTER TABLE "password_shares"
  ADD CONSTRAINT "password_shares_team_share_client_encrypted"
  CHECK ("team_password_entry_id" IS NULL OR "master_key_version" = 0) NOT VALID;
