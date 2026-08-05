# Plan: db-backup-script

Add `scripts/backup-db.sh` — a take-only `pg_dump` backup script for the
self-hosted / Docker Compose deployment — plus its documentation and a self-test.

**Revision 2.** Round-1 review returned 31 merged findings (5 Critical). They shared
three roots, and this revision is organised against those roots rather than against
the individual findings:

1. **Predicates were adjudicated by the wrong authority.** Every decision now names
   the interpreter that defines its meaning, and delegates to it (R47, R51).
2. **Controls were declared stronger than their mechanisms.** Every control class is
   restated at the strength its mechanism actually delivers, and the forbidden-pattern
   blocks now have a runner (C9) instead of being prose (R49).
3. **The verification story was written before checking the environment.** The host
   has no Postgres client at all; `pg_restore` is reachable only inside the container
   that C9 stubs. Verification is redesigned around what is actually present (R50).

## Project context

- **Type**: CLI tool (operator bash script) inside a web-app repo
- **Test infrastructure**: unit + integration + E2E + CI. Re-derived:
  `vitest.config.ts:11-12` includes `scripts/__tests__/**/*.test.mjs` in the default
  project; `.github/workflows/ci.yml`'s `app:` path filter includes `scripts/**` and
  the app job runs `npm run test:coverage`; `scripts/pre-pr.sh:36` mirrors the same
  filter. A test placed at `scripts/__tests__/backup-db.test.mjs` therefore runs both
  locally and in CI without new wiring.
- **Verification environment constraints**:
  - `VE1` — **No RDS instance is reachable.** URL mode cannot be exercised against a
    managed Postgres. Classification: `blocked-deferred`. Anti-Deferral
    cost-justification: provisioning a paid RDS instance plus a VPC path to test a
    mode whose *post-connection* behaviour is shared code is not proportionate. The
    substitute is a real run against the local Compose database reached over TCP by
    URL, which exercises the same argument construction, the same TLS floor
    negotiation, and the same validation path. Residual risk, stated correctly this
    time: the RDS-specific failures are (a) a `db_name` that differs from the default
    target set, (b) the absence of a `jackson` database on the managed instance, and
    (c) client/server version skew. (a) and (b) are addressed by making the target
    set configurable (C3); (c) fails loudly by C5.
  - `VE2` — Compose mode is `verifiable-local`.
  - `VE3` — **CI has no Postgres server AND no Postgres client.** Re-derived:
    `command -v pg_dump pg_restore psql` → all NOT_FOUND on the developer host, and
    `grep -rn 'postgresql-client\|apt-get install' .github/workflows/` returns
    nothing. This is the constraint that reshaped C5 and C9; the round-1 wording
    conflated "no server" with "no client".

### Gate coverage (derived, corrected in revision 2)

Round 1's table was assembled by naming three gates and concluding none applied.
That is an enumeration, not a derivation, and it was wrong. Derived instead by asking
which gates scan `*.sh` under `scripts/`:

```bash
grep -rln "find .*-name '\*\.sh'" scripts/checks/
grep -n 'SCAN_DIR=\|find "\$SCAN_DIR"' scripts/checks/check-no-pipe-into-grep-q.sh
grep -n 'no-pipe-into-grep-q' scripts/pre-pr.sh
```

| Gate | Scan root | Extensions | Covers `scripts/backup-db.sh`? |
|---|---|---|---|
| `check-no-pipe-into-grep-q.sh` (`SCAN_DIR="scripts"`, `find … -name '*.sh'`) | `scripts/**` | `.sh` | **Yes** — and `pre-pr.sh:345` runs it |
| `check-cli-shell-safety.mjs` | `cli/src`, `src` | ts-morph sources | No |
| `check-operator-echo-escaped.mjs` | `scripts/**` | `.ts`, `.tsx`, `.mjs` | No |
| `check-gate-selftest-coverage.sh` | `scripts/checks/` only | — | No — nothing notices if `backup-db.test.mjs` is later deleted |
| `check-test-hygiene.sh` | filters `\.test\.(ts\|tsx)$` | — | No — a `.test.mjs` self-test is outside the hygiene gates |
| `shellcheck` | — | — | Not present anywhere (`grep -n shellcheck scripts/pre-pr.sh .github/workflows/*.yml` → no match) |

Two consequences drive the design:

- **`| grep -q` is forbidden in this script.** `check-no-pipe-into-grep-q.sh` reds it,
  and the reason (`pre-pr.sh:53-56`) is a real SIGPIPE/`pipefail` inversion that can
  make a successful check read as failure. Every predicate in C2 and C5 is therefore
  decided by capturing output into a variable and testing the variable.
- **Nothing scans this script for the plan's own forbidden patterns.** C9 supplies
  that runner; the patterns are not self-enforcing prose.

## Objective

Give the self-hosted deployment a repeatable, verified database backup. `git grep
pg_dump` matches documentation only: `docs/operations/backup-recovery/` is AWS-only
(RDS snapshots, PITR, Backup Vault Lock) and `docs/operations/incident-runbook.md:56`
carries a single bare `pg_dump` line inside a breach-response procedure. The commands
used during the gx10-a9c0 → mrx33 host migration in this session were typed by hand.

## Requirements

1. Dump every database in the configured target set, plus cluster globals, in
   PostgreSQL custom format (`-Fc`) / plain SQL for globals.
2. Work against a Compose `db` service **and** against a direct connection URL.
3. Write each run to its own timestamped directory, atomically published.
4. Verify each produced archive is readable by the same reader that will restore it,
   before reporting success.
5. Prune old generations down to a caller-specified retention count, without ever
   endangering the run just taken.
6. A failure must never be reportable as success, and a success must never be
   reportable as failure on a path where the operator loses an archive.
7. Database credentials must not reach `argv`, the trace stream, `MANIFEST`, or any
   child process that does not need them.
8. Dumps are plaintext secrets at rest; the destination's mode, owner and filesystem
   are verified before anything is written, and an accidental commit or image build
   must not carry them.
9. Take-only. The script never restores, drops, or writes to a database.

## Technical approach

**Language: bash.** Matches the sibling operator scripts (`purge-audit-logs.sh`,
`purge-history.sh`, `rotate-master-key.sh`, `set-outbox-worker-password.sh`), and the
work is process orchestration rather than SQL. The `.mjs` alternative
(`audit-db-grants.mjs`, `bootstrap-rds-roles.mjs`) is rejected because those connect
through the `pg` driver and issue SQL; it would also not buy meaningful gate coverage
(`check-operator-echo-escaped.mjs` is about escaping operator display text, which this
script does not produce).

**Portability floor.** The primary operator host for this script is macOS (the
motivating migration is Linux → Mac). `grep -rn 'stat -c\|readlink -f\|mapfile\|readarray'
scripts/*.sh` returns no matches, so no in-repo precedent establishes GNU coreutils on
the operator host, and macOS `/bin/bash` is 3.2. The script therefore uses no
`mapfile`/`readarray`, no associative arrays, no `stat -c`, and no `readlink -f`;
mode and path resolution go through small `uname -s`-branching helpers, and a
preflight rejects `BASH_VERSINFO[0] -lt 3` with a named error.

**No concurrency primitive against the database**, so the plan-stage real-DB isolation
probe does not apply — `pg_dump` manages its own snapshot. Concurrency *between runs*
is a separate matter and is handled by C4's lock.

## Contracts

### C1 — CLI surface, environment contract, and error identity

Invocation: `scripts/backup-db.sh` (no positional arguments).

| Variable | Required | Default | Validation |
|---|---|---|---|
| `BACKUP_DIR` | no | `${HOME}/passwd-sso-backups` | absolute (`^/`), no newline, no leading `-` |
| `BACKUP_RETAIN` | no | `7` | `^[1-9][0-9]*$` |
| `BACKUP_DATABASES` | no | `passwd_sso jackson` | space-separated, each `^[A-Za-z_][A-Za-z0-9_$]*$` |
| `BACKUP_DRY_RUN` | no | `false` | exactly `true` or `false` |
| `BACKUP_ALLOW_IN_REPO` | no | `false` | exactly `true` or `false` |
| `BACKUP_TLS_MODE` | no | `verify-full` | one of `verify-full`, `verify-ca`, `require` |
| `MIGRATION_DATABASE_URL` | no | unset | see C7 |
| `COMPOSE_DB_SERVICE` | no | `db` | `^[A-Za-z_][A-Za-z0-9_-]*$` |
| `COMPOSE_DB_SUPERUSER` | no | `passwd_user` | `^[A-Za-z_][A-Za-z0-9_-]*$` |

Exit codes: `0` success; `1` every failure. Because one exit code cannot identify a
cause, **every failure path emits a stable, greppable identifier on stderr** in the
form `BACKUP_ERR:<CODE> <human message>`. The repo already uses this shape in its own
gates (`FORBIDDEN:`, `ENV_POLLUTION_GUARD:`, `MISSING_GATE_SELFTEST:`, `EMPTY_SCAN:`).
Codes are a closed set declared in one place in the script: `BAD_ENV`, `BAD_URL`,
`NO_DOCKER`, `NO_COMPOSE_FILE`, `DB_NOT_RUNNING`, `NO_CLIENT`, `DEST_UNSAFE`,
`DEST_IN_REPO`, `LOCKED`, `DUMP_FAILED`, `VALIDATE_FAILED`, `PRUNE_ABORTED`,
`RUN_VANISHED`, `OLD_BASH`.

**Invariants**

- `INV-C1a` (app-enforced): every variable in the table is validated against its
  anchored pattern before any process is spawned. The member set is the table itself;
  C9 re-derives it from the table and fails if a variable reaches a sink without a
  validation branch. Round 1 found this invariant claimed universality with a member
  set of one.
- `INV-C1b` (app-enforced): `set -euo pipefail`, and no predicate is decided by a
  pipeline into `grep -q` (see Gate coverage). Output is captured, then tested.
- `INV-C1c` (app-enforced): every failure exits 1 **and** prints exactly one
  `BACKUP_ERR:<CODE>` line. No code is emitted from more than one place.
- `INV-C1d` (app-enforced): every interpolation into a command that parses options
  (`docker`, `mkdir`, `rm`, `stat`, `pg_dump`) is preceded by `--` where the command
  supports it.

**Control class**: fail-closed verification gate. Adjudication authority: bash's
`[[ =~ ]]` over the literal environment values, then C9's source scan for the
`--` terminators and the `grep -q` prohibition.

**Forbidden patterns**

- `pattern: ^\s*set -e\s*$` — reason: must be the full `set -euo pipefail`.
- `pattern: \| *grep -q` — reason: forbidden by `check-no-pipe-into-grep-q.sh`, and the SIGPIPE inversion it guards is real.
- `pattern: rm +-rf +"?\$\{?BACKUP_DIR\}?"? *$` — reason: the root itself is never a removal target. Anchored to end-of-argument so it does **not** match C6's correct `rm -rf -- "$name"` form; round 1's version matched its own fix.

**Acceptance criteria**

- `BACKUP_RETAIN=0` → exit 1 with `BACKUP_ERR:BAD_ENV`, nothing written.
- `COMPOSE_DB_SERVICE='-e'` → exit 1 with `BACKUP_ERR:BAD_ENV` before any `docker` spawn.
- A valid environment reaches the destination check (paired allow case: the same
  assertion harness observes no `BACKUP_ERR:BAD_ENV`).

### C2 — Connection mode selection

- `MIGRATION_DATABASE_URL` set and non-empty → **URL mode**: `pg_dump` runs on the
  host.
- otherwise → **Compose mode**: `docker compose exec -T -- "$COMPOSE_DB_SERVICE"
  pg_dump …`, archive streamed to the host over stdout.

**Invariants**

- `INV-C2a` (app-enforced): the modes are mutually exclusive, and the selected mode
  plus the sanitised target (Compose project + service, or `PGUSER@PGHOST:PGPORT`) is
  logged before the first dump. Never the URL (C7).
- `INV-C2b` (app-enforced): three distinct preflight failures with distinct codes —
  `NO_DOCKER` (`command -v docker` fails), `NO_COMPOSE_FILE` (compose reports no
  configuration; message names the working directory, the failure hit in this
  session's migration), `DB_NOT_RUNNING`.
- `INV-C2c` (app-enforced): "is the service running" is decided by capturing
  `docker compose ps --status running --quiet -- "$COMPOSE_DB_SERVICE"` into a
  variable and testing `[[ -n "$ids" ]]`. Round 1 established that this command's
  **exit status is 0 for a stopped service**, so exit status cannot adjudicate this
  predicate; and `| grep -q` is forbidden by the gate.

**Control class**: fail-closed verification gate. Adjudication authority: the
*content* of `docker compose ps --quiet`, not its exit status.

**Acceptance criteria**

- URL mode spawns no `docker` (stub records invocations; assertion is on the empty
  record, paired with Compose mode's non-empty record).
- Run with no compose file → exit 1, `BACKUP_ERR:NO_COMPOSE_FILE`, message contains
  the working directory, no run directory created.
- Stub `docker compose ps --quiet` returning empty → `BACKUP_ERR:DB_NOT_RUNNING`;
  returning an id → proceeds (paired allow case).

### C3 — Target set

Targets: the databases in `BACKUP_DATABASES` (default `passwd_sso jackson`), **plus
cluster globals**.

Globals are dumped with `pg_dumpall --globals-only --no-role-passwords` to
`globals.sql`. Rationale, and why round 1 was wrong to omit them: `pg_dump -Fc <db>`
carries neither role definitions nor database-level ACLs. This deployment's security
posture lives substantially there — the `NOSUPERUSER NOBYPASSRLS` attributes of
`passwd_app`/`jackson_user`/`passwd_outbox_worker`/`passwd_retention_gc_worker`
(`infra/postgres/initdb/02-create-app-role.sql` et al.), and
`prisma/migrations/20260611011121_revoke_public_connect_on_app_db/migration.sql`'s
`REVOKE CONNECT ON DATABASE`. Without globals the restore errors on missing roles, and
the operator's escape from that error is `pg_restore --no-owner --no-acl`, which
discards `20260522000200_audit_log_revoke_via_definer`'s audit-log immutability REVOKE
— a control two recent commits exist to protect. `--no-role-passwords` is deliberate:
the passwords come from `.env` at initdb time, so the hashes add exposure without
adding restorability.

**Invariants**

- `INV-C3a` (app-enforced, universally quantified): every member of
  `{BACKUP_DATABASES} ∪ {globals}` is dumped and validated; a failure on any member
  fails the whole run. Member-set derivation for the **default**:

  ```bash
  grep -rn 'POSTGRES_DB:\|CREATE DATABASE\|postgres\(ql\)\?://[^ ]*/[a-z_]*' \
    docker-compose*.yml infra/postgres/initdb/*.sql
  ```

  Current members: `passwd_sso` (`docker-compose.yml:41`, `POSTGRES_DB`) and `jackson`
  (`infra/postgres/initdb/01-create-jackson-db.sql:21`, and independently
  `docker-compose.yml:68`'s `DB_URL: …/jackson`). The URL spelling is included in the
  derivation because a future service could name a database only that way. C9 re-runs
  this derivation and asserts **set equality** with the script's default, so a third
  Compose database reds the test rather than going un-backed-up.
- `INV-C3b` (app-enforced): the default is a *default*, not a hard-coding. Round 1
  established `infra/terraform/variables.tf:155` makes `db_name` a variable and that
  nothing in the repo creates a `jackson` database on RDS, so a hard-coded pair fails
  by construction on a managed instance.
- `INV-C3c` (app-enforced): a target that does not exist or cannot be connected to
  fails with `BACKUP_ERR:DUMP_FAILED` naming the database, distinguishable from a
  transport failure.

**Acceptance criteria**

- A successful run's directory contains exactly
  `{passwd_sso.dump, jackson.dump, globals.sql, MANIFEST}` — the set, not "exactly two
  files" (round 1's form contradicted C4's own layout).
- The derivation re-run in C9 equals the script default.
- A stubbed `pg_dump` failure on the second target → exit 1, `DUMP_FAILED`, and no
  published generation (C4).

### C4 — Destination safety, layout, and atomic publication

```
$BACKUP_DIR/                       verified 0700, owner == EUID, not a symlink
  20260803T164500Z.partial/        work in progress — cannot match C6's pattern
  20260803T164500Z/                published only after C5 passes for every target
    passwd_sso.dump                0600
    jackson.dump                   0600
    globals.sql                    0600
    MANIFEST                       0600
  20260803T160000Z.FAILED/         retained for diagnosis, pruned separately
  .lock                            flock target
```

`MANIFEST` fields are a **closed allowlist** (C7): script version marker, UTC
timestamp, `hostname` (`uname -n`), connection mode, sanitised target, per-member byte
size and non-comment TOC entry count, `pg_dump` version, `pg_restore` version and the
site it ran at. No other field may be written; nothing derived from
`MIGRATION_DATABASE_URL` beyond the sanitised `PGUSER@PGHOST:PGPORT` form.

**Invariants**

- `INV-C4a` (app-enforced): **before anything is written**, `$BACKUP_DIR` is resolved
  and verified: it is a real directory, not a symlink, `st_uid == EUID`, and
  `mode & 0077 == 0`. Failure → `BACKUP_ERR:DEST_UNSAFE` naming the offending
  property. Round 1 established that `umask` governs only *newly created* inodes, so
  from the second run onward — when the root always already exists — `umask` verifies
  nothing. If the filesystem cannot hold POSIX modes (vfat/exfat on the removable
  media scenario 2 prescribes), the check fails and the message names the filesystem
  type. That is a deliberate refusal, not an oversight: a USB stick is a case for an
  encrypted volume, not for writing the corpus unprotected.
- `INV-C4b` (app-enforced): new inodes are created under `umask 077`; the run
  directory's and each archive's achieved mode is **read back** after creation and a
  mismatch fails. Creation-time modes and the read-back together are what INV-C4a's
  round-1 form only asserted.
- `INV-C4c` (app-enforced): all work happens in `<stamp>.partial`, renamed to
  `<stamp>` only after C5 passes for every member. The `.partial` suffix cannot match
  C6's anchored pattern, so a half-written run is never a prune candidate and never
  looks like a good generation. This single change is what makes INV-C5b and INV-C3b
  reachable, which round 1's design could not achieve.
- `INV-C4d` (app-enforced): `trap 'cleanup' EXIT` plus `trap 'exit 130' INT TERM`,
  with `cleanup` single-sourced. Under `set -e` a failing command aborts at the point
  of failure and SIGINT bypasses `set -e` entirely, so post-failure cleanup written
  inline never runs. `cleanup` removes `<stamp>.partial` on an unpublished failure and
  normalises the exit status to 1 (docker emits 125/126/127; `command not found` is
  127; SIGINT is 130) so C1's exit-code contract holds.
- `INV-C4e` (app-enforced): `flock -n` on `$BACKUP_DIR/.lock` for the whole run;
  contention → `BACKUP_ERR:LOCKED`. The run directory is created with bare `mkdir`
  (not `-p`) so a same-second collision is a hard error rather than a silent merge.
- `INV-C4f` (app-enforced): the destination is refused when it resolves inside **any**
  git worktree, unless `BACKUP_ALLOW_IN_REPO=true`. Adjudication authority:
  `env -u GIT_DIR -u GIT_WORK_TREE -u GIT_CEILING_DIRECTORIES git -C <nearest existing
  ancestor of the resolved path> rev-parse --show-toplevel`, with any non-zero exit
  treated as "unknown → refuse" (fail-closed). Two distinct messages: `DEST_IN_REPO`
  naming *this* repository, and `DEST_IN_REPO` naming *another* worktree. Round 1
  argued the second case is a false deny for a dotfiles-managed `$HOME`; it is a true
  deny — a dump under a dotfiles repo is a real exposure, and that repo has no
  `*.dump` ignore rule either. The message tells the operator to choose a path outside
  the worktree.
- `INV-C4g` (tripwire, honestly classed): `.gitignore` gains `*.dump` and
  `!scripts/__tests__/fixtures/**` so C9's fixtures remain committable; `.dockerignore`
  gains the mirrored entries and `scripts/checks/check-dockerignore-secrets.sh`'s
  hand-maintained `MUST_EXCLUDE` gains a representative path. Round 1's claim that
  `.gitignore` is "the strictly stronger, schema-enforced form" of INV-C4f was wrong
  in both directions: it is defeated by `git add -f`, covers only `*.dump` (not
  `MANIFEST`, not `globals.sql`), and does nothing for the `.dockerignore` egress path
  that `BACKUP_ALLOW_IN_REPO` makes reachable.

**Consumer-flow walkthrough**

- Consumer 1 — **restore runbook** (`docs/operations/dev-host-migration.md` step 5).
  Its current commands are `docker compose exec -T db pg_restore … -d passwd_sso <
  passwd_sso.dump` with **bare relative paths** resolved against the repo root,
  because step 3 wrote them there. It reads `{run-directory path, passwd_sso.dump,
  jackson.dump, globals.sql}` and needs the *paths*, not just the base names. C8
  therefore rewrites step 5 to read from the run directory and to restore
  `globals.sql` first. Round 1's walkthrough asserted this consumer was satisfied; it
  was not, and SC1's "already written" was false.
- Consumer 2 — **the operator** reads `{run-directory name, MANIFEST}` and needs
  `hostname` to tell two hosts' generations apart on shared media (scenario 2). Round
  1's MANIFEST field list omitted it while the walkthrough claimed it.
- Consumer 3 — **the pruner** (C6) reads `{directory names}` and requires that no
  in-progress or failed run matches the generation pattern — satisfied by INV-C4c's
  `.partial` / `.FAILED` suffixes.

**Forbidden patterns**

- `pattern: chmod 0?[0-7]{3} ` — reason: modes come from `umask` at creation plus a read-back, never a retro-fit.
- `pattern: mkdir +-p +"?\$\{?BACKUP_DIR\}?/` — reason: run directories use bare `mkdir` so a collision is an error (INV-C4e).

**Acceptance criteria**

- Pre-existing `$BACKUP_DIR` with mode `0755` → `BACKUP_ERR:DEST_UNSAFE`, nothing written.
- Pre-existing `$BACKUP_DIR` with mode `0700` owned by EUID → proceeds (paired allow case).
- `$BACKUP_DIR` a symlink → `DEST_UNSAFE`.
- Run directory and each archive read back as `0700` / `0600` via the portability helper.
- SIGINT during the second dump leaves no `<stamp>` directory, leaves at most
  `<stamp>.partial` removed by the trap, and exits 130 → normalised to 1.
- A second concurrent invocation → `BACKUP_ERR:LOCKED`, first run unaffected.
- `BACKUP_DIR` inside this repo → `DEST_IN_REPO`; inside another worktree →
  `DEST_IN_REPO` with the other root named; outside any worktree → proceeds.
- `git check-ignore -q backup.dump` succeeds **and**
  `git check-ignore -q scripts/__tests__/fixtures/valid.pgdump` fails (paired case).

### C5 — Validation by the reader that will restore

For each member, in order: (1) the dump command's exit status is zero; (2) the file is
non-empty; (3) the archive is read by `pg_restore --list` (or, for `globals.sql`, a
non-empty plain-SQL sanity check) and its **non-comment** TOC entry count is recorded.

**Where check 3 runs — the round-1 gap.** The host has no Postgres client at all. So:

- **Compose mode**: `docker compose exec -T -- "$COMPOSE_DB_SERVICE" pg_restore --list
  /dev/stdin < "$file"` — the same binary version that produced the archive, which is
  what makes the check meaningful rather than a version-skew lottery.
- **URL mode**: the host `pg_restore`, whose presence is preflighted with
  `command -v` (failure → `BACKUP_ERR:NO_CLIENT`, **before** any dump) and whose
  `--version` is recorded in MANIFEST next to `pg_dump`'s.

**Invariants**

- `INV-C5a` (app-enforced): the run is published only after all three checks pass for
  every member.
- `INV-C5b` (app-enforced): an entry count of **zero is not a failure**. Round 1's
  oracle was wrong in both directions: `pg_restore --list` always emits `;`-prefixed
  header lines, so a raw line count can never reach zero (the check reduces to check
  1); and a legitimately empty database — `jackson` before Jackson first boots, a
  window `dev-host-migration.md` step 4 explicitly prescribes — has zero real entries.
  The script counts non-comment lines, records the count in MANIFEST, and emits a
  loud named warning at zero without failing.
- `INV-C5c` (app-enforced): a check-3 failure renames the work directory to
  `<stamp>.FAILED` rather than deleting it. Deleting would let a validator problem
  (a missing or mismatched client) destroy a good archive. `<stamp>.FAILED` cannot
  match C6's pattern and is pruned on its own schedule (INV-C6f).

**Control class**: fail-closed verification gate. Adjudication authority:
`pg_restore`'s own archive reader, executed at the site named above. Round 1 declared
this authority without establishing that the binary was reachable at all.

**Acceptance criteria** (see C9 for how these are made real rather than stub-decided)

- Truncated archive fixture → validation fails, `<stamp>.FAILED` exists, no `<stamp>`.
- Zero-byte archive fixture → fails at check 2 with `VALIDATE_FAILED`.
- Valid archive fixture → passes; `<stamp>` published; MANIFEST records the count.
- Valid **empty-TOC** archive fixture → passes, MANIFEST records `entries=0`, warning
  emitted (the paired case round 1 would have failed).
- URL mode with no host `pg_restore` → `BACKUP_ERR:NO_CLIENT` before any dump.

### C6 — Retention pruning

After publication, delete the oldest published generations until `BACKUP_RETAIN`
remain.

**Invariants**

- `INV-C6a` (app-enforced): pruning runs only after C5 passed and the run was published.
- `INV-C6b` (app-enforced): candidates are exactly the entries directly under
  `$BACKUP_DIR` that are directories, are **not** symlinks, and whose basename matches
  `^[0-9]{8}T[0-9]{6}Z$`. Everything else — `notes/`, a regular file named like a
  generation, `.partial`, `.FAILED`, `.lock` — is **invisible to the count**, not
  merely skipped. Round 1 left this ambiguous, which made the expected deletion count
  in a mixed population undefined.
- `INV-C6c` (app-enforced): the run just published is excluded from the candidate list
  **by resolved path**, not by assuming it sorts newest. Round 1's design relied on
  name order; a clock step, a VM snapshot restore, or two hosts sharing `$BACKUP_DIR`
  (this plan's own subject) makes the new run the oldest name, and with
  `BACKUP_RETAIN=1` the script would have deleted the backup it had just validated and
  exited 0.
- `INV-C6d` (app-enforced): after pruning, the published run directory and every
  expected member are re-stat'd; absence → `BACKUP_ERR:RUN_VANISHED`, exit 1. Success
  is conditional on the artifact still existing, not on the dump having once
  succeeded. This replaces round 1's INV-C6d, whose refusal branch was unreachable
  given `BACKUP_RETAIN ≥ 1` and therefore could not be red-proved.
- `INV-C6e` (app-enforced): `$BACKUP_DIR` is resolved once, the process `cd`s into it,
  and each removal is `rm -rf -- "$name"` on a bare basename, with the `st_dev:st_ino`
  of `.` re-verified immediately before each removal (`PRUNE_ABORTED` on change).
  Candidates are read NUL-delimited (`find . -mindepth 1 -maxdepth 1 -print0`), never
  through word splitting. Round 1 bounded only the basename while `rm` re-resolved
  every component of `$BACKUP_DIR` by name at each iteration.
- `INV-C6f` (app-enforced): `<stamp>.FAILED` directories are pruned by the same
  retention count on their own list, so INV-C5c cannot accumulate plaintext dumps
  without bound.
- `INV-C6g` (app-enforced): `BACKUP_DRY_RUN=true` prints the resolved candidate list
  and the deletions it would perform, then exits 0 having dumped nothing and deleted
  nothing. Every sibling destructive script in `scripts/` exposes `DRY_RUN`.

**Control class**: fail-closed verification gate over a destructive operation (R31),
**conditional on INV-C4a having established that the root is owner-exclusive and
canonical**. Where that precondition does not hold the control is a tripwire, which is
why INV-C4a is a hard refusal rather than a warning.

**Forbidden patterns**

- `pattern: find [^\n]*-delete` — reason: subtree-wide deletion is not what a generation pruner does.
- `pattern: rm -rf [^-][^\n]*\*` — reason: no glob reaches the removal call.
- `pattern: for [a-z_]+ in \$\(ls` — reason: word-splitting candidate reads (INV-C6e).

**Acceptance criteria**

- 10 generations, `BACKUP_RETAIN=7` → exactly the 3 oldest removed.
- candidates < RETAIN, == RETAIN, == RETAIN+1 → 0, 0, 1 deletions (the boundary cases
  round 1 omitted).
- Mixed population — 7 generations + a symlink named `20200101T000000Z` + `notes/` +
  a regular file named `20200102T000000Z` — asserted by the **exact surviving set**,
  with `BACKUP_RETAIN=3` so real deletions also occur in the same run. One assertion
  carrying both the deny and the allow side (RT10). The symlink's target survives.
- A pre-existing future-dated generation with `BACKUP_RETAIN=1` leaves the just-taken
  run intact.
- `BACKUP_DRY_RUN=true` creates no run directory and removes nothing.

### C7 — Credential and transport handling

**Probe (R29).** Round 1's draft claimed `pg_dump` accepts a connection URI in
`$PGDATABASE`. Measured — it does not; libpq expands a URI only as the `dbname`
*parameter*:

```console
$ docker compose exec -T -e PGDATABASE='postgresql://u:p@127.0.0.1:1/zzz' db \
    psql -U passwd_user -c 'select 1'
psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432"
  failed: FATAL:  database "postgresql://u:p@127.0.0.1:1/zzz" does not exist
```

**Mechanism.** Round 1 then proposed parsing the whole URI with one anchored bash
regex. Review red-proved that this rejects no-port, no-password, IPv6-literal and
multi-host forms — all valid libpq URIs that four sibling scripts accept today — and
that it exports percent-encoded passwords without decoding, authenticating with the
wrong password. libpq's parser is the interpreter that defines what the variable
means (R47), so the script delegates to it:

1. Extract **only** the password — the sole component that must not reach `argv` —
   with a narrow match on the `:…@` between `scheme://` and the host.
2. Percent-decode it and place it in `PGPASSWORD`.
3. Pass the **password-stripped URL** to `pg_dump -d`. Host, port, user, IPv6,
   multi-host and every query parameter are then parsed by libpq itself. None of those
   are secrets, and their presence in `argv` is the existing status quo for
   `set-outbox-worker-password.sh`, `rls-cross-tenant-negative-test.sh` and
   `migrate-prf-per-credential-salt.sh`.
4. Reject only what is unambiguously not a libpq URI: a string not starting with
   `postgres://` or `postgresql://` → `BACKUP_ERR:BAD_URL`.

**Invariants**

- `INV-C7a` (fail-closed verification gate — *not* the "enforceable boundary" round 1
  claimed; nothing structural prevents an author from writing the password into an
  argument, only the mechanism above plus C9's assertion): the password never appears
  in `argv`.
- `INV-C7b` (app-enforced): **TLS floor.** `PGSSLMODE` is set **unconditionally** in
  URL mode from `BACKUP_TLS_MODE` (default `verify-full`), overriding whatever the URL
  or the ambient environment says, and a URL requesting a weaker mode is rejected.
  libpq's default is `prefer` — opportunistic TLS with no certificate or hostname
  verification and silent plaintext fallback — which on the RDS path would carry the
  entire ciphertext corpus, the audit log, and the SUPERUSER password over a
  strippable connection. `sslrootcert`, `sslcert`, `sslkey` and `channel_binding` pass
  through in the URL because `verify-full` is unusable without a root certificate;
  round 1's allowlist blocked exactly the parameter that makes the floor reachable.
- `INV-C7c` (app-enforced): the libpq environment is **neutralised** before the run.
  The member set is derived from libpq's documented variable list, not from the five
  round 1 named: `PGHOST`, `PGHOSTADDR`, `PGPORT`, `PGDATABASE`, `PGUSER`,
  `PGPASSWORD`, `PGPASSFILE`, `PGSERVICE`, `PGSERVICEFILE`, `PGOPTIONS`,
  `PGSSLMODE`, `PGSSLCERT`, `PGSSLKEY`, `PGSSLROOTCERT`, `PGSSLCRL`,
  `PGREQUIRESSL`, `PGREQUIREPEER`, `PGCHANNELBINDING`, `PGCONNECT_TIMEOUT`,
  `PGTARGETSESSIONATTRS`. Each is unset, then only what the script sets is exported.
- `INV-C7d` (app-enforced): xtrace is suppressed around credential handling —
  `{ set +x; } 2>/dev/null` before, restore after. Round 1 wrote an acceptance
  criterion ("`bash -x` output contains no password") that **no described mechanism
  could satisfy**; review red-proved four leaks. A criterion a correct implementation
  cannot pass gets weakened rather than met.
- `INV-C7e` (app-enforced): `PGPASSWORD` is unset immediately after the last
  connection, so it is not inherited by `pg_restore --list`, by the pruner's children,
  or by C9's PATH stubs.
- `INV-C7f` (app-enforced): MANIFEST is written from the closed allowlist in C4. No
  sink other than that allowlist receives a value derived from
  `MIGRATION_DATABASE_URL`.

**Forbidden patterns**

- `pattern: (echo|printf|tee|env|declare -p)[^\n]*MIGRATION_DATABASE_URL` — reason: no credential to any output sink (round 1 covered `echo` only).
- `pattern: pg_dump[^\n]*\$\{?MIGRATION_DATABASE_URL` — reason: the raw URL never reaches `argv`; only the stripped form does.

**Acceptance criteria**

- Sentinel password: the stub `pg_dump` records its own `argv`; the assertion is that
  the record contains neither the sentinel nor the raw URL, **and** that
  `PGPASSWORD` in the stub's environment equals the sentinel (the paired allow case,
  without which the test passes on a script that never connects).
- `bash -x` output contains no sentinel, **and** does contain the `pg_dump`
  invocation (paired case proving the trace was produced at all).
- After the last dump, a stub invoked later sees no `PGPASSWORD`.
- A URL with no port, with no password, with an IPv6 literal, and with a
  percent-encoded password each proceed (the four forms round 1's regex rejected);
  `not-a-url` → `BACKUP_ERR:BAD_URL`.
- A URL carrying `sslmode=disable` → rejected; ambient `PGSSLMODE=disable` → overridden
  to `verify-full` in the stub's environment.

### C8 — Documentation

- `docs/operations/backup-recovery/en.md` **and** `ja.md` gain a self-hosted section.
  Class A, bilingual required (`docs/operations/language-policy.md`) — both or neither.
- `CLAUDE.md`'s admin-scripts block gains the invocation line.
- `docs/operations/dev-host-migration.md`: step 3 points at the script (keeping the
  stop-the-writers precondition above it, and the manual commands as fallback), and
  **step 5 is rewritten** to restore `globals.sql` first and to read the archives from
  the run directory rather than from bare relative paths.
- `docs/operations/incident-runbook.md:56`'s bare `pg_dump passwd_sso` is replaced by
  the script. Left as-is it dumps one of three members with no validation, inside the
  procedure run under the most time pressure.
- The docs state SC3 plainly: archives are protected by mode and location only.

**Invariants**

- `INV-C8a`: **no gate enforces these edits on an ordinary PR.** Re-derived:
  `check-doc-paths.mjs` is invoked only by `scripts/refactor-phase-verify.mjs`, whose
  workflow triggers on `refactor/**`, `merge_group` and `workflow_dispatch` — not
  `ci.yml`, not `pre-pr.sh`. Its Pass B *does* bypass `SKIP_GLOBS` to validate
  `scripts/*.sh` references in `docs/operations/**`, so on those branches it would
  catch a doc landing before the script; on a feature branch it never runs. Round 1
  claimed CI enforcement it does not have and gave a false reason for the gap.
- `INV-C8b` (app-enforced by C9): because no gate covers it, the self-test asserts the
  documentation edits directly — each of the five files is read and asserted to
  reference `scripts/backup-db.sh`. Four lines of test move this from author
  obligation to a red build.

**Acceptance criteria**

- C9 asserts `scripts/backup-db.sh` appears in all five files.
- C9 asserts the `en.md` / `ja.md` pair both changed (bilingual policy).

### C9 — Self-test

`scripts/__tests__/backup-db.test.mjs`, picked up by `vitest.config.ts`.

**Harness.** Modelled on `scripts/__tests__/deploy-rollback.test.mjs`, which is the
repo's real PATH-stub precedent (it stubs `aws`, `terraform`, `git`, `docker`, `jq`
via a `stub()` helper writing `#!/usr/bin/env bash` + `chmodSync(0o755)`), and on
`set-outbox-worker-password.test.mjs`, the precedent for shelling out to an *operator*
script with an explicit allowlisted spawn env. Round 1 cited
`check-actions-sha-pinned.test.mjs`, which stubs nothing.

**Invariants**

- `INV-C9a` (RT7): every guard has a test that reds when the guard is deleted, and the
  assertion is on `exitCode === 1 && stderr.includes("BACKUP_ERR:<CODE>")` — never on
  the exit code alone. Round 1's design asserted only exit 1, which every unrelated
  failure in a synthetic environment also produces, so the tests would have passed
  against a script that implemented none of the guards. The RT7 mutation proof is a
  named deliverable: for each guard, the one-line deletion and the test that reds,
  performed on a scratchpad copy of the script — never on the real file.
- `INV-C9b` (RT10): every guard also has a paired allow case, listed in the acceptance
  criteria above.
- `INV-C9c` (RT11): the spawn environment is an explicit allowlist including
  `HOME=<tmpdir>` — **not** a spread of `process.env`. Round 1's design left `HOME`
  inherited while `BACKUP_DIR` defaults to `${HOME}/passwd-sso-backups` and the pruner
  `rm -rf`s there, so a test of default behaviour would have deleted the developer's
  real backups. The script additionally carries a fixture-mode pollution guard
  mirroring `ACTIONS_SHA_PINNED_FIXTURE_MODE` / `NO_PIPE_GREP_Q_FIXTURE_MODE`. Temp
  roots are removed in `afterEach` on both paths.
- `INV-C9d` (source scan): the test reads `scripts/backup-db.sh` and asserts each
  forbidden pattern is absent, **each paired with a positive control** (the same regex
  matched against a fixture line) so a typo'd regex cannot pass vacuously. This is the
  runner the forbidden-pattern blocks lacked; it is also the only way INV-C4b's
  "creation-time mode, not `chmod`" is falsifiable, since both implementations reach
  the same final mode.
- `INV-C9e` (RT1/RT5 — the round-1 hole): C5's validation is **not** decided by a
  stub. The suite splits:
  - **Group A (stubbed)** — C1, C2, C3, C4, C6, C7, C8. `pg_dump`, `pg_restore`,
    `docker` and `flock` are PATH stubs. These contracts are about the script's own
    logic and a stub is the right instrument.
  - **Group B (real reader)** — C5 only. Byte fixtures (valid, empty-TOC, truncated,
    zero-byte) under `scripts/__tests__/fixtures/` are read by a **real
    `pg_restore`**. The binary is located in this order: host `pg_restore`, else
    `docker compose exec` into the `db` service. If neither is available the group
    **fails** with an actionable message — it never skips, because a skipped test for
    the plan's most load-bearing invariant reads as coverage. CI gains a
    `postgresql-client` install step in the app job so Group B runs there; the same
    step is documented in CLAUDE.md for local runs.
- `INV-C9f`: fixtures are named `*.pgdump` (not `*.dump`) so INV-C4g's ignore rule
  cannot silently exclude them from the commit, and each fixture's existence and size
  is asserted before use — a missing fixture reds, never skips.

**Acceptance criteria**

- Deleting any single guard from a scratchpad copy of the script reds at least one
  test, and the mutation-proof table is recorded in the PR.
- Group A passes with no Postgres and no docker.
- Group B passes with a real `pg_restore`, and fails with `NO_CLIENT`-shaped guidance
  when none is reachable.

## Testing strategy

1. **Group A** — stubbed behavioural tests, CI and local.
2. **Group B** — real `pg_restore` over byte fixtures, CI (after the client install)
   and local.
3. **Manual, Compose** — one real run against the dev stack, then a real restore of
   `globals.sql` + both archives into a scratch database. `verifiable-local` (VE2).
4. **Manual, URL mode** — one real run against the same database over TCP with
   `MIGRATION_DATABASE_URL`, exercising the password-strip, the TLS floor, and the
   host-`pg_restore` validation site. The VE1 substitute.
5. **Gate** — `scripts/pre-pr.sh`, which includes `check-no-pipe-into-grep-q.sh`.

### Verification classification per contract

| Contract | Classification |
|---|---|
| C1, C2, C3, C4, C6, C7, C8 | verifiable-CI (Group A) |
| C5 | verifiable-CI (Group B, after the client install) + verifiable-local |
| URL mode end-to-end against RDS | blocked-deferred (VE1), substituted by strategy 4 |

## Considerations & constraints

### Scope contract

- `SC1` — **Restore execution is out of scope**; the script never restores. The
  restore *runbook* is not out of scope: C8 rewrites `dev-host-migration.md` step 5,
  because this change breaks its current bare-relative-path form.
- `SC2` — **Scheduling is out of scope.** No cron, timer, or Compose service.
- `SC3` — **Encryption at rest and offsite replication are out of scope.** Archives
  are protected by file mode, ownership, and location, all now verified (INV-C4a).
  Anyone with read access to `$BACKUP_DIR` has the full ciphertext corpus, the audit
  log, and every wrapped key. Stated in the docs, not implied away.
- `SC4` — **AWS behaviour is unchanged.** The RDS snapshot / PITR / Backup Vault Lock
  procedures remain the AWS path.
- `SC5` — **`check-doc-paths.mjs` is not wired into `pre-pr.sh` by this PR.**
  Anti-Deferral: wiring a gate into the shared pre-PR pipeline is a change to every
  contributor's loop and belongs in its own PR with its own review; the documentation
  edits are instead asserted directly by INV-C8b, which is stronger for this change
  and weaker for nothing. Owner: a follow-up issue.
- `SC6` — **The argv exposure in four sibling scripts is not fixed here.**
  `set-outbox-worker-password.sh:94`, `rls-cross-tenant-negative-test.sh` (10+ sites),
  `migrate-prf-per-credential-salt.sh:20` each pass `$MIGRATION_DATABASE_URL` to
  `psql` in `argv`, exposing the SUPERUSER password to every local user for the
  connection's lifetime. Anti-Deferral: the correct fix is a shared
  `scripts/lib/pg-connect.sh` sourced by all five scripts, which is a refactor across
  four existing operator paths with their own tests and manual procedures; bundling it
  here would make this PR's blast radius larger than its subject. The residual is
  explicit: **this plan does not close the argv class for the deployment, only for the
  new script.** Owner: a follow-up issue, to be filed with this PR.

### Risks

- The archives contain everything the database contains. Vault entry bodies remain
  end-to-end encrypted, but audit logs, email addresses, tenant configuration and every
  wrapped key blob are present. SC3 is the mitigation boundary.
- `globals.sql` with `--no-role-passwords` means a restore still needs the matching
  `.env` and an initdb-bootstrapped cluster. C8 states this in the runbook.

## User operation scenarios

1. **By hand on the verification host**, no env set. New dated directory under
   `~/passwd-sso-backups`; 8th-oldest pruned; `hostname` in MANIFEST.
2. **Pre-migration snapshot** to removable media with `BACKUP_RETAIN=1`. If the medium
   cannot hold POSIX modes the script refuses with `DEST_UNSAFE` naming the filesystem
   (INV-C4a) — the operator uses an encrypted volume. A future-dated generation from
   the other host does not cause the new run to be pruned (INV-C6c).
3. **Wrong working directory** (this session's failure): `BACKUP_ERR:NO_COMPOSE_FILE`
   naming the cwd; no generation created.
4. **Full disk** mid-dump: the partial is removed and nothing is published
   (`DUMP_FAILED`). `<stamp>.FAILED` is kept only when an archive was written and
   the READER rejected it (`VALIDATE_FAILED`) — the case where the fault may be
   the validator rather than the archive, and destroying a possibly-good corpus
   would be the wrong direction. Corrected after round 2: this scenario
   previously described the .FAILED behaviour for both.
5. **RDS** via `MIGRATION_DATABASE_URL` with `sslmode=verify-full` and `sslrootcert`.
   No `docker` spawned, no password in `ps` or in the trace, `BACKUP_DATABASES` set to
   the instance's actual database names.
6. **Ctrl-C during a long dump**: trap removes `<stamp>.partial`, exit normalised to 1,
   no generation published, no prune.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | CLI surface, environment contract, error identity | pending |
| C2 | Connection mode selection | pending |
| C3 | Target set (databases ∪ cluster globals) | pending |
| C4 | Destination safety, layout, atomic publication | pending |
| C5 | Validation by the reader that will restore | pending |
| C6 | Retention pruning | pending |
| C7 | Credential and transport handling | pending |
| C8 | Documentation | pending |
| C9 | Self-test | pending |

## Carried-Forward Plan Findings

Round 2 returned 49 new findings (6 Critical). The loop was exited early by explicit
user decision rather than by saturation — Criticals and Majors are open. The
justification, recorded once for the whole set: every round-2 Critical was red-proved
by executing a command, not by argument, and each correction below is a fact the
implementation and its test settle in seconds. Continuing to specify call shapes in
prose costs a review round per wrong shape. The architecture — validate with the real
reader, publish atomically, bound the pruner, delegate URI meaning to libpq — survived
both rounds unchallenged; only the invocations failed.

Each entry is `[ID] [Severity] [Title] — Carried to Phase 2`, with the measured
correction that settles it. Phase 2 implements against this list; Phase 3 verifies
against it. An entry with no test in the delivered diff is not done.

### Corrections that change a contract's mechanism

- **S-02 Critical (escalate) — the password strip fails open into `argv`.** C7's only
  rejection is "does not start with `postgres://`", so a URL carrying a password that
  the narrow match misses is handed to `pg_dump -d` whole. Correction: isolate the
  authority substring (after `://` up to the first `/`, `?` or `#`); if it contains
  `@`, a strip is **mandatory** and a non-firing strip is `BACKUP_ERR:BAD_URL`; after
  stripping, assert the outgoing authority has no `:` before its `@`. Prefer removing
  the question entirely by handing the conninfo to libpq through a mode-0600
  `PGPASSFILE` removed in the trap.
- **S-01 Critical (escalate) — the TLS floor is regex-adjudicated and loses to the
  URL.** Measured: `PGSSLMODE=require` + `?sslmode=disable` connects in cleartext;
  libpq percent-decodes both keyword and value, so `?%73slmode=disable` evades any
  regex. Correction: stop adjudicating the string — **append** `sslmode=<floor>` (and
  `sslrootcert=` when supplied) as the *last* query parameters, so libpq's own
  last-occurrence-wins settles it; probe that precedence before relying on it. Then
  verify the achieved transport rather than the requested one: record
  `SELECT ssl, version, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid()` in
  MANIFEST and fail when `ssl` is false. Reject `gssencmode` alongside `sslmode`.
- **N1 Critical — `pg_restore --list /dev/stdin` fails on every valid archive.**
  Measured: `did not find magic string in file header`; without the filename, 33 lines
  / 18 non-comment entries. Correction: `docker compose exec -T -- "$svc" pg_restore
  --list < "$file"`, no filename argument.
- **N2 Critical — URL mode cannot address a second database.** Measured: `PGDATABASE`
  loses to the URL's path; `?dbname=jackson` wins. Correction: append `dbname=<target>`
  per target, choosing `?`/`&`, and reject a URL that already carries `dbname=`.
  Acceptance: `select current_database()` per target in strategy 4.
- **N3 / S-13 Critical — `flock(1)` is absent on macOS**, the declared primary
  operator host, and has no in-repo precedent. Correction: `mkdir "$BACKUP_DIR/.lock.d"`
  — atomic on POSIX, no external binary, PID written inside for staleness, removal in
  the existing trap. Add it to the portability derivation.
- **N-01 Critical — Group B re-stubs its own adjudicator in Compose mode**, and CI and
  local silently test different modes under one name. Correction: fix the mode and the
  reader per case as an explicit asserted input; cover both sites, with a `docker` stub
  that *delegates* the `pg_restore` subcommand to real docker and logs the delegation.
- **S-07 / N4 Major — `pg_dumpall --globals-only` does not carry database-level ACLs.**
  Measured: 31 lines, all `CREATE ROLE`/`ALTER ROLE`. The `REVOKE CONNECT ON DATABASE`
  that C3's rationale cites is in neither member. Correction: add `--create` to each
  `pg_dump -Fc` so the `DATABASE` TOC entry carries the ACL, correct C3's rationale to
  what `--globals-only` actually covers, and restate the restore order in C8.
  (`--no-role-passwords` was verified correct and stands.)
- **S-04 Major (regression) — `!scripts/__tests__/fixtures/**` un-ignores every
  secret class** (`.env`, `*.pem`, `*.key`, `*.p12`) for that subtree, because
  `.gitignore` is last-match-wins. Correction: delete the negation outright — INV-C9f's
  `*.pgdump` naming already keeps the fixtures committable. If a negation is ever
  needed, follow `.gitignore:98-101`: one named file, one comment. Extend
  `check-env-gitignore.test.mjs` with `scripts/__tests__/fixtures/.env` as the red-proof.
- **S-06 Major — the libpq env member set is hand-listed and went 5 → 20 by
  accretion**, omitting `PGGSSENCMODE` (a transport `PGSSLMODE` does not govern) and
  `PGSSLMINPROTOCOLVERSION`. Correction: allowlist instead of denylist — build the
  child environment with `env -i` plus exactly what the script needs, so an unlisted
  `PG*` cannot exist by construction.
- **S-05 Major — INV-C4a does not establish the owner-exclusivity C6's control class
  is declared conditional on.** POSIX/macOS ACLs are invisible to the mode bits;
  macOS `noowners` volumes (the default for external media — scenario 2's own case)
  fabricate a passing `st_uid == EUID`; ancestors are unverified. Correction: detect
  extended ACLs and refuse; parse `mount` for `noowners`-class options and name the
  option in the message; walk the ancestor chain; do the check and every create
  descriptor-relative from one `cd`. If not all are taken, re-class C6 as a tripwire
  and say so in SC3.
- **S-10 Major — INV-C6e's `st_dev:st_ino` check is tautological.** `.` resolves
  through the cwd handle and cannot change. Correction: compare `stat .` against
  `stat "$BACKUP_DIR"` (path-resolved) each iteration; a divergence is the swap. Add a
  C9 case that renames the root mid-prune and asserts `PRUNE_ABORTED`.
- **N9 / S-11 Major — `.FAILED` pruning is gated behind publication**, so a
  persistently failing deployment accumulates full plaintext corpora forever.
  Correction: prune `.FAILED` at the **start** of every invocation, inside the lock,
  before any dump; bound by age and count; state the retention in C8 and SC3.
- **N7 / S-11 Major — the trap's preconditions, disposition and error identity are
  undefined.** Correction: initialise every variable the trap reads to `""`; a single
  `fail <CODE> <msg>` function so the trap only normalises; add `INTERRUPTED` and
  `INTERNAL` to the closed code set; name which codes produce `.FAILED`
  (`VALIDATE_FAILED` only) and which delete the partial; correct scenario 4, which as
  written describes a dump failure that INV-C5c does not cover.
- **N8 Major — `cd "$BACKUP_DIR"` has no declared scope** and would break every
  subsequent `docker compose` (which resolves its config from cwd). Correction: scope
  the `cd` to the pruning step in a subshell; capture the original cwd once for
  INV-C2b's message.
- **N10 Major — first-run creation of `$BACKUP_DIR` is undefined**, so scenario 1 and
  every default-path test exit `DEST_UNSAFE`. Correction: `mkdir -m 0700` under
  `umask 077` when absent, read back, then run the full verification; order the lock
  after it.
- **N11 Major — "restore `globals.sql` first" contradicts the runbook's initdb-first
  invariant.** Correction: `globals.sql` is for a cluster rebuilt *without* initdb
  (the RDS/bare-cluster path); for the Compose migration it is a cross-check that the
  target's roles match the source. Note that `dev-host-migration.md` is currently
  untracked, so INV-C8b depends on this PR committing it.
- **S-12 Major — the percent-decode mechanism is unspecified**, and the natural bash
  idioms range from lossy (`printf '%b'` mangles backslashes) to `eval` RCE.
  Correction: a byte-exact `%XX` loop; forbid `eval` as a C7 forbidden pattern; extend
  the sentinel to include `\`, `$(id)`, a trailing newline and a bare `%`.
- **S-03 Major — `verify-full` is unreachable without an operator CA**, and libpq's
  own error text steers the operator to the escape that disables verification.
  Correction: drop `require` from the value set (floor `verify-ca`); require an
  explicit CA and fail preflight with `BACKUP_ERR:NO_CA` before any dump; document
  where the RDS CA bundle comes from; record a downgraded run in MANIFEST.
- **S-08 Major — `globals.sql` is exempt from C5's reader-validation** while INV-C5a
  claims universal coverage. Correction: record SHA-256 and byte count, assert the
  trailing `-- PostgreSQL database cluster dump complete` marker and a captured
  `^CREATE ROLE` count ≥ 1, and state plainly in C5 and the docs that this member
  carries structural assurance only.
- **S-09 Major — the `*.dump` rule leaves `globals.sql` and `MANIFEST` committable**
  and inside the build context. Correction: ignore the directory shape, not the
  extension; use `check-dockerignore-secrets.sh`'s `DIR_CLASSES` (designed so one line
  extends both checks); assert `git check-ignore` for all three member names.
- **N12 Major — the required-binary set is under-derived** (`pg_dumpall` and `pg_dump`
  are not preflighted). Correction: derive from the invocation sites; preflight each
  with `command -v` into `NO_CLIENT` naming the missing binary; C9 re-derives and
  asserts equality.
- **N13 Major — `BACKUP_DRY_RUN` previews one generation too few.** The real run adds
  a generation before pruning. Correction: insert a synthetic entry; report "would
  delete N of G+1"; add the `G == R` case where the preview says "nothing" and the real
  run deletes one.
- **N6 Major — the TLS floor's rejection half has no adjudicator** (see S-01).
- **N-02 Major — INV-C8b's "both files changed" is a diff property no content test can
  observe.** Correction: restate as a content property both files must hold; assert on
  the invocation line, not the bare path; derive the file list from one constant.
- **N-03 Major — the env allowlist starves Group B's docker fallback** (`DOCKER_HOST`,
  `DOCKER_CONTEXT`, `DOCKER_CONFIG`, `XDG_RUNTIME_DIR`). Correction: a separate, named
  Group B allowlist; state that the two groups do not share a spawn env.
- **N-04 Major — INV-C9d's positive controls prove non-vacuity only.** `chmod 0?[0-7]{3}`
  is blind to `chmod u=rwx,go=`, `install -m`, `mkdir -m`; `find … -delete` to
  `-exec rm -rf {} +`; `\| *grep -q` is narrower than the gate it mirrors
  (`-qxF`, `-iqE`). Correction: enumerate the spellings per pattern or state the
  residual; make each control a plausible implementation line.
- **N-05 / N15 / S-17 Major — VE3's "CI has no Postgres client" is false**
  (`ci.yml:616-628`, `ci-integration.yml:140` run bare `psql`). Correction: drop the
  install step unless a probe shows it is needed; pin the client major version; record
  how each fixture was produced and at which server version.
- **N-06 Major — Group B belongs in `vitest.integration.config.ts` + `ci-integration.yml`**,
  whose path filter already includes `scripts/**` and which already carries Postgres.
  Correction: split Group B there rather than adding an environment dependency to the
  suite every contributor runs.
- **N-07 Major — the `flock` stub can null out the entire script**, and the LOCKED
  case has no synchronisation mechanism. Correction: subsumed by N3's `mkdir` lock;
  for the contention test, block the stubbed `pg_dump` on a fifo, assert the second
  run's code, release, then await the first child in `afterEach`.
- **N-08 Major — the C3 derivation regex cannot match `docker-compose.yml:68`**, the
  URL spelling it was added for: `[^ ]*` cannot cross the spaces inside
  `${PASSWD_JACKSON_PASSWORD:?…}`. The set-equality test passes today for the wrong
  reason. Correction: parse the YAML structurally or tolerate `${…}` with spaces;
  exclude build-arg blocks; paste the output before writing the test; have the test
  shell out to the same command rather than re-implement it.
- **N4 Major — the role enumeration does not reproduce against the live cluster**
  (`jackson_user` absent; seven other roles present). Correction: re-derive against a
  live cluster and record the command.
- **N5 Major — `globals.sql`'s check 3 collapses into check 2** (see S-08).

### Smaller corrections

- **N14 / N-08 Minor** — the published derivation returns four build-arg placeholder
  URLs and no extraction rule; the `[a-z_]*` class misses digits and uppercase.
- **N16 Minor** — no per-member digest in MANIFEST; nothing detects corruption between
  take and restore. Add SHA-256 and a verification one-liner to C8. Note `globals.sql`
  contains `\restrict`/`\unrestrict`, a recent psql addition — state the client floor.
- **N17 Minor** — name `cd "$dir" >/dev/null && pwd -P` as the path resolver, since
  `readlink -f` is forbidden by the portability floor; state that it resolves ancestors.
- **N18 Minor** — an undefined Compose service exits non-zero with empty stdout and is
  reported as `DB_NOT_RUNNING`. Capture status alongside output and distinguish.
- **S-14 Minor** — scope `PGPASSWORD` to the invocation (subshell or command prefix)
  rather than exporting it across the whole dump-and-validate phase.
- **S-15 Minor** — set `IFS=$' \t\n'` explicitly beside `set -euo pipefail`;
  `BACKUP_DATABASES` is word-split and `IFS` is inherited.
- **S-16 Minor** — SC6 names the deferred class as "argv" while
  `set-outbox-worker-password.sh:81` echoes the whole URL to stderr. Restate as the
  credential-egress class (`argv` **and** log sinks) and cite both lines.
- **S-18 Minor** — a caller-set `BACKUP_DATABASES` removes INV-C3a's quantifier.
  Enumerate the cluster's visible non-template databases and warn for each one not in
  the set, in MANIFEST and on stderr.
- **N-09 Minor** — the RT7 mutation proof needs a script-path seam
  (`BACKUP_DB_SCRIPT`, read only by the test) to be reproducible; better, commit it as
  a test that copies, mutates and asserts the code is absent.
- **N-10 Minor** — `RUN_VANISHED` is reachable only under mutation; declare it
  verifiable-by-mutation-only and list the mutation, or drop the code.
- **N-11 Minor** — nothing notices if `backup-db.test.mjs` is deleted
  (`check-gate-selftest-coverage.sh` scans `scripts/checks/` only). Record as `SC7`
  with an owner.
- **N-12 Minor** — give spawns an explicit timeout under vitest's `testTimeout: 10000`,
  since `spawnSync` blocks the event loop and a hung child otherwise reports nothing.
- **N-13 Minor [Adjacent]** — normalising SIGINT's 130 to 1 loses the interrupt signal
  for a supervisor; assert the `BACKUP_ERR` code rather than the status.
