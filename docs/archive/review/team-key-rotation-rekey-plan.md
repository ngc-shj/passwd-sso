# Plan: team-key-rotation-rekey (v10)

Branch: `fix/team-key-rotation-rekey`. Issue `#988`. User decisions (2026-11-04): full re-key;
executed as a per-entry re-key pass after rotation. Review record:
`team-key-rotation-rekey-review.md`.

## Project context

- Type: web app (Next.js 16 + Prisma 7 + PostgreSQL 16, RLS with FORCE), E2E-encrypted; web,
  browser extension and iOS clients decrypt team entries.
- Test infrastructure: unit + real-DB integration + E2E + CI/CD; iOS tests on the macOS build
  host.
- Verification environment constraints: VE1 — external blob backends are exercised only
  through the dev MinIO (S3 API); Azure/GCS `blocked-deferred` (same `BlobStore` contract, no
  local emulator; covered by unit tests of their `buildObjectKey`/ref handling). VE2 — iOS
  parity vectors run on the macOS build host (`verifiable-local` there).

## Objective

Rotation re-wraps each entry's ItemKey but never replaces it, so an entry's live blob, history
and attachments stay under one ItemKey forever: a member who left holding it (or an old team
key plus an old wrap) reads that entry's history, attachments and later edits from any
ciphertext obtained later.

After this change a rotation is followed by a **re-key pass**: each entry gets a new ItemKey;
its blob/overview and every history row are re-encrypted under it; every attachment's CEK is
re-wrapped under it. Content written to an entry after it is re-keyed is unreadable with the
old ItemKey.

Stated limits: until an entry is re-keyed, edits to it still use the old ItemKey (the pass
starts right after rotation and admins see the pending count); history rows the re-keyer
cannot open are retained under their old wrap (no worse than today); entries no active member
can open are carried unchanged and counted as unrecoverable; entries carried on a holder's
`undecryptable` / `key_invalid` claim stay readable by every holder of their old version,
departed members included, until another holder re-keys them (shown in the pending count and
the rotation audit); CEKs are re-wrapped, not replaced
(SC1); downloaded material and backups/WAL/versioned buckets keep old keys (SC1, SC5);
re-keyed history and migrated attachments keep their original attribution although an admin
rewrote the ciphertext (C8).

## Contracts

### C1 Entry key identity

- `team_password_entries.item_key_team_key_version int NOT NULL DEFAULT 0` — team key version
  at which the current ItemKey was created. Raised **only** by entry create (no history yet)
  and the re-key POST. A v0→v1 PUT upgrade and an edit keep it; a restore sets 0 unless the
  restored row's `item_key_id` equals the live one. `DEFAULT 0` is fail-safe (a missed writer leaves the entry pending).
  Backfill: `1` for teams with `team_key_version = 1`, else `0`.
- "Pending" = marker < `teams.team_key_version` (trashed and archived included).
- `team_password_entries.item_key_version_high_water int NOT NULL DEFAULT 0`, never lowered
  (backfill: max of the entry's `item_key_version`, its history `item_key_version` and its
  attachments' `cek_key_version`). A new ItemKey (re-key or v0→v1
  upgrade) gets `high_water + 1`; the server returns it as `nextItemKeyVersion` in the entry
  GET and the re-key GET and **recomputes** it under the entry lock (409
  `ITEM_KEY_VERSION_INVALID` otherwise, for the upgrade PUT and the re-key POST alike). IV
  uniqueness rests on random 96-bit IVs; the server additionally rejects a new wrap whose
  `itemKeyIv` equals the locked row's or a history wrap's (400 `ITEM_KEY_IV_REUSED`) — this
  catches a client echoing the snapshot IV back.
- ItemKey identity: `item_key_id uuid` on entries, copied into history rows, and
  `attachments.cek_item_key_id` — a server CSPRNG id written when an ItemKey is created
  (create — minted in `createTeamPassword`, so bulk import is covered — v0→v1 upgrade, re-key)
  and **unchanged by rotation's re-wrap**. Backfill `gen_random_uuid()` for every entry with
  `item_key_version ≥ 1`, then copy the entry's id into each history row whose
  (`encrypted_item_key`, `item_key_iv`, `item_key_auth_tag`, `team_key_version`,
  `item_key_version`) all equal the entry's; on `team_password_entries` only,
  `CHECK ((item_key_version = 0) = (item_key_id IS NULL))` added inside the backfill block
  after the UPDATEs. Raw-SQL test seeders of v1+ entries gain `item_key_id`. Other legacy
  history rows and v0 entries keep NULL. NULL never equals anything (one comparison helper):
  a client sending null, or a locked row holding null, fails the comparison; a restore of a
  NULL-id row at `item_key_version ≥ 1` mints a fresh id for the entry (marker 0), a v0 row
  leaves it NULL; restore otherwise copies the row's id (the raw-SQL
  snapshot column list in the restore route gains the column). A full update that reuses the
  ItemKey, and an attachment upload or migrate, send the `itemKeyId` they used; the server
  compares it with the locked row (409 `ITEM_KEY_CHANGED`, checked before
  `ENTRY_REKEY_REQUIRED` and `CEK_KEY_VERSION_MISMATCH`) and writes `cek_item_key_id` from
  the locked row, never from the client. The client cache (C5) is keyed by it and never
  caches under a null id. The upgrade is identified by the
  locked `itemKeyVersion = 0` plus the blobIv snapshot. A full update of a v1+ entry whose
  `teamKeyVersion` is not current is refused (409 `ENTRY_REKEY_REQUIRED`); the v0→v1 upgrade
  is exempt (it writes a wrap under the current team key and leaves the marker unchanged), as
  are metadata-only PUTs (archive toggle) from both this and the `itemKeyId` check.
- Team key versions `< 1` are treated as 1 everywhere on the server (as clients already do).
- Holder of version v = a `team_member_keys` row at `key_version` v whose `team_members` row
  has `deactivated_at IS NULL`; a re-keyer holder is a holder whose role has `TEAM_UPDATE`.
  Authoritative under rotation's team lock; best-effort in restore (removal and departure
  take the same FOR SHARE lock). Entry states reported by the pass: "needs re-keyer holder"
  (listing the holders who can), "holder cannot re-key" (only non-TEAM_UPDATE holders —
  exits, least privilege first: restore a current-version row, delete, or a temporary
  promotion audited with the entry ids), and "unrecoverable" (no holder; time-varying, a
  member returning to the tenant becomes a holder again; exits: restore a current-version
  row, or delete — the delete warns when a tenant-deactivated member holds v).
  "Undecryptable" is not a server state: it is the pass runner's report for an entry whose
  ciphertext fails AES-GCM under a team key the actor's own member-key wrap authenticated.
  The actor's distributed key may itself be wrong, so the `undecryptable` / `key_invalid`
  reports never suggest deleting: they name another holder of v as the exit (when the actor
  is the only active holder: "restore a current-version history row, or compare keys with
  an admin"), and add the key suspicion when more than half of the actor's entries at v, and
  at least 2, fail. Deleting stays the ordinary entry
  delete. A member-key row that fails to unwrap: the resolver returns `key_invalid`; in a
  rotation the entries at v are carried with reason `key_invalid` (same holder rule as
  `undecryptable`) and the rest proceeds; in the pass the live entry is skipped and reported
  and history rows at v are retained; the report says "your key for v is broken — another
  holder of v re-keys" (old versions cannot be redistributed: confirm-key accepts only the
  current version). Retained rows are revisited only if a holder of their version re-keys the entry
  first after the next rotation (an ordering dependence; the pass report lists who can).

### C2 Re-key pass endpoints

- `GET /api/teams/[teamId]/rekey?after=<id>&limit=<n>` → `{ pendingCount, stateCounts,
  retainedHistoryCount, entryIds[] }`, keyset page (limit bounded). Retained history rows are
  revisited only when the entry becomes pending again at the next rotation (no revisit of a
  non-pending entry — S2-2 bound kept).
- `GET /api/teams/[teamId]/passwords/[id]/rekey` → entry, its history rows, its attachments (no
  body), `nextItemKeyVersion`.
- `POST /api/teams/[teamId]/passwords/[id]/rekey`: snapshot (`blobIv`, `overviewIv`,
  `itemKeyIv`, `itemKeyVersion`), new blob/overview, `newItemKeyVersion`, new wrap under the
  current team key, `history[]` (id, snapshot blobIv, new blob), `attachmentCekRewraps[]` (id,
  snapshot cekIv, new wrap), `retainHistoryIds[]`.
- Authorization: `TEAM_UPDATE` + step-up; rate limit per (team, user); GETs limited too.
- Transaction (refusals checked before the body is parsed where possible), each refusal with
  its own code: `lockTeamKeyVersion` (FOR SHARE), the entry row FOR UPDATE, role re-check
  (403 `ACTOR_NOT_PERMITTED`), pending (409 `REKEY_NOT_PENDING`), team key version current
  (409 `TEAM_KEY_VERSION_CHANGED`), snapshot (409 `REKEY_SNAPSHOT_MISMATCH`), version
  (409 `ITEM_KEY_VERSION_INVALID`, recomputed high-water + 1), IV reuse (400
  `ITEM_KEY_IV_REUSED`); the entry's history and attachments read FOR UPDATE and compared as
  exact sets (409 `REKEY_SET_MISMATCH`); mode 0/1 attachment present (409
  `REKEY_ATTACHMENTS_UNMIGRATED`); CAS updates (history on blobIv, attachment on cekIv;
  count ≠ 1 → 409 `REKEY_SNAPSHOT_MISMATCH`) writing the entry's new versions, wrap and
  `aadVersion` and the new `item_key_id` into every non-retained history row and
  `keyVersion`/`cekKeyVersion`/`cek_item_key_id` into attachments; retained rows are left
  unchanged (old id); marker = current, high-water raised;
  post-write check `assertEntryRekeyConsistent` (500 `REKEY_POSTCHECK_FAILED`: non-retained
  rows and attachments carry the entry's id, versions and wrap; retained rows do not); `enqueueAuditInTx` `TEAM_ENTRY_REKEY` (target entry; from/to versions;
  retained ids and their versions).
- Control class: fail-closed verification gate.

### C3 Rotation and the pass runner (client)

- React-free modules in `src/lib/team/`: `buildRotationEntryPayload(entry, resolveKey)`,
  `buildEntryRekeyPayload(data, resolveKey)`, `runRekeyPass(deps)` (injected fetch and key
  resolver); the rotation button and a "Finish re-key (N)" control (TEAM_UPDATE holders) use
  them.
- Key resolution returns `{ key } | { reason: "not_available" | "transient" | "key_invalid" }`
  (exported).
- Rotation: each entry with its own team key version. An entry the actor cannot open is
  sent in `carry[]` with a reason: `not_held` (accepted when the actor holds no
  `TeamMemberKey` at its normalised version — server-verified) or `undecryptable` (an AES-GCM
  authentication failure under a key the actor's member-key wrap authenticated) or
  `key_invalid` (the actor's member-key row at v fails to unwrap) — both accepted only when
  the actor holds v, else 409 `TEAM_ROTATE_CARRY_INVALID`, so neither stands in for a refused
  `not_held`; a planted entry never blocks rotation. A carry changes no ciphertext; the
  rotation audit records each carried entry id with its reason and the actor, and the entry
  stays pending. Above the suspicion threshold (C1) the report adds "your distributed key for
  v may be wrong — compare with another holder". A `not_held` carry of an entry the actor holds a key for is
  refused (`TEAM_ROTATE_KEY_UNAVAILABLE`). The
  rotation limiter counts successful rotations only; the v1 snapshot predicate stays
  `itemKeyIv`, v0 adds `overviewIv`. History restore refuses a row whose normalised version
  has no holder (409 `HISTORY_KEY_UNAVAILABLE`). The `HISTORY_KEY_UNAVAILABLE` refusal and the
  "holder cannot re-key" / "unrecoverable" states name their C1 exits.
- Pass, per entry: v0 entry → upgrade v0→v1 by entry PUT first (it adds a history row,
  trims history to 20 and records the admin as editor — stated in C8); legacy attachments
  migrated (C4); history rows and CEKs decrypted by their own wrap, else by AES-GCM trial with
  every ItemKey the runner holds for the entry; history it still cannot open is retained; skip-and-report an entry whose live
  row or attachment no available key opens.
- Runner status table (unit-tested per row): `TEAM_KEY_VERSION_CHANGED` (re-key) and
  `TEAM_KEY_VERSION_MISMATCH` (entry PUT, also returned while a rotation runs) → invalidate
  the team key cache,
  re-fetch, continue; `REKEY_SNAPSHOT_MISMATCH` / `REKEY_SET_MISMATCH` / `ITEM_KEY_CHANGED` /
  `ITEM_KEY_VERSION_INVALID` / `MIGRATE_CAS_FAILED` → re-GET and retry once;
  `ENTRY_REKEY_REQUIRED` → re-key instead of editing; `ENTRY_UPGRADE_REQUIRED` /
  `CEK_KEY_VERSION_MISMATCH` → re-GET, upgrade again if v0, retry once; resolver `key_invalid`
  → skip and report the live entry, retain its history rows at v, continue;
  `REKEY_ATTACHMENTS_UNMIGRATED` →
  migrate, then retry; `MIGRATE_NOT_LEGACY` → done; `ITEM_KEY_IV_REUSED`, `MIGRATE_HASH_MISMATCH`,
  `MIGRATE_LENGTH_CHANGED`, `MIGRATE_METADATA_CHANGED`, `BLOB_REF_INVALID` → skip and report;
  `ACTOR_NOT_PERMITTED`, `REKEY_POSTCHECK_FAILED` and any unlisted code → stop and report;
  409 `REKEY_NOT_PENDING` / 404 →
  done; 429 → wait for Retry-After; step-up required → re-authenticate and resume; transient →
  stop and report, no POST; keyset paging with a skip set so skipped entries do not starve the
  page. The runner pauses while a rotation is in flight.
- Raw ItemKey/CEK byte buffers zeroed in `finally`.

### C4 Team attachments

- Mode 2 for every new upload: random CEK encrypts the body; CEK wrapped with
  `HKDF-SHA256(ItemKey, salt = 32 zero bytes, info "passwd-sso-item-cekwrap-v1")`
  (non-extractable, encrypt/decrypt) under a new scope `TW`:
  `buildTeamAttachmentCekWrapAAD(teamId, entryId, attachmentId, itemKeyVersion,
  cekWrapAadVersion)`; server checks `itemKeyId` (C1) and `cekKeyVersion` = the entry's
  itemKeyVersion, and stores `attachments.cek_item_key_id` (team mode 2 only; NULL for personal
  rows and team mode 0/1 rows; rewritten by re-key and migrate, untouched by rotation).
- Object keys carry a generation from the server CSPRNG (32 lowercase hex;
  `AttachmentBlobContext.generation`, `buildObjectKey` on all backends). Accepted ref keys,
  anchored segment-wise with every id equal to the row's own and no `..`, percent-encoding
  or empty segment: `<prefix>team/<teamId>/<entryId>/<attachmentId>.bin` (legacy),
  `<prefix>team/<teamId>/<entryId>/<attachmentId>/<generation>.bin`, and the `personal/`
  equivalents; segment rules apply to the scope/id/generation tail, ids compared
  case-insensitively; the prefix is accepted whole when free of `..`. These checks apply to
  external backends; the DB backend stores bytes, not refs. An undecodable external ref
  fails closed (no fallback to `buildObjectKey`). Upload, migrate and the personal upload
  write a fresh key before the transaction and delete it on failure.
- Upload and migrate refuse a locked `itemKeyVersion = 0` before any id comparison (409
  `ENTRY_UPGRADE_REQUIRED`); the client's upload flow upgrades a v0 entry first (as the pass
  does before migrate).
- Upload locks: team FOR SHARE → entry FOR SHARE → per-entry advisory lock (attachment cap);
  the entry is re-read in the transaction for the `itemKeyId`/`cekKeyVersion` check (409
  `ITEM_KEY_CHANGED` / `CEK_KEY_VERSION_MISMATCH`).
- `GET …/[attachmentId]` for a mode-2 attachment returns `cek*` and the wrap (entry or
  history row) whose `item_key_id` equals the attachment's `cek_item_key_id`; for a legacy
  mode 0/1 attachment it returns the entry wrap and the history wraps, and the client
  decrypts by trial (mode 0 with the team key at `keyVersion`); for mode 2 with no match, 409
  `ATTACHMENT_KEY_UNAVAILABLE` (exit: run the re-key pass, whose trial decryption recovers
  the CEK with any ItemKey it holds; if it also fails, another holder of the entry's version
  runs it). `team-attachment-section.tsx` encrypts mode 2 and
  decrypts modes 1 and 2.
- Migrate `PUT …/[attachmentId]/migrate` (modes 0/1 → 2): `TEAM_UPDATE`, step-up, rate limit,
  in-transaction audit, role re-check (403 `ACTOR_NOT_PERMITTED`); sends `itemKeyId` and
  `cekKeyVersion`, compared under the entry lock (`ITEM_KEY_CHANGED`,
  `CEK_KEY_VERSION_MISMATCH`); refusals:
  `MIGRATE_HASH_MISMATCH` (client hash ≠ stored body read through `BlobStore`),
  `MIGRATE_LENGTH_CHANGED`, `MIGRATE_METADATA_CHANGED` (filename, content type, size),
  `MIGRATE_NOT_LEGACY` (already mode 2, checked first under the attachment row lock),
  `MIGRATE_CAS_FAILED` (the client-sent snapshot of `iv` and `authTag` differs from the locked
  row; the GCM tag binds the ciphertext and every rewrite uses a fresh IV; the storage ref is
  never returned to clients — the body hash is computed server-side from the locked row's
  ref),
  `BLOB_REF_INVALID`; old object deleted after commit. Mode 0 opens
  with the team key at `keyVersion` (null/0 → 1); mode 1 with the entry's ItemKey or a
  history-row ItemKey.
- `DELETE`: row deleted in the locked transaction, blob after commit.
- Personal migrate: hash the stored body, write through the blob store (defect fixed here).

### C5 Client ItemKey cache

Cache keyed by `(entryId, itemKeyId)`, holding both derived keys (content and CEK-wrap);
`getItemEncryptionKey` returns `{ keys, itemKeyVersion, itemKeyId }`; callers send those. A
key cached for one identity is never returned for another.

### C6 Writers

| Writer | Locks | Guard |
|---|---|---|
| entry create / PUT / v0→v1 upgrade | team FOR SHARE, entry FOR UPDATE | itemKeyId + versions vs locked row; `encryptedItemKey` only for the upgrade; stale team key version → `ENTRY_REKEY_REQUIRED` |
| history restore | team FOR SHARE, entry FOR UPDATE, then re-read history | marker rule C1 |
| re-key POST | team FOR SHARE, entry FOR UPDATE, history/attachments FOR UPDATE | C2 |
| attachment upload / migrate / delete | team FOR SHARE, entry FOR SHARE, entry advisory lock (migrate: attachment FOR UPDATE) | C4 |
| rotation | team FOR NO KEY UPDATE | exact sets + CAS |
| bulk trash/archive/restore/purge, empty-trash, trash restore, folder delete, retention GC, vault reset | as today | covered by re-key CAS/exact sets (count ≠ 1 → 409) |

Member set re-derived by grep in Phase 2 and recorded in the deviation log.

### C7 Platform limits

`next.config.ts` sets `experimental.proxyClientMaxBodySize` to the largest route body cap.
Beyond its limit the proxy does not reject: it buffers up to the limit in memory, keeps
draining and hands the route a truncated body — so routes enforce their caps on bytes read
and answer their own 400/413 for a truncated body. A
unit test pins it ≥ each of `REKEY_BODY_MAX` (16 MB), `ATTACHMENT_MIGRATE_PAYLOAD_MAX` (20 MB)
and the multipart upload envelope for `MAX_FILE_SIZE` — the personal migrate and maximum-size
uploads already exceed today's 10 MiB default. Accepted risk: up to that size × concurrent
requests is buffered before authentication on every matched route; the deployment docs make
an ingress body limit a requirement (a low default, 20 MB only on the re-key, migrate and
upload paths).

### C8 Docs and clients

- Whitepaper §2.2/§6.2, key-retention policy (pruning keyed on "no row references version k",
  not on the marker — SC2), threat model: a TEAM_UPDATE holder can rewrite content through
  the pass and migrate (audited; history and attachment attribution not preserved); the
  marker attests the client's claim to have re-keyed, not that the key changed; retained
  history stays readable to old-key holders.
  An `undecryptable` or `key_invalid` carry is a holder's unverifiable claim: it keeps that
  entry on its old team key and ItemKey until another holder re-keys it; it is audited per
  entry with the reason and the actor.
- `scripts/generate-team-key-fixture.ts` gains `itemKeyVersion = 2` and team CEK-wrap (`TW`)
  vectors (committed JSON regenerated) used by web/extension decrypt tests and iOS
  `TeamKeyCryptoTests`; `team-entry-submit.ts` uses the server's `nextItemKeyVersion`.
- `ci-integration.yml` path filter gains `src/lib/blob-store/**` and `src/lib/crypto/**`.

## Forbidden patterns

- pattern: `encryptionMode: 1` / `encryptionMode: 0` in a team attachment create — reason: mode 2 only.
- pattern: `putObject(` with a context lacking `generation` — reason: fixed keys allow overwrite.

## Acceptance criteria

Every refusal cell asserts its named code and is paired with the same sequence minus the
interfering step, ending in 200. The inventory is keyed by (code, emitting route); the
implementation checklist lists one cell per pair, and the deviation log records any pair
without a cell:
- re-key POST: ACTOR_NOT_PERMITTED, REKEY_NOT_PENDING, TEAM_KEY_VERSION_CHANGED,
  REKEY_SNAPSHOT_MISMATCH, REKEY_SET_MISMATCH, ITEM_KEY_VERSION_INVALID, ITEM_KEY_IV_REUSED,
  REKEY_ATTACHMENTS_UNMIGRATED — A4; REKEY_POSTCHECK_FAILED — direct red-proof (Testing
  strategy); the IV-reuse
  pair — A13;
- entry PUT (incl. upgrade): ITEM_KEY_CHANGED, ITEM_KEY_VERSION_INVALID, ENTRY_REKEY_REQUIRED —
  A7; ITEM_KEY_IV_REUSED — A5;
- attachment upload: ITEM_KEY_CHANGED — A5; CEK_KEY_VERSION_MISMATCH, ENTRY_UPGRADE_REQUIRED —
  A13;
- migrate: ACTOR_NOT_PERMITTED, ITEM_KEY_CHANGED, CEK_KEY_VERSION_MISMATCH,
  ENTRY_UPGRADE_REQUIRED, MIGRATE_HASH_MISMATCH, MIGRATE_LENGTH_CHANGED,
  MIGRATE_METADATA_CHANGED, MIGRATE_NOT_LEGACY, MIGRATE_CAS_FAILED, BLOB_REF_INVALID (route
  cell, MinIO) — A13;
- attachment GET: ATTACHMENT_KEY_UNAVAILABLE — A5; rotation: TEAM_ROTATE_KEY_UNAVAILABLE,
  TEAM_ROTATE_CARRY_INVALID — A12;
  restore: HISTORY_KEY_UNAVAILABLE — A12;
- ref validation: BLOB_REF_INVALID — unit table, one row per rejected form;
- gate refusals of every new route: step-up, 429 per (team, user), cross-team/tenant id → 404.

- A1 Rotation + pass (real Web Crypto via the React-free builders, through the real routes):
  from DB read-back and the download route, the new team key opens the new ItemKey, which
  opens blob, overview, every history row (incl. one seeded at `aadVersion` 0) and every CEK;
  the old ItemKey fails under the same AAD; `rowsOffCurrentVersion(teamId)` (independent of the
  post-check) empty; pending 0.
- A2 Stale-version entries and old-version history rotate and re-key (distinct key per
  version; red against latest-key decryption); rotate → v0 upgrade edit → still pending.
- A3 v0 entry with a mode-0 attachment: upgrade → migrate → re-key. On MinIO: a successful
  migrate lists exactly one object under the attachment prefix; a concurrent second migrate
  → `MIGRATE_NOT_LEGACY`, and after either refusal the listing holds exactly the surviving
  object and the attachment decrypts; personal migrate on
  MinIO red before its fix.
- A4 Re-key refusals: wrong `newItemKeyVersion` → `ITEM_KEY_VERSION_INVALID`; a rotation
  committed after the GET → `TEAM_KEY_VERSION_CHANGED`; an edit between GET and POST →
  `REKEY_SNAPSHOT_MISMATCH`; a history row
  deleted while re-key is parked at its exact-set `FOR UPDATE` read (blocker holds a history
  row of the same entry; parking asserted via `pg_locks`) → `REKEY_SET_MISMATCH` (control: the
  blocker commits without change → 200); stale snapshot blobIv → `REKEY_SNAPSHOT_MISMATCH`;
  not pending → `REKEY_NOT_PENDING`; a mode-1 attachment present →
  `REKEY_ATTACHMENTS_UNMIGRATED` (control: migrate, then re-key → 200); role revoked while the
  request is parked on the team FOR SHARE behind a blocker that revokes and commits → 403
  `ACTOR_NOT_PERMITTED` (controls: the blocker commits without revoking → 200; revoked before
  the request → `FORBIDDEN` from the gate).
- A5 Races and identity: restore parked behind re-key ends on-version; the client cache
  returns the cached keys for the same `(entryId, itemKeyId)` without re-resolving and never
  for a different `itemKeyId`; stale `itemKeyId` PUT/upload → `ITEM_KEY_CHANGED`; rotate, then
  a post-rotation member downloads a mode-2 attachment before any re-key → 200; an attachment
  uploaded under a previous ItemKey (after a restore switched the live one) downloads via the
  history-row match, and with that row gone → `ATTACHMENT_KEY_UNAVAILABLE`; a legacy mode-1
  attachment whose ItemKey only a history row holds (uploaded, then a restore switched the
  live ItemKey) downloads → 200 (red: a GET returning only the entry wrap fails to decrypt);
  a mode-0 attachment at `keyVersion` 1 on a team at version ≥ 2 → 200 (red against latest-key
  decryption); IV reuse on the
  re-key POST against the locked row and on the upgrade PUT against a history wrap →
  `ITEM_KEY_IV_REUSED`; a rotation committing mid-pass → the runner recovers.
- A6 Through `runRekeyPass` with real crypto, one entry holding three rows the re-keyer cannot
  open (a version only another member holds; a corrupt blob; a legacy row under a different
  v1 ItemKey) next to two it can (its own wrap; trial decryption with the live ItemKey): the
  exact ids retained vs re-keyed are asserted; retained rows are listed in the audit and in
  `rowsOffCurrentVersion` (which includes retained rows) and counted in
  `retainedHistoryCount`; the runner sends no POST for the non-pending entry,
  and a direct POST → `REKEY_NOT_PENDING` with the rows unchanged; after the next rotation, two
  independent seeds (v ≥ 2; the legacy row's ItemKey held by no one; the version-v holder is
  an ADMIN): that holder re-keying first moves exactly the version-v row (`retainedHistoryCount`
  3 → 2, exact retained ids asserted), while the rotating admin running first leaves it at 3. A legacy row under a non-live held ItemKey is re-keyed by
  trial decryption.
- A7 Restore-to-v0 → upgrade → stale v1 client PUT → `ITEM_KEY_CHANGED`; restore a v0 row at
  an old team key version → upgrade PUT → 200, still pending → re-key → pending 0; the same
  restore of a v1 row → full update → `ENTRY_REKEY_REQUIRED`; metadata-only PUT on a stale
  entry → 200.
  A full PUT with a stale `itemKeyId` on an entry at an old team key version →
  `ITEM_KEY_CHANGED` (check order; red under the reverse order: `ENTRY_REKEY_REQUIRED`).
  Upgrade PUT with `newItemKeyVersion` = high-water + 2 → `ITEM_KEY_VERSION_INVALID` (control:
  + 1 → 200). On a team at version 1 with rows A and B at team key version 1 (itemKeyVersion
  ≥ 1, `item_key_id` NULL) and the entry's marker asserted current first: after A's restore
  the live id is non-null and the marker 0; after B's the id is non-null and differs from A's; a stale PUT carrying A's minted id after B's
  restore → `ITEM_KEY_CHANGED`; control: fresh GET then PUT → 200. Restore of a v0 row leaves
  the id NULL. Re-key, then restore a re-keyed row → marker stays current, ids equal. Unit:
  the comparison helper returns mismatch for (null, null) and match for (x, x); resolving
  with a null id calls the resolver every time, a non-null id hits the cache.
- A8 (E2E, production build, no reused server) on a dedicated team at version 2 with owner key
  rows and one pending entry: a >10 MiB valid re-key body (history blobs within field caps,
  stale snapshot) → 409 `REKEY_SNAPSHOT_MISMATCH`; a >10 MiB well-formed personal migrate body
  for a nonexistent attachment → 404. The spec fails loudly unless `CI` or
  `E2E_CSP_SERVER=prod` is set and `E2E_BASE_URL` is unset. New E2E helpers seed a team at a
  given key version, member key rows and a pending entry; the body is ≥ 21 blobs at
  `CIPHERTEXT_MAX` within the `history[]` max. Red: a one-off Phase 2 proof on a production
  build without the setting → `INVALID_JSON`, recorded in the deviation log.
- A9 (integration, runner over the real routes via a fetch adapter, page size set by the
  test) pending > page size completes; a page full of skipped entries does not starve (the
  page-2 entry is re-keyed; final pending = skipped); admin A then admin B finish a pass.
- A10 Marker and high-water writers on a team at version ≥ 2; the backfill block
  (`-- BEGIN BACKFILL team-key-rotation-rekey` / `-- END BACKFILL team-key-rotation-rekey`)
  run after resetting the columns in a rolled-back transaction: version-1 team → marker 1,
  version-3 team → 0; an entry at itemKeyVersion 1 with a history row at 3 and an attachment
  at cekKeyVersion 2 → high-water 3; history 2 and an attachment at cekKeyVersion 4 → 4 (a seed
  existing data cannot contain, pinning the attachment term); a mode-0 attachment (NULL
  `cek_key_version`) only → the entry's own version; an entry with neither → its own version.
  `item_key_id` backfill (≥ 2 v1+ entries), in one BEGIN … ROLLBACK: drop the CHECK, reset
  entry and history ids to NULL, run the block; assert distinct non-null entry ids, history
  rows with the entry's full wrap (bytes, tag, team and item key versions) carrying its id,
  history rows equal to it except, in turn, one predicate column differing by a non-null
  value (`team_key_version` and `item_key_version` at the entry's + 1; `encrypted_item_key`,
  `item_key_iv`, `item_key_auth_tag` a different valid value of the same length), plus NULL
  variants of the three nullable text columns, each keeping a NULL id, v0 NULL, and the
  constraint present (`pg_constraint`); then, each in a SAVEPOINT: a v1 entry with a NULL id
  → 23514 (control: with an id → succeeds) and a v0 entry with a non-null id → 23514
  (control: NULL → succeeds). After re-key the entry's id differs from its pre-re-key id and every
  non-retained history row and attachment carries it; retained rows keep the old one; after
  rotation all ids are unchanged.
- A11 `itemKeyVersion = 2` and `TW` vectors decrypt in web, extension and iOS; the same
  ciphertext under the version-1 AAD fails.
- A12 Carry: v1 keys held only by a tenant-deactivated member → carried, reported
  unrecoverable (reactivating that member → no longer unrecoverable; the delete warns while
  they are deactivated, control: no deactivated holder → no warning); the holder an active
  admin → "needs re-keyer holder"; the only holder a MEMBER → "holder cannot re-key"; a
  `not_held` carry by an actor holding v1 → `TEAM_ROTATE_KEY_UNAVAILABLE`; a planted entry
  failing authentication next to an authentic entry at the same v → planted carried
  `undecryptable`, authentic re-wrapped, rotation 200; an active member with
  `key_distributed = true` who joined after v1 is not a holder. Restore of a row with no holder →
  `HISTORY_KEY_UNAVAILABLE`; the same with an active holder → 200; refusal → restore a
  current-version row → rotation 200.
  `buildRotationEntryPayload` with real Web Crypto: an authentic entry under the same key is
  re-wrapped (wrap changed in the DB), not carried; a `transient` key failure aborts with no
  POST; only an AES-GCM `OperationError` under a held key yields `undecryptable`, and the
  carried ciphertext is byte-identical; an `undecryptable` carry by an actor not holding v →
  `TEAM_ROTATE_CARRY_INVALID` (control: holder → accepted), a `not_held` carry by a holder →
  `TEAM_ROTATE_KEY_UNAVAILABLE`; a `key_invalid` carry by a non-holder →
  `TEAM_ROTATE_CARRY_INVALID` (control: a holder → accepted); the rotation audit lists each
  carried entry id with its reason and actor; the `undecryptable` / `key_invalid` reports
  never offer delete — in the X/K' report the entry's exit names holder Y, the `key_invalid`
  entry's exit says another holder of v re-keys, and (control, same report) an unrecoverable
  entry's exit does list delete — and the sole-holder case names its exits; the
  actor's member-key row failing to unwrap → resolver
  `key_invalid` → the entries at v carried with that reason, entries at other versions
  re-wrapped, rotation 200 (control: the row intact → everything re-wrapped); X's row
  correctly wrapping a wrong team key K' (≥ 2 entries at v, none under K') → the carried
  ciphertext byte-identical, the entries still pending, the suspicion shown (control: holder Y with the correct key re-keys the same entries → 200); one planted
  entry among ≥ 3 authentic entries at v → no suspicion line. Unit table for the threshold:
  1 of 1 → not shown, 2 of 4 → not shown, 2 of 3 → shown, 3 of 5 → shown.

- A13 Migrate and upload refusals through the routes, each with its minus-step control. Migrate:
  role revoked (gate-to-transaction interleaving as in A4) → `ACTOR_NOT_PERMITTED` (controls:
  the blocker commits without revoking → 200; revoked before the request → `FORBIDDEN`);
  stale `itemKeyId` → `ITEM_KEY_CHANGED`; current `itemKeyId` with a wrong `cekKeyVersion` →
  `CEK_KEY_VERSION_MISMATCH`; a stale `iv`, and separately a stale `authTag`, snapshot →
  `MIGRATE_CAS_FAILED` (on the DB backend and on MinIO, each with a 200 control); a stale
  `itemKeyId` together with a wrong `cekKeyVersion` → `ITEM_KEY_CHANGED` (check order); a v0
  entry → `ENTRY_UPGRADE_REQUIRED`; hash over altered bytes → `MIGRATE_HASH_MISMATCH`; different
  ciphertext length → `MIGRATE_LENGTH_CHANGED`; changed filename → `MIGRATE_METADATA_CHANGED`;
  already mode 2 → `MIGRATE_NOT_LEGACY`; on MinIO, a stored ref of another row →
  `BLOB_REF_INVALID`. Upload: current `itemKeyId` with a wrong `cekKeyVersion` →
  `CEK_KEY_VERSION_MISMATCH`; a v0 entry →
  `ENTRY_UPGRADE_REQUIRED`. Re-key POST whose wrap IV equals the IV of a history row whose wrap
  differs from the entry's → `ITEM_KEY_IV_REUSED` (control: a fresh IV → 200).

## Testing strategy

Real-DB integration for A1-A7, A9, A10, A12; E2E for A8; unit and fixture tests for A11.
Writers observed parked with `waitForBackendBlockedBy` plus a `pg_locks` / `pg_stat_activity`
check of where they wait. MinIO via `BLOB_BACKEND=s3`, `AWS_ENDPOINT_URL_S3` from
`ANCHOR_TEST_S3_ENDPOINT`, MinIO credentials, bucket created in `beforeAll`, failing loudly
when unreachable. Existing cells that change meaning (rotation payload snapshots,
history-untouched cells kept as pre-pass invariants with a post-pass counterpart, raw-SQL
seeders gaining the marker and, for v1+ rows, `item_key_id`, both attachment test trees, restore and PUT tests in both trees)
are listed in the deviation log. Red-proofs for every guard; `assertEntryRekeyConsistent`
red-proved directly on seeded inconsistent rows.

## Considerations & constraints

- SC1 Downloaded material, and CEKs already unwrapped, stay readable to their holder.
- SC2 Pruning old TeamMemberKey versions once no row references them — follow-up issue.
- SC3 iOS reads the latest team key only; re-keyed entries are at the latest version.
- SC4 Rotation keeps its 1000-entry cap; the pass has none.
- SC5 Backups, WAL, versioned buckets and objects orphaned by a crash between commit and the
  post-commit delete keep old ciphertext (an unreferenced-object sweep is a follow-up).

## User operation scenarios

1. Rotate after a departure; the pass migrates legacy attachments and re-keys every entry.
2. A team with a restored stale-version entry and old history.
3. The rotating admin closes the tab mid-pass; another admin finishes.
4. A member who joined after earlier rotations runs the pass (old history retained).
5. A second departure while a pass is running.

## Carried-Forward Plan Findings

- R10-UNVERIFIED (round-10 edits: S10-1, S10-2, F10-1..F10-3, T10-1..T10-4) — applied at the
  10-round cap without a re-review round. Anti-Deferral: not deferred; the obligations are in the
  plan and bind Phase 2. Settled by: Phase 3 round 1 cross-checking A10, A12 and the check-order
  and CAS cells against the implemented tests, and the report/exit texts against the code.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Entry key identity (marker, monotonic versions, wrap-IV checks) | locked |
| C2 | Re-key pass endpoints | locked |
| C3 | Rotation and pass runner | locked |
| C4 | Team attachments (mode 2, generations, migrate) | locked |
| C5 | Client ItemKey cache | locked |
| C6 | Writers | locked |
| C7 | Platform limits | locked |
| C8 | Docs and clients | locked |

## Implementation Checklist

Derived in Phase 2 Step 2-1 (writer member set by grep of the terminal mutating primitives).

### Batch 1 — schema, codes, server writers (C1, C3 server, C6)
- `prisma/schema.prisma` (`TeamPasswordEntry`, `TeamPasswordEntryHistory`, `Attachment`, `AuditAction`)
  + migrations: columns + backfill block + CHECK; audit enum values in their own migration
- `src/lib/http/api-error-codes.ts` (+ `api-error-codes.test.ts` count, `messages/{en,ja}/ApiErrors.json`)
- `src/lib/constants/audit/audit.ts` (+ test, `messages/{en,ja}/AuditLog.json`,
  `docs/operations/audit-log-reference.md`)
- `src/lib/services/team-password-service.ts` (`createTeamPassword` mints id/marker/high-water;
  `updateTeamPassword` checks moved under the locked row; history snapshot copies `item_key_id`)
- `src/app/api/teams/[teamId]/passwords/[id]/route.ts` (GET `itemKeyId`, `nextItemKeyVersion`)
- `src/app/api/teams/[teamId]/passwords/[id]/history/route.ts`, `.../history/[historyId]/route.ts`
  (return `itemKeyId`)
- `src/app/api/teams/[teamId]/passwords/[id]/history/[historyId]/restore/route.ts` (team lock,
  in-tx re-read, marker/id rule, `HISTORY_KEY_UNAVAILABLE`, overview — D1)
- `src/app/api/teams/[teamId]/rotate-key/route.ts` + `data/route.ts` (carry, holder rules,
  limiter on success, v0 `overviewIv` snapshot, per-entry carry audit — D3)
- `src/lib/validations/team.ts`, `src/lib/validations/common.ts`
- `src/lib/team/team-key-rotation-lock.ts` header writer list
- raw-SQL seeders: `team-rotate-key`, `team-key-version-guard`, `share-departure`,
  `bulk-import-entry-isolation`, `passwords-history-lost-update`, `tenant-swap.adversarial`,
  `vault-rotate-key-attachments` integration tests; `scripts/rls-cross-tenant-seed.sql`
- both test trees for every touched route (`src/app/api/**/route.test.ts`, `src/__tests__/api/teams/*`)

### Batch 2 — blob store, team attachments, migrate (C4)
- `src/lib/blob-store/{types,object-ref,s3-blob-store,azure-blob-store,gcs-blob-store,db-blob-store,cleanup}.ts` + tests
- `src/lib/crypto/crypto-aad.ts` (`TW`), `src/lib/crypto/crypto-team.ts` (CEK-wrap HKDF);
  `docs/security/crypto-domain-ledger.md`, `scripts/checks/aad-scope-manifest.json`,
  `scripts/checks/aad-golden-vectors.json`, `src/__tests__/aad-parity.test.ts`
- `src/app/api/teams/[teamId]/passwords/[id]/attachments/route.ts`, `.../[attachmentId]/route.ts`,
  new `.../[attachmentId]/migrate/route.ts`
- `src/app/api/passwords/[id]/attachments/route.ts`, `.../[attachmentId]/route.ts`,
  `.../[attachmentId]/migrate/route.ts`, `src/lib/vault/rotate-key-server.ts` (`applyAttachmentMigration`)
- manifests: `route-policy-manifest.json`, `stepup-route-paths.json`, `raw-sql-usage.txt`,
  generated security matrices, `docs/security/step-up-reauth-routes.md`, `api-path.ts`

### Batch 3 — re-key endpoints (C2)
- new `src/app/api/teams/[teamId]/rekey/route.ts`, `.../passwords/[id]/rekey/route.ts`,
  `src/lib/team/rekey-consistency.ts` (`assertEntryRekeyConsistent`), same manifests

### Batch 4 — web client (C3 client, C5)
- `src/lib/team/team-vault-core.tsx` (+ context re-export, tests), new
  `src/lib/team/{rotation-payload,rekey-payload,rekey-runner}.ts`
- `src/components/team/security/team-rotate-key-button.tsx` (+ finish control),
  `src/components/team/forms/{team-entry-submit.ts,team-attachment-section.tsx}`,
  `src/lib/team/team-entry-save.ts`, `src/components/passwords/entry/entry-history-section.tsx`,
  history restore caller, `src/hooks/use-watchtower.ts`,
  `src/app/[locale]/admin/teams/[teamId]/audit-logs/page.tsx` (version-aware key — D5), i18n

### Batch 5 — other clients, config, docs (C7, C8)
- `extension/src/lib/crypto-team.ts` + tests; `scripts/generate-team-key-fixture.ts` + fixture JSON;
  `ios/Shared/Crypto/AAD.swift`, `TeamKeyCrypto.swift`, `ios/PasswdSSOTests/{TeamKeyCryptoTests,AADParityTests}.swift`
- `next.config.ts` + unit test; `.github/workflows/ci-integration.yml` path filter
- `docs/security/{cryptography-whitepaper,key-retention-policy,threat-model}.md`,
  `docs/operations/deployment.md`, CLAUDE.md API table (with user approval)

### Batch 6 — integration and E2E (A1–A13)
- `src/__tests__/db-integration/team-key-rekey*.integration.test.ts`, E2E spec + helpers in `e2e/helpers/`

### CI parity
- CI-only, not in pre-pr: `check-state-mutation-centralization.sh` (run by hand in 2-4);
  license, npm-audit and terraform-count gates are diff-independent.
