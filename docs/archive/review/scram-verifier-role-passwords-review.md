# Plan Review: scram-verifier-role-passwords
Date: 2026-10-23
Review round: 1

## Changes from Previous Round

Initial review (fresh reviewers) of revision 1.

## Merged findings and disposition (applied in revision 2)

| ID | Source | Sev | Disposition |
|----|--------|-----|-------------|
| F1 / S1 / T1 | all three | Critical | Fixed — psql's prompt reads `/dev/tty`; the scripts no longer use `\password` but the helper's verifier (C3) |
| S2 | Security | Major | Fixed — moot with C3 (the verifier is always SCRAM) |
| S3 | Security | Major | Fixed — measured: `pg_stat_statements` keeps role statements verbatim; objective widened, C5 adds the check and reset |
| F2 / T3 | Functionality, Testing | Major | Fixed — `current_setting('scram_iterations', true)`, no error in the transaction |
| F3 | Functionality | Major | Fixed — rationale restated (helper has no SASLprep; node-postgres and the server do); behaviour change documented |
| F4 / S4 | Functionality, Security | Major / Minor | Fixed — scripts SET both logging GUCs (superuser URL) |
| F5 | Functionality | Major | Fixed — anchor snippet: `WITH LOGIN` + piped `\password` under `exec -T` |
| A1 (Security) | Security | Major (adjacent) | Fixed in scope — compose forwards the variable; fallback `NOLOGIN` |
| T2 | Testing | Major | Fixed — `SET scram_iterations` 10000 / 1000 cases and red proofs |
| T4 | Testing | Major | Fixed — params recorded; all three statements, non-superuser via the stand-in |
| T5 | Testing | Major | Fixed — CLI spawn with the bad value last, paired with the ASCII control |
| T6 | Testing | Major | Fixed — `bash -x`, env, argv, output asserted with a sentinel; one parametrised file |
| T7 | Testing | Major | Fixed — trailing LF accepted; interior LF/CR refused |
| T8 | Testing | Major | Fixed — live case per script with a psql shim; CI pins host psql |
| T9 | Testing | Major | Fixed — C4 static test with derived set and fixture red proofs, plus a one-shot real-log check |
| F6, F7, F8/T11, F9, F10, F11, F12, S5, S6, S7, S8, T10, T12, A1 (iteration cap), A3 | — | Minor | Fixed in revision 2 |
| A2 (Security) | Security | Minor (adjacent) | Out of scope — ECS Exec session logging during the RDS bootstrap; carried to the `#940` re-plan, which touches the ECS cluster |

## Recurring Issue Check

Per-expert statuses are in the sub-agent outputs; summarised:
- Functionality: R3 F5, F6; R16/R22/R35/R41/R50 F1; R17/R49 F4; R18 F8; R29 F3, F8, F10, F12; R34
  F11; R41 F2; R42 F6; R44 F11; R48 F3; others N/A or OK.
- Security: R3 S2, S5; R14/R16 A1; R17 S4; R29 S8, S4, S6; R34 A1, A2; R41/R50 S1; R42 S8, S3; R49
  S3, S5; RS3 OK; RS5 S2; RS1/RS2 N/A; RS4/RS6 OK.
- Testing: R3 T4; R16/R50 T1, T8; R19 T6; R29 T10, T11; R35 T1, T9; R42 T4, T9; RT1 T3; RT5 T5;
  RT7 T2, T4, T9, T10; RT8 T5, T7; RT10 T7, T2; RT2/RT6/RT11 OK.
