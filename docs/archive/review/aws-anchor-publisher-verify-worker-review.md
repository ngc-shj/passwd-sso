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
