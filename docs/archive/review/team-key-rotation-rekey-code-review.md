# Code Review: team-key-rotation-rekey
Date: 2026-11-04
Review round: 1

## Changes from Previous Round
Initial review (incremental on top of the Phase 2 self-check, D40–D52). Seeds: Ollama seed
generation skipped — the diff (189 files, ~22k lines) exceeds what the local analyzer can take
without truncation; every expert ran a full-diff review.

## Functionality Findings
- F1 [Major] History restore racing a re-key: the client seals the overview under the row's
  pre-re-key ItemKey, the route copies the re-keyed row, the entry is not pending and never
  repaired. `restore/route.ts`, `team-history-restore.ts`. Fix: snapshot `blobIv` in the restore
  body, 409 under the lock on mismatch, client re-fetches and retries once.
- F2 [Major] Restore seals the overview with the AAD regardless of the row's `aadVersion`; an
  aadVersion-0 restore becomes undecryptable to rotation, upgrade and re-key (two adjudicators
  for the overview AAD: restore writer and list adapter vs `teamEntryAadFor`).
- F3 [Minor] Runner files not_held/key_invalid entries with legacy attachments as skipped
  "undecryptable" (retry-pass exit) instead of their C1 buckets.
- F4 [Minor] A rotation during a running pass remounts the finish control; the orphaned runner
  keeps racing the new one.
- F5 [Minor] D41's rollout analysis misses the previous release's history restore (swaps the
  ItemKey, keeps the id and marker).
- F6 [Minor] Mode-2 attachment migrated with NULL ids → `ATTACHMENT_KEY_UNAVAILABLE` until
  re-key; should fall back to trial wraps like mode 1.
- F7 [Minor] Checklist items absent from the diff without a deviation entry (v0 seeders,
  `db-blob-store.ts`, CLAUDE.md API table).
- F8 [Minor] `schema.prisma` comment asserts the NULL-iff-v0 invariant D41 dropped.

## Security Findings
- S1 [Major] Team attachment upload lacks `ENTRY_REKEY_REQUIRED`: an entry whose ItemKey wrap
  is under an old team key (restored retained row, carried entry) accepts a new CEK under the old
  ItemKey, readable by a departed holder. R42 writer member set: upload is the miss.
  escalate: false.
- S2 [Major] MEMBER own-entry rule enforced only on PUT; restore (client-chosen overview, ItemKey
  switch) and upload act on any entry. User decision 2026-11-04: own entries only.
  escalate: false.
- S3 [Minor] Team migrate uploads the body before the early-decidable `MIGRATE_NOT_LEGACY` /
  `BLOB_REF_INVALID` refusals.

## Testing Findings
- T1 [Major, RT11] Five hand-rolled lock-holding blocker clients are released with an open
  transaction on the failure path; one failure cascades into timeouts.
- T2 [Minor] `ENTRY_REKEY_REQUIRED` (entry PUT) lacks its minus-step 200 control.
- T3 [Minor] Acceptance map A10 row cites cells D41 deleted; D23's re-key
  `ENTRY_UPGRADE_REQUIRED` missing from the inventory.
- T4 [Minor] Personal-migrate MinIO red proof cited but unrecorded.
- T5 [Minor] No deviation-log inventory of existing cells that changed meaning.
- T6 [Minor] Backfill `team_key_version <= 1` normalisation unpinned (no version-0 team).
- T7 [Minor] A7 restore(v0) → upgrade → re-key → pending 0 never run end to end.
- T8 [Minor] `ci-integration.yml` path filter omits `src/lib/validations/**`,
  `src/lib/http/api-error-codes.ts`, `src/lib/security/rate-limiters.ts`.

## Adjacent Findings
- A1 [Minor] (testing → functionality) `s3-blob-store.ts` sets no `forcePathStyle`; MinIO
  cells pass only with an IP-literal endpoint.
- (security) Legacy aadVersion-0 rows can be swapped between entries of a team (documented T2
  accepted risk); the pass re-seals whatever opens.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
Findings: R3 (F2), R29 (F5, F8), R48 (F2), R51 (F1). Checked clean: R1, R2, R5–R10, R14–R18,
R22, R24–R27, R31, R33, R35–R43, R49, R50, R57; N/A: R4, R11–R13, R19–R21, R23, R28, R30, R32,
R44–R47, R52–R56.

### Security expert
Findings: R3 (S1, S2), R42 (S1). Checked clean: R1, R2, R5, R6, R9, R10, R12, R14–R18, R22, R24,
R25, R29, R33, R35–R41, R43, R47–R49, R51, R52, R54, R55, R57; RS2, RS3, RS4 OK; RS1, RS5, RS6
N/A; others N/A.

### Testing expert
Findings: R29 (T3, T4), RT7 partial (T4), RT10 (T2), RT11 (T1). Checked clean: R1–R28, R30–R57
(except as noted), RT1–RT6, RT8, RT9.

## Environment Verification Report
- VE1 MinIO: verified-local (Batches 2, 6; `npm run test:integration` with
  `ANCHOR_TEST_S3_ENDPOINT`) and wired for CI (`ci-integration.yml` starts MinIO).
- VE1 Azure / GCS: blocked-deferred — plan "Verification environment constraints" VE1 (no local
  emulator); unit tests of `buildObjectKey` / ref handling pass.
- VE2 iOS: verified-local on the macOS build host (Batch 5b: TeamKeyCryptoTests +
  AADParityTests, then the full PasswdSSOTests suite, 884 tests, 0 failures); `ios-ci` runs in CI.

## Resolution Status
Round 1 fixes: commit "fix(teams): address round-1 review of the re-key branch".
### S1 Major upload accepts a stale-team-key entry
- Action: upload refuses 409 `ENTRY_REKEY_REQUIRED` after the id/CEK-version checks (D53).
- Modified file: team attachments upload route, `src/lib/team/team-attachment-lock.ts`
### S2 Major MEMBER own-entry rule only on PUT
- Action: `canWriteTeamEntry` applied to PUT, restore and upload, pre-check and under the lock
  (D54). User decision: own entries only.
- Modified file: `src/lib/auth/access/team-auth.ts`, restore and upload routes, entry service
### F1 Major restore racing a re-key
- Action: restore snapshot `snapshotBlobIv`, 409 `HISTORY_ROW_CHANGED`, client retries once (D55).
- Modified file: restore route, `src/lib/team/team-history-restore.ts`, entry-history-section
### F2 Major overview AAD ignores aadVersion
- Action: one adjudicator `teamEntryAadFor` for the restore writer and every web/extension reader
  (D56); iOS in a separate commit.
- Modified file: `src/lib/team/team-history-restore.ts`, list adapter, detail, watchtower,
  export, edit loader, history view, audit-log page, extension background
### T1 Major blocker clients left in open transactions
- Action: failure-safe `parkBehind` in `race-helpers.ts`; all five blockers moved (D57).
- Modified file: `src/__tests__/db-integration/race-helpers.ts` and the three rekey files
### Minors
- S3 early migrate refusals (D58); F3 runner buckets before download (D59); F4 runner
  cancellation + rotate disabled during a pass (D60); F6 NULL-id mode-2 trial wraps (D61); F5 D41
  corrected + rollout requirement in deployment.md; F8 schema comment; F7/T3/T4/T5 deviation and
  acceptance-map entries (D62, D63); CLAUDE.md endpoint rows (user-approved); T2, T6, T7 cells;
  T8 path filter (D64).
- A1 [Minor] `s3-blob-store.ts` has no `forcePathStyle` — Skipped (D65). Anti-Deferral: out of
  this PR's goal (pre-existing addressing behaviour, unchanged by this branch's object-key work).
  Worst case: an operator pointing `AWS_ENDPOINT_URL_S3` at a hostname-based S3-compatible store
  gets virtual-hosted requests that fail loudly at upload. Likelihood: low (AWS S3 and IP-literal
  MinIO work). Cost to fix: small code change plus an operator-facing config decision — follow-up
  issue.
