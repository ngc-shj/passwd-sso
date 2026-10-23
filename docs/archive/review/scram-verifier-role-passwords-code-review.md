# Code Review: scram-verifier-role-passwords
Date: 2026-10-24
Review round: 2

## Changes from Previous Round

Initial review (fresh reviewers), on top of the Phase 2 self-check (deviation D8).

## Findings and disposition

| ID | Source | Sev | Disposition |
|----|--------|-----|-------------|
| F-F1 | Functionality | Major | Fixed — the statement-text settings re-derived from `pg_settings` with a classifying integration guard (D9); nine settings, one module |
| T-F1 | Testing | Major | Fixed — the replay reads every listed setting after the ALTER: the list's values as superuser, the server defaults otherwise; `\if false` red-proven (D10) |
| T-F2 | Testing | Major | Fixed — the role swap is checked before any psql runs; red-proven with the real role unchanged (D10) |
| T-F3 | Testing | Major | Fixed — positional-argument case; red-proven (D10) |
| S-F1 / F-F2 | Security, Functionality | Minor | Fixed — every documented `\password` sets the full list; executed with and without (D9) |
| S-F2 | Security | Minor | Fixed — the bootstrap sets the list as a superuser before `BEGIN`; unit-tested both ways |
| S-F3 | Security | Minor | Not adopted, by design: `SET LOCAL` cannot cover `log_transaction_sample_rate` (decided at transaction start), and `MIGRATION_DATABASE_URL` is a direct or session-pooled URL — prisma migrate requires one — so a session SET does not reach another client. initdb is a one-shot session. Stated in `statement-text-settings.mjs` |
| S-F4 | Security | Minor | Not adopted (user decision): a minimum length would refuse existing shorter passwords at the next rotation. Residual: the server's password-strength hooks no longer see the password; the docs keep recommending `openssl rand -hex` |
| S-F5 | Security | Minor (adjacent) | Fixed (user approved) — `CLAUDE.md` example reads the password from stdin |
| F-F3 | Functionality | Minor | Fixed — the dev-volume procedure reads only the one key from `.env`; executed |
| F-F4 | Functionality | Minor | Not adopted: `init:env` composes none of the worker URLs from their passwords; the entry's description states the value must match `AUDIT_ANCHOR_PUBLISHER_DATABASE_URL`, and a fresh volume without the variable makes the role `NOLOGIN` rather than mismatched. Worst case: an operator generates the value and forgets the URL — the publisher fails to authenticate loudly at boot. Cost to fix: an init:env URL-composition feature for one key, out of `#941`'s scope |
| F-F5 | Functionality | Minor | Fixed — allowlist wording: the script takes the value on stdin |
| F-F6 | Functionality | Minor | Fixed — every initdb role treats an empty value as unset |
| T-F4 | Testing | Minor | Fixed — the `set-*-password.sh` member set is derived and each is pinned to its library call |
| T-F5 | Testing | Minor | Fixed — iteration-query failure, `200000` and `abc` cases |
| T-F6 | Testing | Minor | Fixed — the ALTER-fails case asserts the ALTER was sent |
| T-F7 | Testing | Minor | Fixed — metacharacter password case |
| T-F8 | Testing | Minor | Fixed — `RESET ROLE` in `finally` during replay setup |
| T-F9 | Testing | Minor | Fixed — `set_config`, `ALTER … SET` and `\i` refused by the initdb check; refusal reasons asserted |

## Recurring Issue Check

Functionality: R3 F2; R34 F6; R42 F1 (sink class derived by hand — now derived from the server);
R49 F2; others OK or N/A. Security: R3 F1, F2; R54 F3 (not adopted, reason above); RS1–RS6
OK. Testing: R31/RT11 F2, F8; R42 F4; R47 F9; R49/RT7 F1; RT8 F6; RT10 F3.

## Environment Verification Report

E1 (no RDS): bootstrap verified locally against PostgreSQL 16 as a superuser and as a
non-superuser CREATEROLE stand-in (`verified-local`, T11); RDS-specific behaviour
(`SET` refused to the master) `blocked-deferred` per plan E1 / SC2. E2 (no host
psql): CI pins host psql (`SET_ROLE_PASSWORD_EXPECT_PSQL=host`, `verified-CI` on
push); locally the compose fallback (`verified-local`).

## Resolution Status

All Critical/Major findings fixed and red-proven; Minors fixed or recorded above.

---

# Round 2
Date: 2026-10-24

Round-1 fixes confirmed by their filing experts except where noted below.

| ID | Source | Sev | Disposition |
|----|--------|-----|-------------|
| F-N1 (continuing F-F3) | Functionality | Major | Fixed — the round-1 `sed` kept `init:env`'s quotes; the procedure now lets compose read `.env` (D11) |
| S-N1 / F-N2 | Security, Functionality | Major / Minor | Fixed — bootstrap suppression scoped to each password statement; red-proven (D11). initdb keeps file scope (one-shot, grants are repository files) |
| S-N2 / F-N3 / T-N2 | Security, Functionality, Testing | Minor | Fixed — initdb emptiness decided in the shell, never sent; the module states the derived categories and names the extension and `pg_stat_activity` residuals |
| S-N3 | Security | Minor | Fixed — Jackson psql with `-X -v ON_ERROR_STOP=1` |
| T-N1 | Testing | Minor | Fixed — static empty-value check with fixtures; executed empty/set on throwaway PG16 (D11) |

## Recurring Issue Check (round-2 delta)
Functionality: R43 F-N2; R49 F-N3; R50/R29 F-N1. Security: R54 S-N1 (was F3); R42/R49 S-N2.
Testing: R35/R50 T-N1; R42 T-N2.
