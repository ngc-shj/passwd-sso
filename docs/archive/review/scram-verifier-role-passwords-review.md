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

---

# Round 2
Date: 2026-10-23

Round-1 fixes confirmed by their filing experts except where noted. New findings on revision 2,
applied in revision 3:

| ID | Source | Sev | Disposition |
|----|--------|-----|-------------|
| F-N1 | Functionality | Major | Fixed — regression from revision 2: unconditional SETs + ON_ERROR_STOP broke non-superuser admins (Azure/GCP docs); SETs now under `\if :su` |
| F-N2 / S-N4 | Functionality, Security | Major / Minor | Fixed — compose passes `""` for an unset variable and `\getenv` defines it; `02` branches on a non-empty value |
| F-N3 | Functionality | Major | Fixed — env-allowlist, `.env.example`, `init:env` for the new compose variable |
| F-N4 / S-N3 | Functionality, Security | Major / Minor | Fixed — pgss check from the `postgres` database, by count; never `CREATE EXTENSION` in `passwd_sso`; reset privilege stated |
| S-N1 | Security | Major | Fixed — upgrade note: rotate or `NOLOGIN` the anchor-publisher role on existing volumes |
| S-N2 | Security | Major | Fixed — every documented `\password` preceded by `SET password_encryption = 'scram-sha-256'` and the logging SETs |
| T-R2-T1, T2, T3 | Testing | Major | Fixed — fake psql answers the iteration query; exact-stdin assertion with ON_ERROR_STOP; node stub for the format guard and node-absent |
| T-R2-T4, T5 | Testing | Major | Resolved by removal — the live save/restore of real roles is dropped (its failure paths overwrite shared credentials); the helper is proven against the server in C2 and the glue by exact-stdin cases; each script run once by hand and recorded |
| S-N5, S-N6, S-N7, S-N8, F-N5, F-N6, A1, T-R2-T6..T10 | — | Minor | Fixed in revision 3 (`track_utility` placeholder SET checked on the dev DB) |

## Recurring Issue Check (round-2 delta)
Functionality: R3/R29 N6; R16/R41/R55 N2; R18 N3; R43/R52 N1; R49 N4. Security: R3 N2, N5;
R14/R16 N1, N4; R29 N3, N4; R41 N4; R42 OK (member set recomputed); R49 N3, N5; R50 N3; RS3/RS5
N6. Testing: R3 T1; R16/R50 T5; R42 T8; RT1 T6; RT7 T2, T3; RT10 T3, T10; RT11 T4.

---

# Round 3
Date: 2026-10-23

All round-2 findings confirmed resolved. New findings on revision 3, applied in revision 4:

| ID | Source | Sev | Disposition |
|----|--------|-----|-------------|
| T-R3-T1 | Testing | Major | Fixed — the dropped live case returns as a replay of the recorded stdin against a probe role, as superuser and as the non-superuser stand-in; same-cluster check for the compose psql; `\if true` red proof |
| T-R3-T2 / F-M1 | Testing, Functionality | Major / Minor | Fixed — outer `\if :{?v}` kept; one-shot check runs unset, empty and set |
| S-R3-1 | Security | Minor | Fixed — order test anchors on the first password-interpolating statement |
| S-R3-2 / F-M3 | Security, Functionality | Minor | Fixed — upgrade check over `-h db`; NOLOGIN option's audit mismatch and `.env` update stated |
| S-R3-3 | Security | Minor | Fixed — anchor snippet written in full with its SETs |
| S-R3-4 / F-M2 | Security, Functionality | Minor | Fixed — count excludes verifier and md5 statements, matches USER too; E1 note widened |
| S-R3-5, T-R3-T3, T-R3-T4 | — | Minor | Fixed |

## Recurring Issue Check (round-3 delta)
Functionality: R41/R55 M1; R50 M2; R29 M3. Security: R29 R3-3, R3-5; R42/RT7 R3-1; R49 R3-5; R50
R3-2, R3-4. Testing: RT1/R50/RT7 R3-T1; RT10 R3-T2, R3-T3; R3 R3-T4.

---

# Round 4
Date: 2026-10-23

All round-3 findings confirmed resolved. Round 4 raised Minors only, all applied in revision 5:
F-A1 / T-R4-T1 / S-R4-2 (committed stand-in and probe roles: stand-in creates the probe, random
password, LOGIN revoked in `finally`, pre- and post-clean), T-R4-T2 (order check anchors on every
non-`\getenv` statement, fixture with a variable not named `*password*`), T-R4-T3 / S-R4-1 (pgss
count matches the clause not the word — the app's `password_*` tables would otherwise keep it
non-zero — run with positive and negative controls).

Plan phase closed after 4 rounds: no Critical or Major open; the round-4 findings were Minors
against test mechanics and one detection query, all applied; every contract locked.
