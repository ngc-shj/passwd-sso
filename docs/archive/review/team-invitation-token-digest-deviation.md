# Deviation Log: team-invitation-token-digest

Issue `#1054`. No Phase 1 plan file: the issue is the specification, and its
open choice (how to migrate) was decided by the owner before implementation.

## D1: one release, no expand/contract (owner decision)

The issue's migration renames the column in place. `deploy.sh` migrates before
it replaces the app, so until the rollout completes the previous release's
instances fail to issue, list, cancel or accept team invitations. The owner
chose this over two releases (add `token_hash`, then drop `token`), which would
have kept the plaintext in the database until the second release. Recorded in
`scripts/checks/destructive-migration-baseline.txt`, including that an app-image
rollback after the migration leaves invitations failing until the new image
returns.

## D2: a single DDL rewrite

`RENAME COLUMN`, then `ALTER COLUMN ... TYPE VARCHAR(64) USING
encode(sha256(convert_to(...)))`, then the index rename, in one transaction. A
DDL rewrite is not subject to row-level security or the
`enforce_tenant_id_from_context` trigger, so the RDS migrate role (table owner,
NOSUPERUSER NOBYPASSRLS) converts every row. An integration cell runs the
migration file as such a role over an old-shape row.

## D3: the pending-invitations list has no copy-link button

The list API has not returned the token since `8ed1710d6`, so the button copied
`/dashboard/teams/invite/undefined`. With a digest the link cannot be rebuilt.
The link is now displayed once, when the invitation is issued, next to a copy
button; a clipboard refusal no longer reports the invitation as failed (code
review F4).

## D4: no real rows on the dev database

The dev database held no `team_invitations` rows when the migration was first
applied. Row conversion is covered by the integration cell in D2.

## D5: the migration file changed after it was applied locally

Code review F1 added `BEGIN;`/`COMMIT;`. The shared dev database had applied the
earlier file, so its `_prisma_migrations.checksum` row was updated in place to
the new file's SHA-256 (the schema it produced is identical). No reset.
