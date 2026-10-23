# Plan: scram-verifier-role-passwords

Issue: `#941`. Branch `feat/scram-verifier-role-passwords`, base `origin/main` 3383b3fcb.
Revision 4 — after plan-review rounds 1–3 (`scram-verifier-role-passwords-review.md`). Split out of
`aws-anchor-publisher-and-scram-verifier` (branch `feat/aws-anchor-publisher-and-scram-verifier`,
commit 32f392d3a) after its round-1 review.

## Project context

- Type: `mixed` (operator scripts, initdb SQL, compose, docs). Tests: unit + real-PostgreSQL
  integration + CI.
- Verification environment constraints:
  - E1 — no RDS. Everything is verified on local PostgreSQL 16; storing a pre-computed verifier is
    the server's own behaviour (`encrypt_password` keeps a parseable SCRAM secret unchanged under
    any `password_encryption`), not an RDS feature. Whether the RDS master may `SET
    log_statement` is not verifiable; nothing depends on it.
  - E2 — the dev host has no `psql`; the live script tests use a shim (testing strategy).

## Objective

A role password must not reach a server-side record of statement text in cleartext. Today:
- a refused `CREATE/ALTER ROLE … PASSWORD '<cleartext>'` is logged under the default
  `log_min_error_statement = error`; every such statement is logged under `log_statement =
  ddl|all`;
- `pg_stat_statements` keeps the statement verbatim (measured on a throwaway `postgres:16-alpine`
  with it preloaded: `CREATE ROLE r1 LOGIN PASSWORD 'SuperSecret123'` and `ALTER ROLE r1 PASSWORD
  'Rotated456'` both listed in `pg_stat_statements`, `track_utility = on`). RDS preloads it by
  default, so prior bootstrap runs left cleartext there, which survives log expiry.

## Member set (R42)

Derived by
`git grep -niE "(CREATE|ALTER) (ROLE|USER)[^;]*PASSWORD|ENCRYPTED PASSWORD|\\\\password|PASSWORD[[:space:]]+(:'|\\$\\{|\\$[a-z]|')" -- scripts infra .github docs src prisma ':!docs/archive' ':!*.test.*'`,
plus prose instructions found by reading (a grep cannot match "ALTER ROLE each role"):

| Member | Credential | Contract |
|--------|-----------|----------|
| `scripts/bootstrap-rds-roles.mjs` `convergeRole`: CREATE, superuser ALTER, non-superuser ALTER | operator secrets on RDS | C2 |
| `scripts/set-{outbox-worker,retention-gc-worker,audit-anchor-publisher}-password.sh` | operator secrets | C3 |
| `infra/postgres/initdb/01`, `02` (×3 roles), `04` — `\getenv` branches | operator secrets forwarded by `docker-compose.yml` (`:?` for app/outbox/retention/jackson) | C4 |
| `02` anchor-publisher role — always the fixed fallback `passwd_anchor_publisher_pass` with `LOGIN`, because compose does not forward `PASSWD_ANCHOR_PUBLISHER_PASSWORD` | a published password on a production LOGIN role | C4 |
| `docs/operations/deployment.md` production `CREATE ROLE passwd_app … PASSWORD '<strong-password>'`; anchor-publisher `ALTER ROLE … PASSWORD :'pw'` | operator secrets | C5 |
| `docs/setup/docker/en.md` "ALTER ROLE each role to match" (prose) | operator secrets | C5 |
| `.github/workflows/ci-integration.yml`, `ci.yml` | per-run values, throwaway container | out of class (SC1) |
| `prisma/migrations/20261023010000_*` `PASSWORD NULL` | no secret | out of class |

## Contracts

### C1 — SCRAM verifier helper
- `scripts/lib/scram-verifier.mjs` exports `scramSha256Verifier(password, { iterations, salt? })`
  → `SCRAM-SHA-256$<iter>:<b64 salt>$<b64 StoredKey>:<b64 ServerKey>` (the `pg_authid.rolpassword`
  format), from `node:crypto` `pbkdf2Sync` (SHA-256, 32 bytes), `createHmac`, `createHash` per
  RFC 5802 §3. Salt `randomBytes(16)` unless passed (tests only; no CLI flag or env reads it).
- Also exports `resolveIterations(serverValue)` → `max(4096, serverValue)` for an integer server
  value, 4096 for NULL; refuses a value above 100000 (node-postgres's
  `DEFAULT_MAX_SCRAM_ITERATIONS` would refuse to log in with it).
- Refuses: an empty password; any non-ASCII character. Reason: the helper does not implement
  SASLprep, and the server and node-postgres both apply it — for ASCII it is the identity (PG's
  ASCII fast path), so the helper's raw-byte derivation matches; for non-ASCII it would not.
  Behaviour change: a non-ASCII `PASSWD_*_PASSWORD` that worked before is now refused; remedy is an
  ASCII value (`openssl rand -hex 32`), documented.
- `resolveIterations` accepts the text `current_setting` returns: `^[0-9]+$` or empty/NULL (→
  4096); anything else is refused.
- CLI: `node scripts/lib/scram-verifier.mjs --iterations <server value>` resolves the value itself,
  reads the password from stdin verbatim (no stripping) and prints the verifier; on refusal it
  exits 1 and prints only the reason, never the value. The same holds for every refusal message in
  C2 and C3.

### C2 — bootstrap-rds-roles sends verifiers
- `main` validates every `PASSWD_*_PASSWORD` (non-empty, ASCII) before connecting.
- `convergeRole` builds the verifier itself (it is exported and called directly) and sends
  `PASSWORD ${escapeLiteral(verifier)}` in all three statements; the cleartext is never
  interpolated.
- Iterations from `SELECT current_setting('scram_iterations', true)` (NULL before PostgreSQL 16;
  no error, so the surrounding transaction is not aborted) through `resolveIterations`.
- Dockerfile: a `COPY` for `scripts/lib/scram-verifier.mjs` beside the existing
  `denied-privileges.mjs` line; `check-runtime-image-assets.mjs` derives it from the import and
  fails without it.
- Forbidden pattern: `escapeLiteral\(password\)` in `scripts/bootstrap-rds-roles.mjs`.

### C3 — set-*-password.sh send a verifier
- Not `\password`: psql's prompt reads `/dev/tty` when the process has a controlling terminal, so
  from an operator's shell the piped password would be ignored.
- Each script: turns xtrace off before reading the password and never restores it; reads stdin
  with `$(cat)` (strips trailing newlines); refuses empty, an interior LF or any CR, non-ASCII;
  reads `current_setting('scram_iterations', true)` with one psql call; builds the verifier with
  `printf '%s' "$pw" | node "$SCRIPT_DIR/lib/scram-verifier.mjs" --iterations "$n"`; checks it
  against `^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$`; sends on
  stdin with `-v ON_ERROR_STOP=1`:
  `SELECT rolsuper AS su FROM pg_roles WHERE rolname = current_user \gset`, then under `\if :su`
  `SET log_statement = 'none'; SET log_min_error_statement = 'panic'; SET
  pg_stat_statements.track_utility = off;`, then `ALTER ROLE <role> PASSWORD '<verifier>';`.
  The SETs are superuser-only; the scripts are also documented for Azure/GCP admins, which are not
  superusers, so the SETs are conditional and the residual for them (the verifier under
  `log_statement = ddl|all`, on a refused statement, and in `pg_stat_statements` when loaded) is
  stated in the header.
- `node` missing → exit 1 naming the requirement. Role missing → exit ≠ 0, no OK line.
- DRY_RUN does not connect: it builds the verifier with iterations 4096 and prints the statement
  with the verifier redacted; `PRINT_ARGS_FILE` (test-only) refuses an existing path and records
  the statement with the verifier.
- Header usage becomes `printf '%s' "$PASSWORD" | …` or `< <(…)` (a here-string can be a temp
  file on bash < 5.1).

### C4 — initdb
- Each file that creates a LOGIN role with a password (`01`, `02`, `04`; derived by
  `grep -l PASSWORD infra/postgres/initdb/*.sql`) starts, outside any `\if`, with `SET
  log_statement = 'none'`, `SET log_min_error_statement = 'panic'`, `SET
  log_min_duration_statement = -1`, and `\set VERBOSITY terse` (psql's client-side `LINE n:`
  excerpt goes to the container's stderr). The initdb runs as the bootstrap superuser.
- Also `SET pg_stat_statements.track_utility = off` (a placeholder is accepted when the library
  is not loaded).
- `docker-compose.yml` forwards `PASSWD_ANCHOR_PUBLISHER_PASSWORD` to `db` as `${…:-}` (existing
  `.env` files lack it, so not `:?`). Compose passes an empty string for an unset variable, which
  `\getenv` defines, so `02` keeps the outer `\if :{?v}` (an undefined variable leaves `:'v'`
  unexpanded — a syntax error) and inside it branches on a non-empty value (`SELECT :'v' <> '' …
  \gset`); unset or empty → `NOLOGIN` with a `\warn`, as `01` does for jackson. The SETs precede
  that SELECT, which carries the password in its text. CI does
  not run initdb; its LOGIN comes from its own `ALTER ROLE` in `ci-integration.yml`.
- The new compose variable goes through the env-docs contract: `scripts/env-allowlist.ts` entry
  (consumers: compose, initdb, `set-audit-anchor-publisher-password.sh`), `npm run
  generate:env-example`, the `init:env` prompt, `check:env-docs` green.

### C5 — docs
- Every documented `\password` is preceded by `SET password_encryption = 'scram-sha-256'` (it
  follows the server's setting, and an md5 hash is password-equivalent under md5 auth) and `SET
  log_statement TO 'none'` / `log_min_error_statement TO 'panic'` (Jackson Step 2 included).
- `deployment.md`: production `passwd_app` snippet creates the role without a password, then
  `\password passwd_app` interactively (a tty prompt is what is wanted there); the anchor-publisher
  snippet becomes `ALTER ROLE … WITH LOGIN` plus the host value piped to `docker compose exec -T db
  psql … -c "SET password_encryption = 'scram-sha-256'" -c "SET log_statement TO 'none'" -c "SET
  log_min_error_statement TO 'panic'" -c "\password passwd_anchor_publisher"` (one session; `-T`:
  no tty, so stdin is read — executed at plan time); the "Existing dev volumes" paragraph says a fresh volume without the variable gets a
  `NOLOGIN` role, and `audit-db-grants` expects LOGIN, so set it.
- Upgrade note for every existing self-hosted volume: the anchor-publisher role was created LOGIN
  with the published `passwd_anchor_publisher_pass`; rotate it with
  `set-audit-anchor-publisher-password.sh`, or `ALTER ROLE passwd_anchor_publisher NOLOGIN` when the
  publisher is not run (then `audit-db-grants` reports `rolcanlogin` as a manifest mismatch — say
  so); after rotating, update `PASSWD_ANCHOR_PUBLISHER_PASSWORD` and
  `AUDIT_ANCHOR_PUBLISHER_DATABASE_URL` in `.env`. Check over a password path, `-h db` (the local
  socket and loopback are `trust` in the image): the old password must get `password
  authentication failed` (rotated) or `not permitted to log in` (NOLOGIN).
- `docs/setup/docker/en.md`: the rotation prose names all three scripts and the `\password`
  procedure for roles without one.
- "Prior password exposure" (`deployment.md`), `infra/terraform/README.md`, `docs/setup/aws/en.md`,
  bootstrap header: a refused statement now logs a verifier; earlier runs left cleartext in the log
  and in `pg_stat_statements`. Check from the `postgres` database (never `CREATE EXTENSION` in
  `passwd_sso`: its PUBLIC grants fail `audit-db-grants`), creating the extension there if absent,
  with `SELECT count(*) FROM pg_stat_statements WHERE query ILIKE '%PASSWORD%' AND query NOT ILIKE
  '%PASSWORD ''SCRAM-SHA-256$%' AND query NOT ILIKE '%PASSWORD ''md5%'` (a count, so the cleartext
  is not printed; verifier statements written after this change are excluded; whether the RDS
  master can create the extension in `postgres` and read other roles' text is unverified, E1); clear with `pg_stat_statements_reset()` (needs
  its EXECUTE grant; on RDS unverified, E1) and rotate when it cannot be cleared or snapshots exist;
  "logs expired" alone is no longer sufficient.
- What a verifier exposes (stated once, next to the Jackson note): not the password; enables an
  offline guess against ≥4096 PBKDF2 iterations of the password; with StoredKey and ServerKey an
  attacker who can pose as the server to a client that does not authenticate it (no `verify-full`,
  no `channel_binding=require`) obtains ClientKey from one exchange and logs in. The app on AWS
  uses `verify-full`; operator `psql` sessions and self-hosted non-TLS networks do not — rotate
  after a verifier leaks there.
- The non-ASCII refusal (C1) in the bootstrap header and `deployment.md`.
- `docs/setup/aws/en.md` names `bootstrap-rds-roles.mjs` as the rotation path on AWS (the image has
  no psql); `docs/setup/{azure,gcp}/en.md` keep the scripts and state the non-superuser residual.

## Testing strategy

- C1 unit `scripts/__tests__/scram-verifier.test.mjs`:
  - RFC 7677 §3 with the AuthMessage written as a literal
    (`n=user,r=rOprNGfwEbeRWgbNEkqO,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0`):
    HMAC(ServerKey, AuthMessage) = `6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=`; ClientProof
    `dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=` XOR HMAC(StoredKey, AuthMessage) hashes to
    StoredKey.
  - red proofs, one per half: ServerKey label altered → ServerSignature case red only; ClientKey
    stored unhashed → StoredKey case red only.
  - `resolveIterations`: NULL → 4096; 1000 → 4096; 10000 → 10000; 100001 → refused.
  - refusals (empty, non-ASCII) with the allow side (quotes, `$`, `\`, TAB); salt 16 bytes, keys
    32 bytes, two calls differ; CLI reads stdin verbatim (a trailing LF changes the verifier) and
    prints nothing on refusal.
- C2 integration (`bootstrap-rds-roles.integration.test.ts`):
  - cross-implementation: `SET scram_iterations = 10000`, set a cleartext password (also one with
    a TAB), assert `rolpassword` starts with `SCRAM-SHA-256$10000:`, recompute with the parsed salt
    → identical.
  - iterations followed: with `SET scram_iterations = 10000` the stored verifier says 10000; with
    1000 it says 4096. Red proofs: hard-coded 4096; `max` removed.
  - the recording client records text and params; with an alphanumeric sentinel, each of the
    three statements is seen once with `PASSWORD 'SCRAM-SHA-256$` (absent-role run and re-run as
    superuser; re-run as the non-superuser stand-in inside `inRolledBackTransaction`), and the
    sentinel appears in no text or params. Red proof: `escapeLiteral(password)` at each site.
  - existing login cases T2 (its `old-password → false` is the non-`trust` control) and T5 run
    through verifiers.
  - non-ASCII: spawn the CLI as the existing unreachable-URL case does, with the bad value in the
    last `PASSWD_*` variable → exit 1 and the refusal, no connection error; all-ASCII against the
    same URL reaches the connection error.
- C3, one test file parametrised over the three scripts (replacing the two per-script files);
  the fake psql (first on PATH) records argv, stdin and env per call and answers the
  `current_setting` call with a value the case chooses:
  - the ALTER call's stdin equals, exactly, the `\gset`/`\if` block with the three SETs followed by
    `ALTER ROLE <role> PASSWORD '<v>'`, where `<v>` recomputes from the sentinel with its parsed
    salt; its argv carries `-v ON_ERROR_STOP=1`. Red proofs: drop one SET; hard-code 4096.
  - iterations: fake answers `10000` → `SCRAM-SHA-256$10000:`; empty → 4096; `1000` → 4096.
  - the sentinel is absent from argv, env, stdout and stderr, including under `bash -x`.
  - trailing LF: input `sentinel\n` → `<v>` recomputes from `sentinel`. Interior LF, CR, empty,
    non-ASCII → exit ≠ 0 and no ALTER call (paired with the allow case that has one).
  - a `node` stub printing `x';DROP ROLE y;--`, and one printing nothing → exit ≠ 0, no ALTER call,
    no OK line; `node` absent from PATH → exit 1 naming it.
  - DRY_RUN prints no verifier and makes no psql call; `PRINT_ARGS_FILE` holds a verifier that
    recomputes from the input; an existing `PRINT_ARGS_FILE` path is refused.
  - `psql-safe.test.mjs`'s fake answers `4096` to the iteration query and the case asserts two
    calls for each set-* script, both with `-X` and the passfile.
- C3 replay against real psql (integration): the stdin the fake psql recorded, with the role
  name replaced by a probe role, is fed to real psql once as the superuser and once as the existing
  NOSUPERUSER CREATEROLE stand-in (given LOGIN and a password in the test); each asserts exit 0,
  `rolpassword` equals the recorded verifier, the sentinel logs in over scram and a wrong password
  gets `28P01`. No real role is touched. psql: the host binary (pinned in CI), else `docker compose
  exec -T db psql`, after asserting both connections report the same `system_identifier`. Red
  proof: `\if :su` → `\if true` turns the stand-in case red.
- refusals print the reason only: with the sentinel as the refused value, C1 CLI (empty,
  non-ASCII, bad iterations), the C2 non-ASCII spawn and the C3 LF/CR/non-ASCII refusals assert
  the sentinel is absent from stdout and stderr; `resolveIterations` refuses `"abc"`, `" 4096"`,
  `"-1"`.
- C4: a unit test derives the file set (`PASSWORD` in `infra/postgres/initdb/*.sql`) and pins it
  (`01`, `02`, `04`); asserts `SET log_statement`, `log_min_error_statement`,
  `log_min_duration_statement`, `pg_stat_statements.track_utility` and `\set VERBOSITY terse` are
  top-level statements (not in a comment, not inside `\if`), before the first statement that
  interpolates a password variable (`:'…password…'`), with no `\c`, `RESET` or re-`SET` between;
  red-proven on fixtures (missing, after the `SELECT :'v'`, inside `\if`, commented out). Plus a
  one-shot check recorded in the deviation log: a throwaway `postgres:16-alpine -c
  log_statement=all` with this initdb directory, a sentinel `PASSWD_APP_PASSWORD`, and a fixture
  file that sends a deliberately refused role statement with a sentinel after the SETs: neither
  the server log nor the entrypoint's stderr carries a sentinel (red without the SETs). Run three
  times for `PASSWD_ANCHOR_PUBLISHER_PASSWORD`: unset → init succeeds, role `NOLOGIN`; empty →
  `NOLOGIN`; a sentinel → `LOGIN`, the sentinel logs in, no log carries it.
- C2 integration isolation: `SET scram_iterations` cases run inside a transaction with `SET
  LOCAL`. `resolveIterations` unit cases add `"100000"` (accepted) and `"10000"` as text.
- C5: every documented command is run once and recorded.

## Considerations & constraints

- SC1 — CI workflow role statements: per-run values, throwaway containers.
- SC2 — `SET log_statement` on RDS for bootstrap: not verifiable (E1); residual: the verifier under
  `log_statement = ddl|all` and in `pg_stat_statements`, stated in C5.

## User operation scenarios

- RDS bootstrap re-run with a rotated `PASSWD_APP_PASSWORD`: a refused statement logs a verifier.
- Self-hosted rotation from a terminal: `scripts/set-outbox-worker-password.sh < <(openssl rand
  -hex 32)` installs that value (no tty prompt), and the worker connects with it.
- Fresh self-hosted volume: the db container log carries no role statement text; without
  `PASSWD_ANCHOR_PUBLISHER_PASSWORD` the publisher role is `NOLOGIN`.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | SCRAM verifier helper | pending |
| C2 | bootstrap-rds-roles sends verifiers | pending |
| C3 | set-*-password.sh send a verifier | pending |
| C4 | initdb: logging off, no published LOGIN password | pending |
| C5 | docs | pending |
