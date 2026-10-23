# Code Review: scram-verifier-role-passwords
Date: 2026-10-24
Review round: 1

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
