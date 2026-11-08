# Plan Review: team-key-rotation-rekey
Date: 2026-11-04
Review round: 1 (plan v1)

## Findings (merged)
- Single-request infeasible [Critical/Major]: S7, F8, T11 — worst case tens of MB of hex
  ciphertext and ~30k CAS updates in one 60 s transaction with every team writer 409ing;
  steady edits starve it; caps below code maxima. → user decision: per-entry re-key pass.
- ItemKey cache keyed by entryId only [Critical]: S1, F2, T2 — another member keeps
  encrypting (and wrapping CEKs) under the old ItemKey after a rotation, undetectably.
- Migrate overwrites a deterministic blob object before the DB CAS [Critical]: F1, S5, T3;
  the personal migrate template hashes the stored ref on external backends (F9).
- A1/A2 tautological (test-built payloads, mocked client crypto) [Critical]: T1.
- Restore reads history outside the transaction [Critical/Major]: S2, F3, T5.
- Entry PUT checks itemKeyVersion against a stale row and allows same-version ItemKey
  replacement [Major]: S3.
- v1 snapshot predicate only itemKeyIv [Major]: F4, T4, S12.
- Legacy mode-0 team attachments [Major]: S4; attachments under an ItemKey the entry no
  longer holds block forever [Major]: F7, T14.
- Migrate authorization unspecified [Major]: S6. No exit when old keys are unavailable
  [Major]: S8; failure reason not exposed [Major]: T13.
- Objective overclaims (CEK not re-keyed; backups) [Major]: S9, T16.
- History payload lacks aadVersion [Major]: F5. Attachment GET lacks cek fields
  [Major]: F6, T10. Post-write check unreachable [Major]: T7. Unlocked deleters (GC)
  [Major]: T8, F10. `attachments.keyVersion` [Minor/Major]: S11, F11, T9.
- Minors: S10 (parent-FK scoping), S13/F13 (per-row wrap), S14/T17 (zeroization), S15
  (separate HKDF info for CEK wrap), S16 (audit of rewrite), S17 (data GET limiter), F12
  (itemKeyVersion increment), F14 (DELETE order), F15 (entry lock in upload), T6, T12,
  T15, T18.

## Resolution Status (plan v2)
- Mode: per-entry re-key pass (C2/C3) with a generation marker (C1); rotation keeps its
  shape and caps (SC4).
- S1/F2/T2: C5. F1/S5/T3/F9: C4 (new object key, ref swap, post-commit delete; personal
  route fixed). T1: A1 with `buildEntryRekeyPayload` + real Web Crypto. S2/F3/T5: C6.
  S3: C6. F4/T4/S12: C2/C3 snapshot. S4/F7/T14: C4 migrate modes 0/1, history-wrap
  fallback, skip+report. S6: C4. S8/T13: C2 discard + C3 reason. S9/T16: Objective, SC1,
  SC5. F5: C3. F6/T10: C4 + A1/A3 via download route. T7: testing strategy. T8/F10: C6
  + A4. S11/F11/T9: C2 keyVersion + `rowsOffCurrentVersion`. Minors: C2/C3/C4/C7.

---

Review round: 2 (plan v2)

## Findings (merged)
- Marker escapes: v0→v1 upgrade raised it although old-key history remains [Major]:
  F2-1, S2-7. Re-key repeatable on non-pending entries, no attribution [Major]: S2-2.
- ItemKey version not a unique identity (restore to v0 then upgrade) [Major]: S2-3, F2-5,
  T2-9. Discard deletes history the live ItemKey opens / another admin holds / version 0
  [Major]: S2-1, F2-3, F2-4.
- Fixed object key on upload overwrite/delete [Major]: S2-4; generation not expressible in
  the BlobStore API [Minor]: F2-9.
- No in-tx role re-check [Major]: S2-5. Audit best-effort/count-only [Major]: S2-6.
- v0 entry with mode-0 attachments circular [Major]: F2-2. Runner error handling, paging
  starvation, rotation starved by the pass / undecryptable entries [Major]: F2-6, F2-7, F2-8,
  T2-12. Team attachment client rejects mode 2; cache holds only one derived key [Major]: F2-10.
- Next proxy truncates bodies above 10 MiB [Major]: T2-1, F2-13.
- Tests: post-check red-proof [Major] T2-2; park points [Major] T2-3; restore read order
  [Major] T2-4; rotation builder inline in a component [Major] T2-5; v1 snapshot cell T2-6;
  marker/backfill cells and seeders T2-7, F2-12; in-tx deleter T2-8; MinIO wiring T2-10;
  personal migrate red T2-11; itemKeyVersion ≥ 2 vectors T2-13; T14 paths T2-14.
- Minors: S2-8 (step-up window, limiter keys), S2-9 (HKDF salt, AAD binding teamId), S2-10
  (migrate content controls, ref prefix), S2-11 (pre-rekey window), F2-11 (history
  aadVersion), F2-14 (zeroization wording), T2-15..T2-18.

## Resolution Status (plan v3)
- C1: marker DEFAULT 0, raised only by create/re-key, restore rule by exact wrap; strictly
  increasing server-supplied ItemKey versions; itemKeyIv identity on PUT/upload; version <1
  normalised. C2: pending + role re-check + in-tx audit + discard rules (same itemKeyVersion,
  other holder, normalised version). C3: React-free builders/runner, status table, keyset
  paging + skip set, v0 upgrade→migrate→re-key order, trial decryption, rotation limiter on
  success, rotation's unavailable error. C4: generation object keys (upload, migrate,
  personal upload), mode-2 client, CEK-wrap KDF/AAD with teamId, migrate content controls, ref
  prefix check. C5: cache identity incl. itemKeyIv, both derived keys. C6: writer→locks table.
  C7: proxy body cap. C8: docs, itemKeyVersion ≥ 2 vectors. Acceptance A1-A11 and the testing
  strategy cover the T2 findings.

---

Review round: 3 (plan v3)

## Findings (merged)
- S3-1 [Major] discard rules can block re-key forever (legacy same-version rows, idle other
  holder, unopenable row). F3-1 [Major] `TEAM_ROTATE_KEY_UNAVAILABLE` has no exit.
- T3-1 [Major] stated park point unreachable (rows locked in the exact-set read). T3-2
  [Major] A8 in the wrong tier (integration bypasses the proxy). T3-3 [Major] bare-409
  cells without codes or controls; A4 role 409 vs 403.
- Minors: S3-2 (marker attests a claim), S3-3 (high-water), S3-4 (wrap IV reuse), S3-5 (TW
  scope + version), S3-6 (exact ref form), S3-7/F3-7 (global proxy buffer), S3-8 (attachment
  attribution), F3-2 (itemKeyIv scope), F3-3 (upload advisory lock), F3-4 (upgrade side
  effects, runner rows), F3-5 (attachment wrap at cekKeyVersion), F3-6 (stale entry edit),
  T3-4..T3-8.

## Resolution Status (plan v4)
- S3-1: discard replaced by "retain" (rows the re-keyer cannot open keep their wrap; audited).
- F3-1: rotation carries server-verified unrecoverable entries; unrecoverable count; restore
  refuses rows nobody can open.
- T3-1..T3-3: A4 park point via the exact-set FOR UPDATE with pg_locks check; A8 in E2E;
  named codes per refusal, each cell paired with a 200 control, role → 403.
- Minors: C1 high-water + IV-reuse check + itemKeyIv scope + ENTRY_REKEY_REQUIRED; C4 TW scope,
  exact ref form, upload lock order, attachment GET wrap at cekKeyVersion; C7 accepted risk
  with enumerated caps and ingress recommendation; C8 threat model, fixture generator, CI
  path filter; A9/A10/A11/A12 specified.

Round 3 test findings, recorded in full (T4-6): T3-4 A9 tier and page size (now integration
runner over real routes, test-set page size); T3-5 backfill extraction and vacuous run (now
labelled BACKFILL block after a reset); T3-6 A11 vector source (fixture generator + Swift
test + version-1 negative); T3-7 A3 orphan listing positive control; T3-8 CI path filter.

---

Review round: 4 (plan v4)

## Findings (merged)
- S4-1 [Major] holder predicate undefined; a departed member's kept keys could block the
  rotation meant to lock them out; "unrecoverable" delete could destroy recoverable data.
- F4-1 / S4-3 [Major] `ENTRY_REKEY_REQUIRED` blocked the v0→v1 upgrade the pass depends on.
- F4-2 [Major] attachment wrap chosen by itemKeyVersion alone (legacy collisions).
- T4-1..T4-5 [Major] A8 vacuous paths; A6 controls; A12 seeds; refusal inventory; high-water
  backfill cells.
- Minors: S4-2 (retained rows never revisited), S4-4 (IV rationale), S4-5 (ref forms), S4-6
  (proxy truncation), F4-3 (exits), F4-4 (runner codes), F4-5 (metadata exemption, backfill
  column), T4-6 (round-3 text).

## Resolution Status (plan v5)
- S4-1: holder pinned (key row at v joined to an active membership, under the team lock); a
  carry is accepted whenever the actor holds no key at v; "needs holder" vs unrecoverable;
  unrecoverable time-varying, delete warns. F4-1/S4-3: upgrade exempt from
  ENTRY_REKEY_REQUIRED. F4-2: `cek_item_key_iv`, wrap matched on (version, IV), runner trial
  on CEKs. T4-1..T4-5: A8 seeded team and post-parse outcomes, A6 mixed rows via the runner,
  A12 seeds and control pairs, refusal inventory, A10 high-water. Minors folded into C1-C7.

---

Review round: 5 (plan v5)

## Findings (merged)
- F5-1 / S5-2 [Major] the v5 retained-row revisit never converges and reopens S2-2
  (repeatable rewrite of a non-pending entry). T5-1 [Major] one refusal had two codes.
- S5-1 / F5-2 [Major/Minor] a holder without TEAM_UPDATE leaves an entry un-re-keyable and
  uneditable. S5-3 [Major] rotation changes the wrap IV, breaking (version, IV) attachment
  lookup. T5-2 [Major] inventory entries pointing at cells without the code; upload refusal
  unnamed. T5-3 [Major] A8 meaningful only in CI. T5-5 [Major] A10 did not pin the attachment
  term.
- Minors: S5-4 (planted undecryptable entry blocks rotation), S5-5 (restore holder check not
  serialized), F5-3 (runner rows), F5-4 (ref rules vs DB backend, prefix, id case), F5-5
  (`cek_item_key_iv` nullability), T5-4, T5-6..T5-9.

## Resolution Status (plan v6)
- Revisit removed: retained rows are revisited by the next rotation's pass; the S2-2 bound
  (one re-key per pending generation) holds. One code `ITEM_KEY_VERSION_INVALID`.
- Holder vs re-keyer holder; entry states "needs re-keyer holder" / "holder cannot re-key" /
  unrecoverable / undecryptable, with exits; the restore check is best-effort and stated so.
- ItemKey identity is a server CSPRNG `item_key_id` unchanged by rotation (entries, history,
  `attachments.cek_item_key_id`); the cache, `ITEM_KEY_CHANGED` and the attachment GET use it;
  the IV keeps only the echo check.
- Carry reasons `not_held` / `undecryptable`. Runner table completed with a default.
- Ref rules: external backends only, segment rules on the tail, ids case-insensitive.
- Tests: refusal inventory as a rule (each code its own cell, listed in the implementation
  checklist), A5/A6/A8/A10/A12 cells as listed by the reviewers.

---

Review round: 6 (plan v6)

## Findings (merged)
- F6-1 / S6-1 / T6-2 [Major] no `item_key_id` backfill for existing entries and no NULL
  semantics (null === null would pass ITEM_KEY_CHANGED, the cache and the restore rule).
- F6-2 / S6-4 [Major/Minor] the re-key POST did not write the new id into re-encrypted history
  rows (restore of a re-keyed row would reset the marker or let a stale key through).
- S6-2 / F6-3 [Major/Minor] the `undecryptable` carry is an unverified claim that voided the
  `not_held` refusal; its only exit was delete; not storable as a server count.
- T6-1 [Major] refusal inventory per code, not per (code, route); wrong pointers.
  T6-3 [Major] undecryptable-carry cell without a control.
- Minors: F6-4 (retained revisit ordering), S6-3 (migrate identity checks, server-sourced
  `cek_item_key_id`), S6-5 (promotion exit least-privilege), T6-4 (attachment GET branches
  and code), T6-5 (cache positive control), T6-6 (runner never POSTs a non-pending entry),
  T6-7 (duplicate IV line; unit table scope).

## Resolution Status (plan v7)
- `item_key_id`: backfill for v1+ entries with a CHECK; NULL never equal; restore of a NULL
  row mints a fresh id; restore copies the id otherwise (restore snapshot columns); the server
  writes `cek_item_key_id` from the locked row; re-key writes the id into non-retained history
  rows and attachments; post-check covers ids.
- `undecryptable` accepted only when the actor holds v; runner-local, attributed, cleared by a
  re-key; delete offered only without another holder; key-level failure reported.
- Inventory keyed by (code, route) with the missing cells; A5/A6/A7/A10/A12 cells per the
  reviewers; exits ordered least-privilege first; retained-row ordering stated.

---

Review round: 7 (plan v7)

## Findings (merged)
- Design (all Minor): S7-1 / F7-2 the "key failed on every entry" heuristic can let planted
  entries block rotation; F7-1 holders share one team key, so "another holder clears it" is
  impossible; S7-2 / F7-3 NULL-row restore minted ids for v0 rows; uploads to v0 entries;
  F7-4 history rows sharing the entry's wrap stayed NULL (spurious pending, misleading
  delete exit); F7-5 / T7-5 the non-holder undecryptable refusal had no code.
- Testing [Major]: T7-1 inventory pointers to cells lacking the code; T7-2 NULL-id cell red
  only with both guards removed; T7-3 backfill reset violates the non-deferrable CHECK;
  T7-4 A12 fixtures not buildable. T7-6 [Minor] A6 seeds.

## Resolution Status (plan v8)
- Undecryptable redefined: an entry failing AES-GCM under a key the actor's own member-key
  wrap authenticated; exit delete; a member-key unwrap failure is `key_invalid` (stop, no
  carry); heuristic dropped; non-holder carry → `TEAM_ROTATE_CARRY_INVALID`.
- Minting only at itemKeyVersion ≥ 1; two-way CHECK added inside the backfill block; history
  ids backfilled where the wrap matches; upload/migrate refuse v0 (`ENTRY_UPGRADE_REQUIRED`),
  client upgrades first; `ATTACHMENT_KEY_UNAVAILABLE` exit = re-key pass first.
- Tests: A13 (migrate/upload refusals), pointer corrections, A7 NULL-id cells with minted-id
  assertions and helper/cache unit cells, A10 constraint-drop procedure, A12 fixtures (wrong
  key K', authentic sibling), A6 seeds.

---

Review round: 8 (plan v8)

## Findings (merged)
- F8-1 / T8-2 [Minor/Major] the undecryptable exit "delete" assumed every holder's key is
  right; a holder with a wrongly distributed key would be told to delete entries others can
  read. T8-4 [Major] legacy mode 0/1 attachments could not download under the NULL-never-equal
  id match.
- S8-1 [Minor] `key_invalid` had no exit and blocked the actor's whole rotation. S8-2 [Minor]
  carry trust not stated in the threat model. S8-3 [Minor] history id backfill matched wrap
  bytes too loosely. F8-2 / F8-3 runner rows (`key_invalid`, `ENTRY_UPGRADE_REQUIRED`,
  `CEK_KEY_VERSION_MISMATCH`). F8-4 seeders. T8-1 pointers; T8-3 suspicion threshold; T8-5
  A10 single-transaction procedure; T8-6 CHECK both directions; T8-7 distinct-wrap IV seed;
  T8-8 MinIO for the ref cell; T8-9 revoke interleaving; T8-10 marker after NULL-row restore;
  T8-11 CHECK table.

## Resolution Status (plan v9)
- Undecryptable exits: another holder first; delete only after a second holder fails and
  never with the suspicion shown (threshold > half and ≥ 2). `key_invalid` is a carry reason
  under the holder rule; the rest of the rotation proceeds. Threat model and per-entry audit.
- Attachment GET: id match for mode 2 only; legacy modes return the entry and history wraps
  for client trial. Backfill matches the full wrap. Runner rows added; resolver union gains
  `key_invalid`. Tests per T8-1..T8-11; seeders gain `item_key_id`.

---

Review round: 9 (plan v9)

## Findings (merged)
- Delete exit cannot be gated (F9-1, F9-2, S9-1, S9-2, T9-2 [Major]): the "second holder
  also failed" evidence is never recorded; `key_invalid` offered delete although only the
  actor's row is broken.
- T9-1 [Major] `MIGRATE_CAS_FAILED` unreachable as specified (concurrent migrate yields
  `MIGRATE_NOT_LEGACY`); POSTCHECK pointer. T9-4 [Major] legacy download cell did not pin the
  history-wrap path or mode-0 `keyVersion`. T9-5 [Major] A7 marker assertion vacuous; check
  order unspecified.
- Minors: F9-3 (runner `key_invalid` row in the pass), S9-3 (stated limits), T9-3 (threshold
  unit table), T9-6 (`key_invalid` non-holder cell), T9-7 (backfill negatives), T9-8
  (cekKeyVersion construction; 200 controls for the revoke cells).

## Resolution Status (plan v10)
- The pass never suggests deleting; exits name another holder of v (and key redistribution
  for `key_invalid`); deletion stays the ordinary entry delete.
- `MIGRATE_CAS_FAILED` compares the client-sent snapshot; `MIGRATE_NOT_LEGACY` checked first;
  check order `ITEM_KEY_CHANGED` before `ENTRY_REKEY_REQUIRED` / `CEK_KEY_VERSION_MISMATCH`.
- Cells per T9-1..T9-8; stated limits gain holder-claimed carries; runner `key_invalid` row.

---

Review round: 10 (plan v10) — final round

## Findings (merged; no Critical or Major)
- S10-1 / F10-1 [Minor, prose] leftover delete exits in C3 and the `ATTACHMENT_KEY_UNAVAILABLE`
  exit; A12's no-delete assertion unscoped.
- S10-2 [Minor, design] `MIGRATE_CAS_FAILED` snapshot included the storage ref clients never
  receive.
- F10-2 [Minor, design] the `key_invalid` "redistribute" exit cannot be performed (confirm-key
  accepts only the current version). F10-3 [Minor, prose] no exit when the actor is the sole
  holder of v.

## Resolution Status (plan v10, final edits)
- Exits named per state; the no-delete rule scoped to the `undecryptable` / `key_invalid`
  reports; attachment exit → another holder runs the pass; redistribution exit removed;
  sole-holder exit text and cell; migrate CAS snapshot = iv + authTag, ref never returned.
- Testing (round 10): T10-1 [Major] two backfill negatives were unseedable (NOT NULL
  columns) and `encrypted_item_key` had no negative; T10-2 [Major] the no-delete assertion was
  an absence check without positives; T10-3 [Minor] check order untested; T10-4 [Minor] CAS
  snapshot fields and DB backend.
- Resolution: negatives differ by non-null values for all five predicate columns plus NULL
  variants of the nullable ones; positive exit assertions (holder Y, another-holder text) with
  an unrecoverable-entry delete control; check-order cells on the PUT and on upload/migrate;
  separate iv / authTag CAS cells on both backends.

## Loop limit
Ten rounds reached. Every round-10 finding is applied to the plan (v10, final edits); none of
the final edits has been re-reviewed. Design findings fell to Minor from round 7 on; the last
three rounds' Majors were test-specification precision.
