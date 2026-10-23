# Plan Review: aws-anchor-publisher-verify-worker
Date: 2026-10-24
Review round: 1

## Changes from Previous Round

Initial review (fresh reviewers) of revision 1. The earlier combined plan's round-1 review is
`aws-anchor-publisher-and-scram-verifier-review.md`.

## Merged findings and disposition (applied in revision 2)

| ID | Source | Sev | Disposition |
|----|--------|-----|-------------|
| F1 | Functionality | Critical | Fixed — `createMany` (no RETURNING), INSERT suffices |
| T-1 | Testing | Critical | Fixed — MinIO service in CI, fail-loud, Object Lock bucket, paired refusal case |
| F2 | Functionality | Major | Fixed — explicit boundary, wall-clock re-arm, awaited boot run, blocking lock |
| F3 | Functionality | Major | Fixed — pause capped at the next boundary |
| F4 / S7 | Functionality, Security | Major / Minor | Fixed — non-throwing helper on `auditLogger`/`deadLetterLogger`, `AUDIT_WRITE_DIRECT_OUTBOX`, own transaction, file named |
| F5 | Functionality | Major | Fixed — `OptionalModuleName` keeps client-s3 for the blob store |
| F6 | Functionality | Major | Fixed — explicit tx timeout, S3 timeouts below it, SIGTERM drain, `stopTimeout` |
| F7 | Functionality | Major | Fixed — deploy-gap-sized down alarm, published-absence alarm, `_logType` on `cadence_error` |
| S1 | Security | Major | Fixed — `If-None-Match: *`, bucket policy, 412 = alerted failure, verification doc |
| S2 | Security | Major | Fixed — signing key/tag secret required only by the publisher; app task drops them |
| S3 | Security | Major | Fixed — anchors bucket SSE-S3 |
| T-2 | Testing | Major | Fixed — client-options seam; contract test rewritten |
| T-3 | Testing | Major | Fixed — scheduler extracted with injected clock |
| T-4, T-5, T-11 | Testing | Major / Minor | Fixed — positive markers, in-image boot in container-scan, `env -i` |
| T-6 | Testing | Major | Fixed — filters on real emitted lines, pinned by a test |
| T-7, T-A1 | Testing | Major / Minor | Fixed — snapshot/restore of global rows, far-future boundary, key-aware fake |
| T-8 / F14 | Testing, Functionality | Major / Minor | Fixed — terraform CI job |
| T-9 | Testing | Major | Fixed — stubbed terraform records asked output names |
| T-10 | Testing | Major | Fixed — CI path filter |
| T-12 | Testing | Major | Fixed — per-site emits, publisher TestRole, deny pair |
| T-13, T-14, T-15, T-16 | Testing | Major | Fixed — publisher env test, SIGTERM test, measured timeouts, manual-test file |
| S4, S5, S6/F13, S8, S9, S10, S11, F8, F9, F10, F11, F12, T-17..T-20, A1 (env coerce), S-A1 | — | Minor | Fixed in revision 2 |

## Recurring Issue Check
Per-expert statuses in the sub-agent outputs; summarised:
- Functionality: R1/R9/R17/R18 F4; R3 F5; R14/R29 F1; R16/R42 F10; R33 F14; R38 F3; R41/R50 F7;
  R49 F10, F2, F6; R55 F8.
- Security: R1/R43/R54 S7; R29/R31 S6; R34 A1; R43 S2; R49 S1, S3; RS* N/A or OK.
- Testing: R3/R19 T-7, T-12; R14 T-12; R16 T-5, T-11; R18/R33 T-10; R29 T-6; R32 T-4, T-5; R35
  T-16; R41 T-1, T-2; R42 T-12, T-17, T-9; R47 T-17; R49 T-5; R50 T-8, T-1; R53 T-15; RT1 T-7,
  T-2; RT4 T-7; RT5 T-2, T-12; RT6 T-3, T-13; RT7 T-1, T-4, T-6, T-9; RT8 T-13; RT10 T-12, T-13;
  RT11 T-7, T-A1.

---

# Round 2
Date: 2026-10-24

Round-1 findings confirmed resolved except where continued below. New findings on revision 2,
applied in revision 3:

| ID | Source | Sev | Disposition |
|----|--------|-----|-------------|
| F-N1 / S-N1 | Functionality, Security | Critical / Major | Fixed — the anchor keys leave the app's boot-time key validation in both providers; test with the app task's env |
| F-N2 | Functionality | Major | Fixed — two-phase publish: manifest stored as pending before the upload (outside any tx, bounded as a whole); 412/409 → GET, identical bytes = our own upload; the chain cannot fork |
| F-N3 | Functionality | Major | Fixed — healthy-cadence absence alarm counts `published`, `skipped_no_tenants`, `skipped_already_published`; scenario corrected |
| S-N2 | Security | Major | Fixed — CloudTrail trail a documented prerequisite, checked in the manual test |
| T-N-1 | Testing | Major | Fixed — MinIO started by a digest-pinned `docker run` step |
| T-N-2 | Testing | Major | Fixed — deny/allow asserted by bypass notices (report mode) |
| T-N-3 | Testing | Major | Fixed — `beforeAll` refuses unless only the test's tenants are chain-enabled |
| T-N-4 | Testing | Major | Fixed — container-scan runs the smoke in a docker-runner mode |
| T-N-5 | Testing | Major | Fixed — overlap proved via `pg_locks`; `lock_held` live again via `lock_timeout` |
| S-N5 | Security | Minor | Fixed — existing workers keep the shared role (retention-GC S3 deletes, outbox aws-sm); SC4 |
| S-N3, S-N4, F-N4, F-N5, F-N6, T-N-6, T-N-7, T-N-8 | — | Minor | Fixed in revision 3 |

Found while revising: phase B clears the pending record by `upsert` to an empty value — the
publisher holds INSERT/SELECT/UPDATE on `system_settings` (manifest lines checked), no DELETE.

## Recurring Issue Check (round-2 delta)
Functionality: R3/R42 N1; R38/R56 N2; R41/R50 N3; R49 N4. Security: R3/R42 N1, N5; R41/R49 N2;
R29 N3. Testing: R16/R41/R50 N-1; R14/R49 N-2; RT4 N-5; RT7/RT9 N-4; RT8/RT10 N-2; RT11 N-3, N-7.

---

# Round 3
Date: 2026-10-24

Round-2 findings resolved (F-N1..N6, S-N1..N5, T-N-1..N-8 except T-N-5, continued below). Round 3
found the revision-3 two-phase design defective in ways that patches would compound, so C2 was
redesigned (revision 4) instead of patched:

| ID | Source | Sev | Disposition |
|----|--------|-----|-------------|
| T-R-1 | Testing | Critical | Resolved by redesign — a session-level advisory lock spans the whole run, so overlap is observable (`pg_locks`) and the red proofs can fail |
| F-P1 | Functionality | Major | Resolved by redesign — no pending record; a forward walk adopts verified objects, so an unrecorded upload is settled before the next boundary chains |
| F-P2 | Functionality | Major | Resolved by redesign — one lock for the whole run |
| S-R3-1 | Security | Major | Resolved by redesign — no decision rests on a `system_settings` value alone; the pointer is trusted only after its object verifies |
| T-R-2 | Testing | Major | Fixed — crash and conflict cases run on `S3Destination`/MinIO and the create-only filesystem destination |
| T-R-3 | Testing | Major | Resolved by redesign — no pending reuse to distinguish |
| T-R-4 | Testing | Major | Fixed — `lock_held` by an external session holding the lock; nested SQLSTATE via `pgErrorCode` red-proven |
| F-P3 | Functionality | Minor | Fixed — 409 retried within the bound; adopted objects checked with `GetObjectRetention` |
| F-P4 | Functionality | Minor | Resolved by redesign — no pending record, no in-band empty sentinel |
| F-P5 | Functionality | Minor | Fixed — `already_published` counts as healthy only when decided from a verified object |
| F-P6 | Functionality | Minor | Fixed — concrete budget under Fargate's 120 s `stopTimeout` |
| S-R3-2 | Security | Minor | Fixed — SC4 reason corrected |
| T-R-5 | Testing | Minor | Fixed — the crash case asserts B_{n+1}'s `previousManifest.sha256` |

## Recurring Issue Check (round-3 delta)
Functionality: R38/R56 P1; R5/R48 P2; R49 P3; R55 P4; R41/R50 P5. Security: R43/R49/R55 R3-1;
R29 R3-2. Testing: RT4/RT7 R-1; RT7/RT1/RT5 R-2; RT7 R-3, R-4.
