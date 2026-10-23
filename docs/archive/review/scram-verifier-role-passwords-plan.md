# Plan: scram-verifier-role-passwords

Issue: `#941`. Branch `feat/scram-verifier-role-passwords`, base `origin/main` 3383b3fcb.
Revision 2 — after plan-review round 1 (`scram-verifier-role-passwords-review.md`). Split out of
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
- CLI: `node scripts/lib/scram-verifier.mjs --iterations <n>` reads the password from stdin
  verbatim (no stripping) and prints the verifier; exit 1 with no output on refusal.

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
  with `$(cat)` (strips trailing newlines, so `<<<` and `openssl rand` output work); refuses
  empty, an interior LF or any CR, non-ASCII; reads `current_setting('scram_iterations', true)`
  with one psql call; builds the verifier with `printf '%s' "$pw" | node
  "$SCRIPT_DIR/lib/scram-verifier.mjs" --iterations "$n"`; checks it against
  `^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$`; sends on stdin with
  `-v ON_ERROR_STOP=1`: `SET log_statement = 'none'; SET log_min_error_statement = 'panic'; ALTER
  ROLE <role> PASSWORD '<verifier>';`. The scripts require a superuser URL, which may set both.
- `node` missing → exit 1 naming the requirement. Role missing → exit ≠ 0, no OK line.
- DRY_RUN computes the verifier (so it exercises the live path) and prints the statement with the
  verifier redacted; `PRINT_ARGS_FILE` records the statement with the verifier.

### C4 — initdb
- Each file that creates a LOGIN role with a password (`01`, `02`, `04`; derived by
  `grep -l PASSWORD infra/postgres/initdb/*.sql`) starts, outside any `\if`, with `SET
  log_statement = 'none'`, `SET log_min_error_statement = 'panic'`, `SET
  log_min_duration_statement = -1`, and `\set VERBOSITY terse` (psql's client-side `LINE n:`
  excerpt goes to the container's stderr). The initdb runs as the bootstrap superuser.
- `docker-compose.yml` forwards `PASSWD_ANCHOR_PUBLISHER_PASSWORD` to `db` without `:?` (existing
  `.env` files lack it); `02`'s fallback becomes `NOLOGIN` with a `\warn`, as `01` does for
  jackson. The CI workflow sets the variable, so CI keeps a LOGIN role.

### C5 — docs
- `deployment.md`: production `passwd_app` snippet creates the role without a password, then
  `\password passwd_app` interactively (a tty prompt is what is wanted there); the anchor-publisher
  snippet becomes `ALTER ROLE … WITH LOGIN` plus the host value piped to `docker compose exec -T db
  psql … -c "SET log_statement TO 'none'" -c "\password passwd_anchor_publisher"` (`-T`: no tty, so
  stdin is read — executed at plan time, see testing).
- `docs/setup/docker/en.md`: the rotation prose names all three scripts and the `\password`
  procedure for roles without one.
- "Prior password exposure" (`deployment.md`), `infra/terraform/README.md`, `docs/setup/aws/en.md`,
  bootstrap header: a refused statement now logs a verifier; earlier runs left cleartext in the log
  and in `pg_stat_statements` — check with `SELECT query FROM pg_stat_statements WHERE query ILIKE
  '%PASSWORD%'`, clear with `pg_stat_statements_reset()`, and rotate when snapshots exist; "logs
  expired" alone is no longer sufficient.
- What a verifier exposes (stated once, next to the Jackson note): not the password; enables an
  offline guess against ≥4096 PBKDF2 iterations of the password; with StoredKey and ServerKey an
  attacker who can pose as the server to a client that does not authenticate it (no `verify-full`,
  no `channel_binding=require`) obtains ClientKey from one exchange and logs in. The app on AWS
  uses `verify-full`; operator `psql` sessions and self-hosted non-TLS networks do not — rotate
  after a verifier leaks there.
- The non-ASCII refusal (C1) in the bootstrap header and `deployment.md`.

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
- C3, one test file parametrised over the three scripts (replacing the two per-script files):
  - fake psql (PATH) records argv, stdin and env; the password is a sentinel; assert it is absent
    from argv, env, stdout, stderr — including under `bash -x` — while stdin carries the verifier
    (positive control: the verifier recomputed from the sentinel with its parsed salt).
  - trailing LF accepted; interior LF, CR, empty, non-ASCII refused with the fake-psql log absent
    (paired with an allow case where it is present).
  - DRY_RUN prints no verifier; `PRINT_ARGS_FILE` holds one that recomputes from the input.
  - `psql-safe.test.mjs`'s live-branch fake records stdin; its existing argv-URL assertion stays.
- C3 live integration, one case per script: a probe role renamed per run is not possible (role
  names are fixed), so each case runs the real script against the dev/CI DB on its real role inside
  a save/restore of `rolpassword` (read before, `ALTER ROLE … PASSWORD '<saved verifier>'` after),
  then logs in over scram with the new password (and fails with a wrong one). psql: host binary if
  present, else a PATH shim forwarding to `docker compose exec -T db psql`; CI pins the host binary
  (`expect` env, as `backup-db.test.mjs` Group B does) so it fails rather than skips.
- C4: a unit test derives the file set (`PASSWORD` in `infra/postgres/initdb/*.sql`), asserts the
  three `SET`s and `\set VERBOSITY terse` are top-level, before the first role statement, with no
  `\c`, `RESET` or re-`SET` between; red-proven on fixtures. Plus a one-shot check recorded in the
  deviation log: a throwaway `postgres:16-alpine -c log_statement=all` with this initdb directory
  and a sentinel `PASSWD_APP_PASSWORD`; the container log has no sentinel (red without the SETs).
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
