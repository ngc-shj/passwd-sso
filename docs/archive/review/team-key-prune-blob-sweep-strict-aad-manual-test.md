# Manual Test: team-key-prune-blob-sweep-strict-aad

Deployment artifacts touched: `docker-compose.workers.yml`, `docker-compose.override.yml`
(comments only — the retention GC worker already receives `.env`). Behaviour changes ship in the
retention GC worker bundle (two new sweeps, `--init-blob-marker`) and in the web and extension
team entry crypto paths. Tier-2: key-material deletion and AAD binding.

## Pre-conditions

- Dev stack up (`npm run docker:up`), migrations applied (`npm run db:migrate`), dev server on
  :3001, MinIO running.
- A team with at least two members, several entries, one attachment, and one history version.
- For the blob sweep: `BLOB_BACKEND=s3`, `S3_ATTACHMENTS_BUCKET`, `AWS_ENDPOINT_URL_S3` pointing at
  MinIO, `S3_FORCE_PATH_STYLE=true`, a unique `DEPLOYMENT_ID` in `.env`; the app and the worker
  read the same values.

## Steps and expected results

### A. Team key prune (`#1009`)

1. With `RETENTION_GC_TEAM_KEY_PRUNE_ENABLED` unset, rotate the team key twice and run the
   re-key pass from the team settings. Restart the worker. Expected: `team_member_keys` still
   holds versions 1–3 for every member; heartbeat `perTable` has no `team_member_keys` entry.
2. Set `RETENTION_GC_TEAM_KEY_PRUNE_ENABLED=true`, restart the worker, wait one tick. Expected:
   versions no entry / history row / mode-0 attachment references are gone for every member;
   the current version remains; the team audit log shows one `TEAM_MEMBER_KEY_PRUNED` row with
   the pruned versions and holder ids.
3. Open every entry, its history, and download the attachment. Expected: all open; no
   "key not available" error.
4. Restore an old history version created before the rotations, then wait one tick. Expected:
   the version the restored entry now references is not pruned; the entry opens.

### B. Orphaned attachment objects (`#1010`)

1. `RETENTION_GC_BLOB_SWEEP_MODE=report`, no marker. Expected: tick logs `marker_missing`,
   `counts.attachment_objects = -1`, nothing written to the bucket.
2. Run `node dist/retention-gc-worker.js --init-blob-marker` (or `npx tsx
   scripts/retention-gc-worker.ts --init-blob-marker`). Expected: `created`; a second run prints
   `exists` and the marker body is unchanged.
3. Reproduce a cleanup failure after commit: with the row referencing the old generation,
   upload a new generation object; update the row's ref to the new generation and commit; skip
   the old generation's delete. (An object uploaded with no row ever committed — a failure
   before commit — is the other orphan shape and is swept the same way.) With `report` mode and
   `RETENTION_GC_BLOB_ORPHAN_GRACE_MS=3600000`, wait past the grace period (or set the object's
   age via MinIO) and one tick. Expected: log counts `wouldDelete: 1` for the old generation;
   nothing deleted; the new generation is counted as referenced.
4. Switch to `delete` without `RETENTION_GC_BLOB_ORPHAN_GRACE_MS`. Expected: the worker refuses to
   boot (env validation). Set it and restart. Expected: the orphan is deleted; the live
   attachment still downloads.

### C. Strict team entry AAD (`#1012`)

1. Create, edit, and view a team login entry in the web app; view and restore a history version;
   export the team; import a CSV into the team. Expected: all succeed.
2. In the browser extension, list team entries and fill a team login. Expected: titles and
   credentials appear as before.
3. Open the history of an entry created before AAD (legacy, if one exists in the dev data).
   Expected: viewable; restore refused with the existing "legacy history row" message.

## Adversarial scenarios

- Shared bucket: point a second checkout (different `DEPLOYMENT_ID`) at the same bucket and
  prefix in `delete` mode. Expected: `marker_mismatch`, nothing deleted.
- Wrong database: point the worker at an empty database with the real bucket and marker.
  Expected: `breaker` (no referenced key seen in the pass), nothing deleted.
- Cross-tenant: two tenants each with a team; prune runs; each tenant sees only its own team's
  `TEAM_MEMBER_KEY_PRUNED` rows.
- Privilege: as `passwd_app`, `SELECT team_member_key_prune(10)` → permission denied; as the
  worker role outside the bypass → 42501.
- AAD tampering: swap a team entry's `encryptedBlob` with its `encryptedOverview` in the DB.
  Expected: the entry fails to open (decrypt error), web and extension.

## Rollback

- Set `RETENTION_GC_TEAM_KEY_PRUNE_ENABLED=false` and `RETENTION_GC_BLOB_SWEEP_MODE=off`; restart
  the worker. Pruned keys and deleted objects are not recoverable except from DB backups /
  bucket versioning — hence both default off.
- Code rollback: once the prune has run, `TEAM_MEMBER_KEY_PRUNED` audit rows exist. A rollback
  keeps the `AuditAction` enum value, `AUDIT_ACTION` / `AUDIT_ACTION_VALUES`, the audit groups and
  the en/ja labels, so those rows still filter, display and verify; revert only the sweep code
  (or leave the kill switch off). The `team_member_key_prune` function is removed, if at all, by a
  forward migration that revokes EXECUTE and drops it, with `db-grants-manifest.json`,
  `bootstrap-rds-roles.mjs` and the `[E-RLS-SECDEF]` allowlist updated in the same change —
  never by a manual `DROP`.
