# Plan Review: aws-anchor-publisher-and-scram-verifier
Date: 2026-10-23
Review round: 1

## Changes from Previous Round

Initial review (fresh reviewers).

## Outcome

The round showed the two issues are not one change. `#941` is split onto its own branch and
plan (`scram-verifier-role-passwords`); `#940` stays here and is re-planned with the findings
below before a second round. User decisions taken during the round: the verify worker is
included and connects as `passwd_app`; `@aws-sdk/client-s3` becomes a dependency, statically
imported by `s3-destination.ts` so esbuild bundles it into the publisher.

## Findings carried into the #940 re-plan

| ID | Source | Sev | Summary |
|----|--------|-----|---------|
| F-F1 | Functionality | Critical | The publisher bundle crashes at module load without `DATABASE_URL` (`audit.ts` → `prisma.ts` builds its pool at load; reproduced), its env schema requires `DATABASE_URL`, and its audit emits go through the `passwd_app` pool |
| F-F2 / T-T1 | Functionality, Testing | Critical | S3 publish cannot succeed: `@aws-sdk/client-s3` absent from package.json and the image (confirmed); anchors bucket has Object Lock off by default while the PUT sends retention headers; the policy lacks `s3:PutObjectRetention`; failure only at the first cadence, invisible to `RunningTaskCount` |
| F-F3 / T-T5 / T-T6 | Functionality, Testing | Major | Bundle smoke boots every bundle with one superset env and exits before destinations; publisher name not matched by its extraction; no override hook for a red proof; the verify worker has nothing to validate |
| F-F4 | Functionality | Major | ECS task replacement: overlapping publishers can double-publish one `artifactKey`; a restart across a boundary skips a cadence; `desired_count` shared with other workers |
| S-F2 | Security | Major | Both new tasks would hold the shared task role (attachments `DeleteObject`, anchor PUT); the verify worker needs no AWS access |
| T-T7 / F-F7 | Testing, Functionality | Major | `rls_bypass_report_log_groups` and its exact-match test omit the new log groups; smoke self-test, CLAUDE.md, AWS docs service tables |
| T-T8 / F-F8 | Testing, Functionality | Major | No terraform fmt/validate anywhere in CI; deploy-rollback stub is self-referential for output names; secret keys undocumented today (5 app keys, ja README, `DEPLOYMENT_ID`) |
| F-F9, F-F10, F-F11, S-F7, A1 | — | Minor | `DEPLOYMENT_ID` on restored data; verify worker sleeps through SIGTERM; prose; `passwd_app` surplus stated plainly; KMS permissions when `s3_kms_key_arn` is set |

## Findings moved to the #941 plan

S-F1 / F-F5 (member set over every spelling; initdb `\getenv` paths are operator secrets; three
bootstrap statements), S-F3 (server `scram_iterations`), S-F4 (what a verifier exposes), S-F5 /
F-F6 / T-T4 (shell glue, stdin, node dependency, output validation, retention-gc test missing),
S-F6 (`log_statement`), S-F8 (docs drift), S-A1 (`bash -x`), T-T2 (StoredKey half of the vector),
T-T3 (vacuous capture), T-T9, T-T10, T-T11.

## Recurring Issue Check

Preserved per expert in the sub-agent outputs; summarised:
- Functionality: R3/R16/R17 F5; R9/R22 F1; R14/R41 F2; R18/R19 F7; R29 F5, F11; R32/R50 F3; R34
  F8; R38/R49 F4; R42 F5, F7, F8; R43 F1; R47 F5; others N/A or OK.
- Security: R2 F3; R3/R16/R17/R34/R42 F1; R14 F7; R29 F1, F4; R43 F2; R49 F1, F2, F7; RS3 F5; RS5
  F3; RS1/RS2 N/A; RS4/RS6 OK; others N/A.
- Testing: R16 T9, T5/T6; R18 T7; R19/R41 T1; R29 T10; R32 T1, T5, T6; R35 E1; R42 T5, T4; R47 T3;
  R49 T1, T6; R50 T8, T9; RT1 T1; RT5 T4; RT6 T6; RT7 T2, T5; RT8 T4; RT10 T6, T11; RT2/RT11 OK.
