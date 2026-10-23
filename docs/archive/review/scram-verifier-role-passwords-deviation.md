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
