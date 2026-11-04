# Acceptance map: team-key-rotation-rekey

Each clause of the plan's acceptance criteria (A1–A13 and the refusal inventory) mapped to
the cell that pins it. Where the plan and the deviation log disagree, the cell asserts the
deviation entry (named in the row).

Files (all under `src/__tests__/db-integration/` unless a path is given):

| Key | File |
|---|---|
| TP | `team-rekey-pass.integration.test.ts` (Batch 6: runner + builders over the real routes) |
| ER | `team-entry-rekey.integration.test.ts` |
| AR | `team-attachment-rekey.integration.test.ts` |
| KW | `team-key-rekey-writers.integration.test.ts` |
| VG | `team-key-version-guard.integration.test.ts` |
| E2E | `e2e/tests/rekey-body-limit.spec.ts` |
| U:… | a unit test file under `src/` (path given) |

## Refusal inventory (header of the acceptance criteria)

| Code / emitting route | Refusal cell → control |
|---|---|
| re-key POST: ACTOR_NOT_PERMITTED, REKEY_NOT_PENDING, TEAM_KEY_VERSION_CHANGED, REKEY_SNAPSHOT_MISMATCH, REKEY_SET_MISMATCH, ITEM_KEY_VERSION_INVALID, ITEM_KEY_IV_REUSED, REKEY_ATTACHMENTS_UNMIGRATED | ER (A4 rows below), each with its 200 control |
| re-key POST: ENTRY_UPGRADE_REQUIRED (a v0 entry; not in C2's list, D23) | U:`src/app/api/teams/[teamId]/passwords/[id]/rekey/route.test.ts` "409 ENTRY_UPGRADE_REQUIRED for a v0 entry, without reading the body" and "409 ENTRY_UPGRADE_REQUIRED when a restore turned the entry back to v0 since the pre-check"; through the runner: TP A2 / A3 / T7 (the pass upgrades first, then re-keys → 200) |
| re-key POST: REKEY_POSTCHECK_FAILED | ER `assertEntryRekeyConsistent` block (direct red-proof on seeded rows); 500 mapping U:`src/app/api/teams/[teamId]/passwords/[id]/rekey/route.test.ts` "500 REKEY_POSTCHECK_FAILED…" (D27) |
| entry PUT: ITEM_KEY_CHANGED, ITEM_KEY_VERSION_INVALID, ENTRY_REKEY_REQUIRED, ITEM_KEY_IV_REUSED | KW A7 / A5 rows below; ENTRY_REKEY_REQUIRED's minus-step 200 control in the same cell of U:`src/lib/services/team-password-service.test.ts` and U:`…/passwords/[id]/route.test.ts` (round 1 T2) |
| upload: ITEM_KEY_CHANGED, CEK_KEY_VERSION_MISMATCH, ENTRY_UPGRADE_REQUIRED | AR `upload` block |
| upload: ENTRY_REKEY_REQUIRED (D53) | AR "upload after a restore (ENTRY_REKEY_REQUIRED)" → control "a restored row at the current team key version → 201"; U: both upload test trees |
| restore / upload: ONLY_OWN_ENTRIES (pre-check), ACTOR_NOT_PERMITTED (under the lock) for a MEMBER on another member's entry (D54) | AR "own-entry rule on restore and upload" (refusal + MEMBER-own and ADMIN controls); U: both restore and both upload test trees (under-lock arm) |
| restore: HISTORY_ROW_CHANGED (D55) | ER "A5: a restore built before a re-key and parked behind it…" → ER "A5 control: a restore of an unchanged row…"; U: both restore test trees |
| migrate: all ten codes | AR `migrate` + `MinIO` blocks (A13) |
| attachment GET: ATTACHMENT_KEY_UNAVAILABLE | AR "an attachment uploaded under a previous ItemKey…" |
| rotation: TEAM_ROTATE_KEY_UNAVAILABLE, TEAM_ROTATE_CARRY_INVALID | KW "A12: rotation carry" block |
| restore: HISTORY_KEY_UNAVAILABLE | KW "A12: a restore of a row whose version…"; TP "A12: a restore of a row no member holds…" |
| ref validation: BLOB_REF_INVALID | U:`src/lib/blob-store/object-ref.test.ts` (one row per rejected form); route cell AR MinIO "BLOB_REF_INVALID…" |
| gate refusals of the new routes (step-up, 429 per (team, user), cross-team → 404) | U:`…/passwords/[id]/rekey/route.test.ts` ("returns the step-up refusal…", "rate-limits per (team, user)", "404 when the team/entry is gone…"); U:`…/[teamId]/rekey/route.test.ts` ("needs no step-up", "rate-limits…", "a non-member gets the gate's 404"); U:`…/attachments/[attachmentId]/migrate/route.test.ts` ("returns the step-up refusal…", "rate-limits…", "returns 404 for an entry of another team") |

## A1–A13

| Clause | Cell |
|---|---|
| **A1** rotation (`buildRotationPayload` → rotate route) then the pass, real Web Crypto through the real routes | TP "A1 / scenario 1: after a departure, rotation then the pass…" |
| A1 from DB read-back and the download route the new team key opens the new ItemKey → blob, overview, every history row (incl. aadVersion 0, a v0 row, a row under a previous ItemKey) and every CEK | TP A1 (`expectOnCurrentKey`); server half with a test-local builder: ER "A1: after a re-key the new ItemKey…" |
| A1 the old ItemKey fails under the same AAD | TP A1, ER A1 (red-proved: a builder reusing the live ItemKey turns TP A1 red) |
| A1 `rowsOffCurrentVersion(teamId)` empty, independent of the post-check; pending 0 | TP A1, ER A1 |
| **A2** stale-version entries and old-version history rotate (each opened at its own version, distinct key per version) and re-key | TP "A2 / scenario 2: entries and history at older team key versions…" |
| A2 red against latest-key decryption | Red-proof on a scratch copy of `rotation-payload.ts` resolving only the latest held key: TP A2 red (entries carried `undecryptable`) |
| A2 rotate → v0 upgrade edit → still pending | TP "A2: rotate → the v0→v1 upgrade edit leaves the entry pending…" (KW covers the restore → upgrade variant) |
| **A3** v0 entry with a mode-0 attachment: upgrade → migrate → re-key | TP "A3: the pass upgrades a v0 entry, migrates its mode-0 attachment…" (DB backend), TP MinIO "A3: …exactly one object…" |
| A3 MinIO: a successful migrate leaves exactly one object under the attachment prefix | AR MinIO "A3: a migrate leaves exactly one object…"; TP MinIO A3 (through the runner) |
| A3 concurrent second migrate → MIGRATE_NOT_LEGACY; after either refusal the listing holds exactly the surviving object and it decrypts | AR MinIO "A3: of two concurrent migrates…", AR MinIO "MIGRATE_CAS_FAILED on a stale %s…" |
| A3 personal migrate on MinIO red before its fix | AR MinIO "personal migrate: hashes the stored body…" (re-run in round 1 on MinIO, D63: red with the pre-fix hash source, green without) |
| **A4** wrong newItemKeyVersion → ITEM_KEY_VERSION_INVALID | ER "ITEM_KEY_VERSION_INVALID…" |
| A4 rotation committed after the GET → TEAM_KEY_VERSION_CHANGED | ER "TEAM_KEY_VERSION_CHANGED…" |
| A4 edit between GET and POST → REKEY_SNAPSHOT_MISMATCH | ER "REKEY_SNAPSHOT_MISMATCH: an edit between…" |
| A4 history row deleted while parked at the exact-set read (pg_locks) → REKEY_SET_MISMATCH; control → 200 | ER "REKEY_SET_MISMATCH…" block |
| A4 stale snapshot blobIv → REKEY_SNAPSHOT_MISMATCH | ER "REKEY_SNAPSHOT_MISMATCH: a stale history blobIv…" (and the edit cell for the entry snapshot) |
| A4 not pending → REKEY_NOT_PENDING | ER "REKEY_NOT_PENDING…" |
| A4 mode-1 attachment → REKEY_ATTACHMENTS_UNMIGRATED (control: migrate, re-key → 200) | ER "REKEY_ATTACHMENTS_UNMIGRATED…" (order per D24) |
| A4 role revoked while parked → ACTOR_NOT_PERMITTED; controls 200 / FORBIDDEN | ER "ACTOR_NOT_PERMITTED…" block |
| **A5** restore parked behind re-key ends on-version | ER "A5: a restore built before a re-key and parked behind it…" — the restore body is built the way the client builds it (row GET, the row's pre-re-key key), so the parked restore is refused HISTORY_ROW_CHANGED and the entry stays as the re-key left it (on-version, pending 0); the client's retry from the re-read row → 200 (D55, supersedes the earlier cell that sealed the overview under the post-re-key key) |
| A5 client cache: same `(entryId, itemKeyId)` cached, never for another id | U:`src/lib/team/team-vault-core.crypto.test.tsx` (h), (i) (D33) |
| A5 stale itemKeyId PUT / upload → ITEM_KEY_CHANGED | KW A7 cells; AR upload "ITEM_KEY_CHANGED…" |
| A5 rotate, post-rotation member downloads a mode-2 attachment before re-key → 200 | AR download "after a rotation, a member holding only the new team key…" |
| A5 attachment under a previous ItemKey downloads via the history row; row gone → ATTACHMENT_KEY_UNAVAILABLE | AR download "an attachment uploaded under a previous ItemKey…" |
| A5 legacy mode-1 attachment whose ItemKey only a history row holds → 200 (red: entry wrap alone) | AR download "a legacy mode-1 attachment…" |
| A5 mode-0 at keyVersion 1 on a team at ≥ 2 → 200 (red: latest key) | AR download "a mode-0 attachment at keyVersion 1…" |
| A5 IV reuse on the re-key POST (locked row) and on the upgrade PUT (history wrap) → ITEM_KEY_IV_REUSED | ER "ITEM_KEY_IV_REUSED: a wrap IV echoing the locked entry's…"; KW "A5: an upgrade PUT whose wrap IV a history row already used…" |
| A5 a rotation committing mid-pass → the runner recovers | TP "A5 / scenario 5: a second departure and rotation committing mid-pass…" (red-proved: a runner that does not restart paging leaves the first entry pending) |
| **A6** through `runRekeyPass`, three unopenable rows (version only another member holds; corrupt blob; legacy row under another v1 ItemKey) + two openable (own wrap; trial with the live ItemKey): exact ids retained vs re-keyed | TP "A6: three rows the re-keyer cannot open are retained (exact ids)…" |
| A6 retained listed in the audit, in `rowsOffCurrentVersion`, counted in `retainedHistoryCount` | TP A6 (same cell); server-only form ER "retained rows: left byte-identical…" |
| A6 no POST for the non-pending entry; direct POST → REKEY_NOT_PENDING, rows unchanged | TP A6 first-pass helper (no request names the entry) + TP "A6: a direct re-key POST for the entry that is not pending…" |
| A6 after the next rotation, version-v ADMIN holder first: exactly the version-v row moves (3 → 2, exact retained ids) | TP "A6: after the next rotation, the version-2 holder (an ADMIN) re-keying first…" |
| A6 rotating admin first leaves it at 3 | TP "A6: after the next rotation, the rotating admin running first…" |
| A6 legacy row under a non-live held ItemKey re-keyed by trial | TP "A6: a legacy row (NULL id) under a non-live ItemKey…" |
| **A7** restore-to-v0 → upgrade → stale v1 PUT → ITEM_KEY_CHANGED; v0 row at an old version → upgrade 200, still pending → re-key → pending 0 | KW "A7: restore of a v0 row at an old team key version…" (re-key leg: TP A2 upgrade cell) |
| A7 v1 row restore → ENTRY_REKEY_REQUIRED; metadata-only PUT 200; stale id first (check order) | KW "A7: restore of a v1 row at an old team key version…" |
| A7 upgrade with high-water + 2 → ITEM_KEY_VERSION_INVALID (control + 1) | KW A7 cells (D9) |
| A7 NULL-id rows A then B mint distinct ids; stale PUT with A's id → ITEM_KEY_CHANGED; control | KW "A7: on a team at version 1, restoring NULL-id rows A then B…" |
| A7 restore(v0) at an old version → upgrade → re-key, end to end through the runner → pending 0, nothing off-version | TP "T7: restore a v0 row at an old team key version → the v0→v1 upgrade edit → the pass…" (round 1 T7) |
| A7 restore of an aadVersion-0 row is refused (client before decrypting, server 409 `HISTORY_ROW_LEGACY`), entry and history unchanged; aadVersion-1 control: the live entry is written at aadVersion 1 (blob and overview re-sealed by the client), the strict list opens it, rotation re-encrypts it (no carry), the pass upgrades and re-keys it | TP "F2 (S-R3-2): an aadVersion-0 history row is not restorable…" / "F2 control: restoring an aadVersion-1 v0 row…" (D56, D67, D72); U: both restore test trees (HISTORY_ROW_LEGACY refusal + control), `team-history-restore.test.ts` (refuses aadVersion 0 before a key lookup; strict AAD; control), `entry-history-section.test.tsx` (no POST, message shown; control), `restoreTeamHistorySchema` (blob required, capped) |
| Strict team entry AAD (D67): every live-entry reader refuses a no-AAD ciphertext labelled aadVersion 0; aadVersion-1 control | U: list adapter, `build-team-get-detail`, watchtower, team export, edit-dialog loader, `use-team-login-form-state` (history passwords); extension `team-entries.test.ts` "strict team entry AAD" (list, by-id blob+overview, overview only) with the real `buildTeamEntryAAD`; iOS `TeamKeyCryptoTests` (v1 and v0 at aadVersion 0, aadVersion 1) and `CredentialResolverTests` (v1 and v0; AAD-sealed label-0 control); guard `src/__tests__/team-entry-aad-strictness.test.ts` (AST: `teamEntryAadFor` only on the upgrade paths and the history view, no aadVersion-chosen `buildTeamEntryAAD` elsewhere — also covers the team audit-log page, which has no unit harness) |
| D67: a pre-existing live aadVersion-0 v0 entry is refused by the strict list, re-sealed at AAD 1 by rotation (no carry), then opens and is re-keyed | TP "D67: a pre-existing live aadVersion-0 v0 entry…" |
| A7 v0 restore leaves the id NULL; re-key then restore of a re-keyed row keeps marker and id | KW "A7: restoring a row that holds the live ItemKey…"; ER "A7: re-key, then restore a re-keyed row…" (D13) |
| A7 unit: comparison helper (null,null) mismatch, (x,x) match; null id re-resolves, non-null hits cache | U:`src/lib/team/team-item-key.test.ts` `itemKeyIdsMatch`; U:`team-vault-core.crypto.test.tsx` (h), (j) |
| **A8** >10 MiB valid re-key body (≥ 21 blobs at CIPHERTEXT_MAX, stale snapshot) → 409 REKEY_SNAPSHOT_MISMATCH | E2E "a valid re-key POST above 10 MiB…" |
| A8 >10 MiB well-formed personal migrate body, nonexistent attachment → 404 | E2E "a well-formed personal migrate PUT above 10 MiB…" (needed the D38 side-fix) |
| A8 fails loudly unless CI / E2E_CSP_SERVER=prod and E2E_BASE_URL unset | E2E `assertOwnProductionServer` in `beforeAll` (observed: REKEY_BODY_LIMIT_SPEC_REFUSED without the flag) |
| A8 red: production build without the setting → INVALID_JSON | Observed in Batch 6 (D37): both requests 400 INVALID_JSON |
| **A9** pending > page size completes | TP "A9: with page size 2, five pending entries…" |
| A9 a page full of skipped entries does not starve; final pending = skipped | TP "A9: a first page full of entries the runner skips…" (red-proved: a runner stopping on an all-skipped page) |
| A9 admin A then admin B finish | TP same cell; scenario 3 cell |
| **A10** marker / high-water writers on a team at ≥ 2; backfill block | KW "A10: the backfill block sets the marker, the high-water and the item_key_id, and adds no CHECK…" — asserts the marker on teams at versions 0, 1 and 3 (0 → 1: the `<= 1` normalisation, round 1 T6), the high-water terms, the minted / matched ids, that no `team_password_entries_item_key_id_iff_item_key` constraint exists and that a NULL-id v1 row is accepted. The plan's constraint and SAVEPOINT pairs were removed with the CHECK (D41); they move to the follow-up that adds it. KW "A10: entry create on a team at version 2…" |
| A10 after re-key the id differs and is carried by non-retained rows and attachments; retained keep theirs; after rotation ids unchanged | ER "A10: the re-key gives the entry a new ItemKey id…" |
| **A11** `itemKeyVersion = 2` and TW vectors decrypt in web, extension, iOS; version-1 AAD fails | U:`src/__tests__/team-key-fixture.test.ts`; `extension/src/__tests__/lib/crypto-team.test.ts` "team-key fixture: itemKeyVersion 2 entry and TW attachment"; iOS `TeamKeyCryptoTests` (macOS host, VE2 — not run in Batch 6) |
| **A12** v1 keys held only by a tenant-deactivated member → carried, unrecoverable | TP "A12: v1 keys held only by a tenant-deactivated member…" |
| A12 reactivation → no longer unrecoverable | TP same cell (MEMBER → holder_cannot_rekey) |
| A12 delete warns while deactivated; control no deactivated holder → no warning | TP same cell (report `deactivatedHolder` true / false, D36) |
| A12 holder an active admin → needs re-keyer holder | TP same cell (role ADMIN → needs_rekeyer_holder, holder named); TP A9 skipped-page cell |
| A12 only holder a MEMBER → holder cannot re-key | TP same cell (stateCounts, and the MEMBER's own list GET → 403) |
| A12 `not_held` carry by an actor holding v1 → TEAM_ROTATE_KEY_UNAVAILABLE | KW "a not_held carry by an actor holding the entry's version…" |
| A12 planted entry next to authentic at the same v → planted carried `undecryptable`, authentic re-wrapped, rotation 200 | TP "A12: a planted entry among three authentic ones…"; U:`src/lib/team/rotation-payload.test.ts` "re-wraps the authentic entry and carries the planted one…" |
| A12 an active `key_distributed` member who joined after v1 is not a holder | KW "A12: a restore of a row whose version only a deactivated member, or no one, holds…" (the v2-only MEMBER does not make v1 held) |
| A12 restore of a row with no holder → HISTORY_KEY_UNAVAILABLE; with an active holder → 200 | KW same cell |
| A12 refusal → restore a current-version row → rotation 200 | TP "A12: a restore of a row no member holds → HISTORY_KEY_UNAVAILABLE; restoring a current-version row instead…" |
| A12 builder: authentic re-wrapped (wrap changed in the DB), not carried | TP planted cell (wrap changed, unwraps to the same ItemKey); U:`rotation-payload.test.ts` |
| A12 `transient` key failure aborts with no POST | U:`rotation-payload.test.ts` "aborts on a transient key failure", "throws on a transient failure before returning any payload"; U:`team-rotate-key-button.test.tsx` "aborts with no POST…" |
| A12 only an AES-GCM `OperationError` under a held key → `undecryptable`; carried ciphertext byte-identical | U:`rotation-payload.test.ts`; TP planted / K' cells (byte-identical rows in the DB) |
| A12 `undecryptable` / `key_invalid` carry by a non-holder → TEAM_ROTATE_CARRY_INVALID (control: holder accepted) | KW carry block (both reasons, both arms) |
| A12 rotation audit lists each carried entry with reason and actor | KW carry block; TP planted, K', key_invalid cells (audit_outbox) |
| A12 reports never offer delete for `undecryptable` / `key_invalid`; X/K' exit names Y; `key_invalid` exit = another holder; unrecoverable lists delete; sole-holder exits | U:`src/lib/team/rekey-report.test.ts`; TP K' cell (report from the live list route names Y, no delete); TP planted cell (sole holder → no delete) |
| A12 actor's member-key row fails to unwrap → `key_invalid` carry, others re-wrapped, rotation 200 (control: intact → all re-wrapped) | TP "A12: the actor's member-key row at version 1 fails to unwrap…" / "…is intact (control)…" |
| A12 X's row wrapping a wrong K' (≥ 2 entries at v) → carried byte-identical, still pending, suspicion shown; control Y re-keys → 200 | TP "A12: X's member key wraps a wrong team key K'…" |
| A12 one planted among ≥ 3 authentic → no suspicion | TP planted cell |
| A12 unit threshold table | U:`rekey-report.test.ts` `isKeySuspect` |
| **A13** migrate: role revoked (interleaving) → ACTOR_NOT_PERMITTED + both controls | AR migrate "ACTOR_NOT_PERMITTED…" block |
| A13 migrate: ITEM_KEY_CHANGED; CEK_KEY_VERSION_MISMATCH; check order | AR migrate cells |
| A13 migrate: stale iv / authTag → MIGRATE_CAS_FAILED on DB and MinIO, each with 200 | AR migrate + MinIO cells |
| A13 migrate: v0 → ENTRY_UPGRADE_REQUIRED; HASH_MISMATCH; LENGTH_CHANGED; METADATA_CHANGED; NOT_LEGACY; MinIO BLOB_REF_INVALID | AR migrate + MinIO cells |
| A13 upload: CEK_KEY_VERSION_MISMATCH; ENTRY_UPGRADE_REQUIRED | AR upload cells |
| A13 re-key POST wrap IV = a history row's (wrap differs) → ITEM_KEY_IV_REUSED (control fresh IV → 200) | ER "ITEM_KEY_IV_REUSED: a wrap IV equal to a history row's…" |

## User operation scenarios

| Scenario | Cell |
|---|---|
| 1 rotate after a departure; the pass migrates legacy attachments and re-keys every entry | TP A1 (departure, rotation, pass); TP A3 (legacy attachment through the pass) |
| 2 restored stale-version entry and old history | TP A2 |
| 3 rotating admin closes the tab mid-pass; another admin finishes | TP "scenario 3: the rotating admin's pass stops mid-way…" |
| 4 a member who joined after earlier rotations runs the pass (old history retained) | TP A6 (re-keyer holds only the current version; the older rows are retained) |
| 5 a second departure while a pass is running | TP "A5 / scenario 5…" |

## Not covered

- A11 iOS vectors run only on the macOS build host (VE2); Batch 6 did not run them.
- A8 "no reused server": the spec checks the environment it was told about (CI /
  E2E_CSP_SERVER, E2E_BASE_URL); it cannot detect that Playwright reused a server already on
  the configured port (`reuseExistingServer` is `!CI`). In CI it never reuses.
