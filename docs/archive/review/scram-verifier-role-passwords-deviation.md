# Coding Deviation Log: scram-verifier-role-passwords

## D1 — C3 logic lives in one sourced library

The plan describes what "each script" does. The three `scripts/set-*-password.sh`
were identical apart from the role name and the log label, so the logic is in
`scripts/lib/set-role-password.sh` (`set_role_password <role> <label> "$@"`) and
each script is a header plus one call, beside the existing `lib/psql-safe.sh`.
Behaviour is as C3 specifies; one test file covers all three entry points.

## D2 — helper exports

`scripts/lib/scram-verifier.mjs` also exports `assertUsablePassword` (used by
`bootstrap-rds-roles.mjs` `main` to check every password before connecting) and
the `MIN_SCRAM_ITERATIONS` / `MAX_SCRAM_ITERATIONS` constants.

## D3 — found while running the integration test

`convergeRole` declared `rows` twice after the iteration lookup was added
(`SyntaxError` on import); renamed to `iterationsSetting`. The integration run,
not a unit test, caught it — the unit tests do not import the bootstrap script.

## D4 — C4 one-shot check (throwaway `postgres:16-alpine -c log_statement=all`)

Sentinel passwords for app, outbox, retention and jackson; counts are lines in
`docker logs` matching `Sentinel[0-9]`.

| Run | Init | Sentinel lines | `passwd_anchor_publisher` |
|-----|------|----------------|---------------------------|
| `PASSWD_ANCHOR_PUBLISHER_PASSWORD` unset | completes | 0 | NOLOGIN, no password, `\warn` printed |
| set empty | completes | 0 | NOLOGIN, no password |
| set to a sentinel | completes | 0 | LOGIN; the sentinel logs in over the container IP (scram) |
| red: the SET block removed from a copy | completes | 4 | — |

Refused statement: a fixture `05-refused.sql` sending `CREATE ROLE passwd_app LOGIN
PASSWORD 'RefusedSentinel6'` (role exists): with the SET block, 0 lines carry the
sentinel and the `already exists` ERROR is still logged; without it, 2 lines (the
server's STATEMENT and psql's `LINE 1:` excerpt).

## D5 — C3 run by hand against the dev DB

Each script, with a PATH shim forwarding `psql` to `docker compose exec -T db psql`
(no host psql), given the role's current password: all three printed `OK`, the
superuser branch's three `SET`s ran, `rolpassword` became `SCRAM-SHA-256$4096:…`,
and over the published port (scram) the password logs in and `wrong-pw` gets
`28P01`. The automated replay (T11) covers the non-superuser branch.

## D6 — red proofs (scratch copy; each base run green first)

| Mutation | What went red |
|----------|---------------|
| `update("Server Key")` → `"Server Kay"` | ServerSignature case only |
| StoredKey = ClientKey (unhashed) | StoredKey case only |
| one logging `SET` dropped from the script | exact-stdin and DRY_RUN cases, ×3 scripts |
| `--iterations 4096` hard-coded in the script | the `10000` case, ×3 |
| xtrace not turned off | the `bash -x` case, ×3 |
| verifier shape check removed | both node-stub cases, ×3 |
| cleartext at the non-superuser ALTER | T11 "every password statement carries a verifier" |
| `iterations: 4096` hard-coded in the bootstrap | T11 "scram_iterations 10000" |
| `\if :su` → `\if true` | T11 replay as the non-superuser only |
| `scripts/lib/scram-verifier.mjs` not COPYed | `check-runtime-image-assets.mjs` (before the COPY was added) |

The replay cases need the compose project to be `passwd-sso` when they fall back
to `docker compose exec`; in a scratch copy under another directory name they went
red for that reason until `COMPOSE_PROJECT_NAME=passwd-sso` was set. CI uses the
host psql (`SET_ROLE_PASSWORD_EXPECT_PSQL=host`).

## D7 — documented commands, run

- `pg_stat_statements` count (throwaway PG16, library preloaded): 0 with a query on
  a `password_entries` table and a verifier `ALTER ROLE` in the view; 1 after a
  cleartext `ALTER ROLE r1 PASSWORD 'x'`; 0 after `pg_stat_statements_reset()`.
- Production `passwd_app` snippet (same container): role created without a
  password, `\password` from piped stdin under `exec -i` stored `SCRAM-SHA-256$…`.
- Dev-volume anchor procedure on the dev DB with the current value: ran; the
  `${…:?}` guard stops an empty value.
- Jackson Step 2 with the added SETs: ran; Jackson still connected.
- Upgrade-note check on the dev DB: `PGPASSWORD=passwd_anchor_publisher_pass psql -h
  db -U passwd_anchor_publisher` **logged in** — this dev volume carries the
  published password, as the note says every pre-change volume does.

## D8 — Phase 2 self-check fixes

- All three self-checks: the scripts' superuser block omitted `SET
  log_min_duration_statement = -1`, which C4 sets in initdb — the plan's C3 listed
  three sinks, C4 four. Added; the headers now name all four. Red-proven: removing
  it turns the exact-stdin and DRY_RUN cases red (6).
- The other three initdb LOGIN fallbacks (`passwd_app_pass`, `passwd_outbox_pass`,
  `passwd_retention_gc_pass`) carried the same published-password problem as the
  anchor publisher's. Compose requires their variables, so only another launcher
  reached them; they are now `NOLOGIN` with a `\warn` too. Checked on a throwaway
  `postgres:16-alpine` with no role variables: init completes, every role is
  `NOLOGIN` with no password, one warning each.
- An unknown argument is no longer echoed (a password passed positionally would
  have reached stderr).
- DRY_RUN passes an empty iteration value and lets the helper resolve it, instead
  of a second copy of 4096.

## D9 — Phase 3 round 1: the statement-text settings, derived

The settings list grew by review twice (three → four in D8, then
`log_min_duration_sample`, `log_transaction_sample_rate`), so it was re-derived
from the server rather than extended: every setting PostgreSQL files under "What
to Log" / "When to Log" is either listed in `scripts/lib/statement-text-settings.mjs`
(nine, adding the three `debug_print_*`, whose parse trees carry literals) or
excluded with a reason in `statement-text-settings.integration.test.ts`, which
fails on any unclassified one. The bootstrap imports the list (and, as a
superuser, now sets it before `BEGIN`); the rotation library and initdb are pinned
to it by `statement-text-settings.test.mjs`. All are session SETs: `SET LOCAL`
would come too late for `log_transaction_sample_rate`, and `MIGRATION_DATABASE_URL`
is a direct or session-pooled URL (prisma migrate requires one), so they cannot
leak across clients.

Executed on throwaway `postgres:16-alpine` with `log_min_duration_statement=0`,
`log_transaction_sample_rate=1`, `log_min_duration_sample=0`, `debug_print_parse=on`:
- initdb with sentinel passwords: 0 sentinel lines; a copy without the SET block:
  25.
- `\password` (pg_stat_statements preloaded): with the documented SETs 0 log lines
  carrying `SCRAM-SHA-256` and 0 `pg_stat_statements` rows; without them 3 and 1.

## D10 — Phase 3 round 1: red proofs for the new tests (scratch copy, base green)

| Mutation | What went red |
|----------|---------------|
| `\if :su` → `\if false` | T11 replay as the superuser only (the new settings probe) |
| role name emitted as `\"${role}\"` | both replay cases, at the swap guard, before psql; `passwd_outbox_worker`'s `rolpassword` unchanged |
| unknown argument echoed again | the positional-argument case, ×3 |

A first attempt quoted the role as `"${role}"`, which inside bash's double-quoted
string closes and reopens the quote and changes nothing; it stayed green for that
reason, and was redone.

## D11 — Phase 3 round 2

- The bootstrap's statement-text SETs are scoped to each password statement (SET
  before, RESET after, inside the transaction), so a superuser run's GRANTs and
  REVOKEs stay logged; only `log_transaction_sample_rate` is a session SET before
  `BEGIN` (decided at transaction start; sampling is not the audit concern).
  initdb keeps them for the whole file — it runs once on an empty volume and its
  grants are the repository's own files. Red-proven: removing the RESETs turns the
  T11 wrapping assertion red.
- initdb no longer sends a password to the server to test it for emptiness: `has_X`
  is decided by the shell in psql backticks (`[ -n "$VAR" ]`), and a static check
  requires every `PASSWORD :'X'` to sit under `\if :has_X` decided that way.
  Executed on throwaway `postgres:16-alpine` (`log_statement=all`, duration,
  sampled and `debug_print_parse` logging on): all five variables empty → init
  completes, every role `NOLOGIN` with no password; all set → every role `LOGIN`
  and each sentinel logs in over the container IP; 0 sentinel lines either way.
- The dev-volume anchor procedure lets compose read `.env` (recreate `db`, then
  the Jackson pattern inside the container): `npm run init:env` writes quoted
  values, which the previous `sed` extraction kept as part of the password.
  Checked: compose resolves a quoted and an unquoted line to the same value; the
  in-container guard stops when the variable is absent (as it is on the current
  dev container, created before compose forwarded it). The D9 run of the old
  procedure used an unquoted line and could not see this.
- The Jackson procedure runs psql with `-X -v ON_ERROR_STOP=1`, so a failing SET
  stops it before `\password`.
- `statement-text-settings.mjs` states its reach: PostgreSQL's two logging
  categories are derived; pg_stat_statements is listed by hand; other extensions
  (pgaudit, auto_explain) and `pg_stat_activity.query` are residuals.
- Test fix: the replay's non-superuser comparison reads server defaults on a fresh
  connection — the shared `su` had run the bootstrap, which sets transaction
  sampling for its session.
