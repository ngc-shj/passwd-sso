# Plan Review: post-530-hardening

Date: 2026-06-11
Review round: 1 (+ targeted R2 on C3)

## Round 1

### Functionality — no blockers
- C3 REVOKE CONNECT verified safe: all 4 app/worker roles have explicit GRANT CONNECT (initdb `02-create-app-role.sql:27,63,107` + migrations for dcr_cleanup); `passwd_user`/CI `postgres` are superuser (exempt); `jackson_user` relies on PUBLIC only → REVOKE blocks exactly it. CI parity confirmed (RLS smoke connects as passwd_app; integration as superuser/app/workers). `--create-only` + hand-written SQL checksum is the standard supported flow.
- C1/C2/C4/C5 mechanisms confirmed implementable. F1 (current_database() resolution — info, matches existing pattern), F2 (check:env-docs doesn't regenerate-compare — pre-existing gap → recorded as SC2 TODO).

### Security — S1 [Minor]
- C3 availability re-verified by enumerating EVERY connector (app, 3 workers, migrate, db healthcheck `pg_isready -U passwd_user` = superuser, jackson service connects to the `jackson` DB not `passwd_sso`, build-time dummy URL = no real connection) — none rely on PUBLIC connect. No outage risk.
- **S1 [Minor]**: C2 missed `contexts.trace.description` — the ROOT span's name lives there (not in `spans[].description`), same capability-URL leak class. → C2 extended to scrub `contexts.trace.description`.
- C1 no secret-exposure delta (parity with existing PASSWD_* env practice); C4 placeholder-only (no real secret).

### Testing
- **T1 [Critical]**: C3's "jackson_user cannot connect" invariant had NO automated test, and CI's integration DB has no `jackson_user` (initdb not mounted) — so calling CI the "authoritative proof" was false for this invariant (only the legit-roles-still-connect half is CI-checkable). → C3 now adds a db-integration privilege-assertion test using a throwaway no-grant **probe role** (`has_database_privilege` FALSE proves PUBLIC connect revoked, CI-safe — no jackson_user dependency) + asserts the 4 legit roles TRUE (closes T2), both branches (RT4).
- **T2 [Major]**: "integration suite stays green" only exercises app/superuser connects, not anchor/dcr — folded into T1's all-4-roles privilege assertion.
- **T3 [Minor]**: C2 fixtures red-able + non-breaking (confirmed); added an assert distinguishing redactCapabilityPaths from sanitizeUrl (suffix survives).
- **T4 [Minor]**: check:env-docs doesn't pin comment-vs-uncomment → C4 adds a generate-env-example.test.mjs assertion (REDIS_PASSWORD uncommented + NOT commented + NOTE retained).
- R35: the mechanical hook does NOT match `prisma/migrations/*.sql` (no fire); manual-test.md correctly omitted, SUPERSEDED by the T1 automated privilege assertion.

## Round 2 (targeted — C3 test mechanism)

Verifying the probe-role `has_database_privilege` approach below.

## Resolution Status (Round 1)

S1, T1, T2, T3, T4 reflected in the plan (C2 trace.description, C3 privilege-assertion test, C4 env-example test). F2 → SC2 TODO. No skips.

## Round 2 result

C3 probe-role mechanism verified sound (PG `has_database_privilege` evaluates PUBLIC+explicit+membership; NOLOGIN irrelevant to the CONNECT-priv check; CI superuser can CREATE/DROP ROLE; all 4 legit roles exist in CI at test time). **T5 [Low]**: idempotent `DROP ROLE IF EXISTS` + try/finally to avoid probe-role residue on local re-run — reflected in C3. Plan review CLOSED; all contracts locked.
