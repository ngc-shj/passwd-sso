# Plan: scram-verifier-role-passwords

Issue: `#941`. Branch `feat/scram-verifier-role-passwords`, base `origin/main` 3383b3fcb.
Revision 1. Split out of `aws-anchor-publisher-and-scram-verifier` after its round-1 review
(`aws-anchor-publisher-and-scram-verifier-review.md`); the findings listed there under "moved to
the #941 plan" are addressed here.

## Project context

- Type: `mixed` (operator scripts, initdb SQL, docs). Tests: unit + real-PostgreSQL integration + CI.
- Verification environment constraints:
  - E1 — no RDS. Everything is verified on local PostgreSQL 16, whose verifier handling is the
    server's own (`encrypt_password` stores a recognised SCRAM secret unchanged under any
    `password_encryption`), not an RDS feature. Whether the RDS master may `SET log_statement`
    is not verifiable; the plan does not depend on it.

## Objective

A role password must not reach a PostgreSQL log in cleartext. Today a refused `CREATE/ALTER ROLE
… PASSWORD '<cleartext>'` is logged in full under the default `log_min_error_statement = error`,
and every such statement is logged under `log_statement = ddl|all`.

## Member set (R42)

Derived by
`git grep -nE "(CREATE|ALTER) (ROLE|USER)[^;]*PASSWORD|\\\\password|PASSWORD[[:space:]]+(:'|\\$\\{|\\$[a-z]|')" -- scripts infra .github docs src ':!docs/archive' ':!*.test.*'`:

| Member | Credential | Disposition |
|--------|-----------|-------------|
| `scripts/bootstrap-rds-roles.mjs` — CREATE, superuser ALTER, non-superuser ALTER (`convergeRole`) | operator secrets on RDS | C2: send a verifier |
| `scripts/set-{outbox-worker,retention-gc-worker,audit-anchor-publisher}-password.sh` | operator secrets | C3: `\password` |
| `infra/postgres/initdb/01`, `02` (×3), `04` — the `\getenv` branches | operator secrets (`docker-compose.yml` forwards `PASSWD_*_PASSWORD` with `:?`) | C4: logging off for the session |
| same files, `else` fallback branches | fixed dev values | covered by C4 too (same session) |
| `docs/operations/deployment.md` — production `CREATE ROLE passwd_app … PASSWORD '<strong-password>'`; `ALTER ROLE passwd_anchor_publisher … PASSWORD :'pw'` | operator secrets | C5: `\password` |
| `.github/workflows/ci-integration.yml`, `ci.yml` | per-run CI values on a throwaway service container | out of class (SC1) |

## Contracts

### C1 — SCRAM verifier helper
- `scripts/lib/scram-verifier.mjs` exports `scramSha256Verifier(password, { iterations, salt? })`
  → `SCRAM-SHA-256$<iter>:<b64 salt>$<b64 StoredKey>:<b64 ServerKey>` (the `pg_authid.rolpassword`
  format). Built from `node:crypto` `pbkdf2Sync` (SHA-256), `createHmac`, `createHash` per
  RFC 5802 §3; no new primitive. Salt: `randomBytes(16)` unless `salt` is passed (tests only — no
  caller reads it from env or argv). `iterations` is required, an integer ≥ 4096.
- Refuses an empty password and any non-ASCII character. For ASCII the server's SASLprep either
  returns the input unchanged or fails and falls back to the raw bytes, so the raw bytes are what
  login compares; for non-ASCII, node-postgres sends raw bytes while a verifier must be derived
  from the prepped form — refusing is the only choice that cannot store an unusable verifier.
- No CLI, not imported under `src/`.

### C2 — bootstrap-rds-roles sends verifiers
- `convergeRole`'s three statements send `PASSWORD ${escapeLiteral(verifier)}`; the cleartext is
  never interpolated.
- Iterations: `max(4096, SHOW scram_iterations)` on the same connection (the GUC exists from
  PostgreSQL 16; SQLSTATE `42704` → 4096), so the verifier is not weaker than the server would
  make itself.
- A non-ASCII or empty `PASSWD_*_PASSWORD` fails before any statement is sent.
- The image already ships `scripts/lib/`; `scripts/checks/check-runtime-image-assets.mjs` derives
  the runtime assets from imports, so a missing `COPY` for the new file fails that gate.
- Forbidden pattern: `escapeLiteral\(password\)` in `scripts/bootstrap-rds-roles.mjs` — reason:
  cleartext reaching the statement.

### C3 — set-*-password.sh use `\password`
- Each script runs `psql … -c "\password <role>"` with the password fed twice on stdin
  (`printf '%s\n%s\n'`), the pattern `deployment.md` documents for `jackson_user`: libpq computes
  the verifier client-side with the server's `scram_iterations`, and the scripts need no node.
- The password is read with xtrace off (`bash -x` would print it) and is passed only on stdin,
  never in argv or the environment of a child.
- A password containing a newline or CR is refused (`\password` reads one line).
- DRY_RUN prints the command with no password, and `PRINT_ARGS_FILE` records the psql argv and
  the role — no statement carrying a secret exists to record any more.
- Residual: `\password` issues `ALTER USER … PASSWORD 'SCRAM-SHA-256$…'`, so under
  `log_statement = ddl|all` the verifier is logged. The scripts do not `SET log_statement`: on a
  non-superuser connection that SET itself fails. Stated in each script header.

### C4 — initdb sessions do not log role statements
- Each initdb file that creates a role sets, before the first such statement,
  `SET log_statement = 'none'` and `SET log_min_error_statement = 'panic'` (session-scoped; the
  initdb runs as the bootstrap superuser, which may set both). Neither a refused nor a successful
  statement is then logged with its text. The cleartext still crosses the container-local socket;
  nothing records it.
- The `jackson_user` file (`01`) is included: it carries `PASSWD_JACKSON_PASSWORD`.

### C5 — docs
- `deployment.md`: the production role snippet creates the role without a password and sets it
  with `\password passwd_app`; the anchor-publisher snippet uses the Jackson pattern.
- `bootstrap-rds-roles.mjs` header, `infra/terraform/README.md` (escapeLiteral and "password
  included" text), `deployment.md` "Prior password exposure": state that a refused statement now
  logs a verifier; keep the rotation guidance for runs made before this change.
- What a logged verifier exposes, stated once (`deployment.md`, next to the Jackson note): it is
  not the password; with it an attacker can brute-force the password offline (4096+ PBKDF2
  iterations), impersonate the server to a client, or, given one captured unencrypted SCRAM
  exchange, recover ClientKey and log in. RDS enforces TLS and the app uses `verify-full`, so the
  last needs network position on a non-TLS self-hosted setup; rotate after a log leak there.

## Testing strategy

- C1 unit `scripts/__tests__/scram-verifier.test.mjs`:
  - RFC 7677 §3 (`user`/`pencil`, salt `W22ZaJ0SNY7soEsUEjb6gQ==`, 4096): rebuild the AuthMessage
    from the RFC's exchange; HMAC(ServerKey, AuthMessage) equals the RFC's ServerSignature
    `6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=`; ClientKey = ClientProof
    (`dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=`) XOR HMAC(StoredKey, AuthMessage) and
    H(ClientKey) equals StoredKey — the server's own check, covering both halves.
  - red proofs: swap the "Client Key"/"Server Key" labels; store ClientKey instead of H(ClientKey);
    each turns a different assertion red.
  - format and salt: 16-byte salt, 32-byte keys, two calls differ; empty, non-ASCII and
    `iterations < 4096` refused (allow side: an ASCII password with quotes, `$`, `\` succeeds).
- C1/C2 integration (`bootstrap-rds-roles.integration.test.ts`, superuser, probe roles dropped by
  the existing hooks):
  - cross-implementation: set a cleartext password, assert `rolpassword` starts with
    `SCRAM-SHA-256$`, parse salt and iterations, recompute with the helper → identical string.
  - the existing login cases (T2 rotated password — whose `old-password → false` is the control
    that the connection is not `trust` — and T5 quote/backslash/semicolon) now run through
    verifiers, so a wrong verifier fails login.
  - no cleartext sent: with an alphanumeric sentinel password, the recording client sees exactly
    one `CREATE ROLE … PASSWORD 'SCRAM-SHA-256$` on the absent-role run and one `ALTER ROLE …
    PASSWORD 'SCRAM-SHA-256$` on the re-run (positive control), and the sentinel appears in no
    recorded text or params. Red proof: revert to `escapeLiteral(password)`.
  - non-ASCII `PASSWD_*_PASSWORD` → refused before any statement is recorded; ASCII proceeds.
- C3:
  - `psql-safe.test.mjs`'s fake psql records argv and stdin; for all three scripts assert the
    argv carries `\password <role>` and no password, and stdin is the password twice.
  - `set-retention-gc-worker-password.test.mjs` added (it does not exist); the outbox and anchor
    tests' assertions on the old statement text are rewritten for the new DRY_RUN output.
  - live login: not automated — the host running vitest has no `psql`, so a live case would be
    skipped locally and could pass vacuously. Executed once at plan time on the dev DB instead:
    a probe role given `\password` from piped stdin (password `It's$ok;\x`) stores
    `SCRAM-SHA-256$4096:…`, and over the published port (scram, not the container's `trust`
    loopback) the password logs in and a wrong one gets `28P01`; probe role dropped.
  - a newline in the password → exit ≠ 0, psql not invoked.
- C4: a unit test parses each initdb file that creates a role and asserts both `SET`s precede the
  first role statement. Prose-level guard only (it proves the order of the text, not the server's
  behaviour); the server behaviour is PostgreSQL's documented meaning of the two settings.
- C5: every documented command is run (feedback: run every command you document).

## Considerations & constraints

- SC1 — CI workflow role statements: per-run values on throwaway containers; no persistent log.
- SC2 — `SET log_statement` on RDS for bootstrap: not verifiable (E1); the residual is the
  verifier under `log_statement = ddl|all`, stated in C5.

## User operation scenarios

- RDS bootstrap re-run with a rotated `PASSWD_APP_PASSWORD`: the master is refused nothing new;
  if a statement is refused, the log shows a verifier.
- Self-hosted rotation: `scripts/set-outbox-worker-password.sh < <(openssl rand -hex 32)`; the app
  connects with the new password.
- Fresh self-hosted volume: initdb creates the roles; the db container log shows no role
  statement text.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | SCRAM verifier helper | pending |
| C2 | bootstrap-rds-roles sends verifiers | pending |
| C3 | set-*-password.sh use `\password` | pending |
| C4 | initdb sessions do not log role statements | pending |
| C5 | docs | pending |
