# Plan Review: db-backup-script
Date: 2026-08-03
Review round: 1

## Changes from Previous Round

Initial review.

## Merge method (deviation from Step 1-5, recorded)

The mechanical json pre-pass was performed on the three experts' fenced indices,
joining on (same subject, same root cause). The Ollama `merge-findings` prose
merge was **not** run: the three raw outputs were already in the orchestrator's
context, and writing ~45 KB back to disk to feed the helper would have cost more
than the merge saves. The json join below is the sanctioned fallback skeleton.
Perspective convergence is stamped per the Common Rules severity-floor rule.

Round 1 totals: Functionality 18, Security 14, Testing 13 = 45 raw findings,
merged to 31 distinct issues. Critical: 5 raw, 5 distinct.

## Convergence map (severity floor applied)

| Merged | Func | Sec | Test | Floor |
|---|---|---|---|---|
| M1 gate-coverage table wrong | F1 Major | — | F-04 Major | Major |
| M2 URL regex re-implements libpq | F13 Major | F11 Major | — | Major |
| M3 `*.dump` gitignore blocks fixtures | F14 Major | F5 (partial) | F-11 Major | Major |
| M4 pruner can delete the just-taken run | F9 Major | F7 Major | — | Major |
| M5 `git rev-parse` adjudicator wrong/false-denies | F10 Major | F9 Major | — | Major |
| M6 `pg_restore` execution site undefined | F4 Major | F14 adj | F-01 **Critical** | **Critical** |
| M7 cluster globals not dumped | F12 Major | F4 Major | — | Major |
| M8 INV-C6d unfalsifiable | F9(a) | — | F-06 Major | Major |
| M9 `bash -x` criterion unsatisfiable | — | F3 Major | F-08 Major | Major |
| M10 forbidden patterns have no runner; one matches its own fix | — | F6 Major | F-05 Major | Major |

## Functionality Findings

Verified-by-re-derivation: the `git grep pg_dump` inventory, `incident-runbook.md:56`,
the three named gate scan roots, absence of `shellcheck` in `pre-pr.sh`, the `db`
service, the C3 Compose member-set grep, the `PGDATABASE` probe, and the four named
sibling scripts all reproduced correctly.

- **F1 Major — gate-coverage table false (M1).** `scripts/checks/check-no-pipe-into-grep-q.sh`
  has `SCAN_DIR="scripts"` and `find "$SCAN_DIR" -name '*.sh'`, and `pre-pr.sh:345`
  runs it. The new script IS gate-covered, and the gate forbids the natural
  spelling of both C2's and C5's predicates (`cmd | grep -q`). Re-verified by the
  orchestrator. Fix: derive the gate set; decide both predicates by capture-then-test.
- **F2 Major — INV-C8a wrong in both halves.** `check-doc-paths.mjs` is invoked only
  by `scripts/refactor-phase-verify.mjs` (workflow triggers on `refactor/**`,
  `merge_group`, `workflow_dispatch`) — not `ci.yml`, not `pre-pr.sh`. And its Pass B
  deliberately bypasses `SKIP_GLOBS` for `operations/`, so it DOES validate
  `scripts/*.sh` references there. Both the claimed enforcement and the stated
  reason for non-enforcement are wrong.
- **F3 Major — INV-C2b's adjudication authority cannot decide its predicate.**
  `docker compose ps --status running <stopped-service>` exits 0. Exit status
  distinguishes unknown-service and no-compose-file, not stopped-service. Fix:
  adjudicate on emptiness of `--quiet` output.
- **F4 Major — C5 check 3 has no execution site in Compose mode (M6).** The archive
  lands on the host; the host has no Postgres client (orchestrator-verified:
  `pg_dump`/`pg_restore`/`psql` all NOT_FOUND). Under `set -e` the script dies 127
  after a successful dump and INV-C5b deletes the run.
- **F5 Major — C5's "at least one TOC entry" oracle is vacuous or a false deny.**
  `pg_restore --list` always emits `;`-prefixed header lines, so a naive line count
  never reaches zero; counting non-comment lines instead makes a legitimately empty
  `jackson` (the documented window before Jackson first boots) fail the whole run.
- **F6 Major — Consumer-1 walkthrough mis-states the restore runbook.**
  `dev-host-migration.md` step 5 uses bare relative paths (`< passwd_sso.dump`)
  resolved against cwd; the script's layout is `$BACKUP_DIR/<stamp>/`. C8 edits only
  step 3, and SC1 says steps 4–5 are "already written". Also: step 3's
  stop-the-writers precondition must survive the rewrite.
- **F7 Major — MANIFEST omits the host field Consumer 2 is stated to need.**
- **F8 Major — no trap, no partial-run naming, no lock.** `set -e` aborts at the
  failure point so post-failure cleanup never runs; SIGINT bypasses it entirely. A
  half-written directory matches C6b's pattern and is counted as a good generation.
  C1's exit-code contract is unachievable without normalisation (docker 125/126/127,
  SIGINT 130).
- **F9 Major — pruner can delete the just-taken generation; INV-C6d is dead code (M4, M8).**
- **F10 Major — INV-C4b adjudicates "inside any git worktree" (M5).** Breaks the
  default `BACKUP_DIR` for dotfiles-in-`$HOME` operators; first-run and no-`git`
  cases undefined.
- **F11 Major — target set is Compose-only.** `infra/terraform/variables.tf:155`
  makes `db_name` a variable; nothing in the repo creates a `jackson` database on
  RDS. Scenario 5 fails by construction on any RDS whose names differ.
- **F12 Major — cluster globals and database-level ACLs not captured (M7).**
- **F13 Major — bash regex re-implements libpq URI semantics (M2).** Adjacent:
  `scripts/set-outbox-worker-password.sh:93` already passes the same variable to
  `psql` in argv.
- **F14 Major — `*.dump` gitignore blocks C9's fixtures (M3).**
- **F15 Minor — `umask` has no effect on the vfat/exfat media scenario 2 prescribes.**
- **F16 Minor — GNU-only utilities on a macOS operator host.** No `scripts/*.sh`
  uses `stat -c`, `readlink -f`, or `mapfile`; macOS `/bin/bash` is 3.2.
- **F17 Minor — destructive pruner has no `DRY_RUN`, unlike every sibling.**
- **F18 Minor — `incident-runbook.md:56` left unreconciled by C8.**

## Security Findings

- **F1 Critical (escalate: true) — URL mode has no TLS floor.** libpq defaults to
  `prefer`: opportunistic TLS, no certificate or hostname verification, silent
  plaintext fallback. INV-C7d's allowlist rejects `sslrootcert`, so `verify-full` is
  structurally unreachable. Ambient `PGSSLMODE=disable` survives. On the RDS path the
  full ciphertext corpus, audit log, and the SUPERUSER password cross the wire.
  The libpq env member set is 13, not the 5 the plan names.
- **F2 Critical — an existing `$BACKUP_DIR`'s mode, owner and filesystem are never
  verified.** `umask` governs only new inodes; from run 2 onward the root always
  exists. Scenario 2's removable media has no POSIX modes at all. SC3's stated
  residual is bounded by a control that is not enforced.
- **F3 Major — the credential-leak member set covers `argv` only (M9).** `bash -x`
  leak red-proved (4 occurrences); MANIFEST uncovered; exported `PGPASSWORD`
  inherited by every child including C9's PATH stubs, never unset. The `/proc`
  rationale was re-derived and is **correct** (`cmdline` 0444, `environ` 0400), with
  the caveat that `environ` is a cross-user boundary only.
- **F4 Major — member set derived over databases, not databases ∪ cluster globals (M7).**
  `prisma/migrations/20260611011121_.../migration.sql` does `REVOKE CONNECT ON DATABASE`,
  which `pg_dump -Fc <db>` does not carry. The operator's escape from missing-role
  errors is `--no-owner --no-acl`, which discards `20260522000200`'s audit-log
  immutability REVOKE — a control two recent commits exist to protect.
- **F5 Major — RS4: `.gitignore` is not mirrored into `.dockerignore`.**
  `check-dockerignore-secrets.sh`'s `MUST_EXCLUDE` is hand-maintained, so adding
  `*.dump` to `.gitignore` propagates nowhere. With `BACKUP_ALLOW_IN_REPO=true` a
  dump enters the build context and remote cache.
- **F6 Major — R49: declared control classes exceed their mechanisms (M10).** C7's
  "enforceable boundary" and C4c's "schema-enforced / strictly stronger" are both
  overstated. C1's `rm -rf "?\$\{?BACKUP_DIR` pattern matches C6's own correct
  implementation — a forbidden pattern that reds the fix trains its own bypass.
- **F7 Major — pruner deletes the just-validated run and exits 0 (M4).**
- **F8 Major — R31/R51: every C6 invariant is name-based and `$BACKUP_DIR` is
  re-resolved at `rm` time.** Symlinked ancestor, root swapped between scan and
  removal, no `--` terminator, no NUL-delimited read.
- **F9 Major — C4b false-denies the default configuration (M5).** Ambient `GIT_*`
  vars steer the verdict; the documented remedy is a permanent
  `BACKUP_ALLOW_IN_REPO=true`, which activates F5.
- **F10 Major — RS3: INV-C1a claims universal validation with a member set of one.**
  `COMPOSE_DB_SERVICE` reaches `docker compose exec`; `BACKUP_DIR` reaches
  `mkdir`/`rm` as a potential option.
- **F11 Major — R47/R48: the regex is a second adjudicator (M2).** Red-proved
  rejections: no-port, no-password, IPv6, multi-host; and percent-encoded passwords
  are exported without decoding, so the script authenticates with the wrong password.
- **F12 Major — R34: four sibling scripts have the same argv exposure, undeferred.**
  `set-outbox-worker-password.sh:94`, `rls-cross-tenant-negative-test.sh` (10+),
  `migrate-prf-per-credential-salt.sh:20`.
- **F13 Minor — no mutual exclusion.** Two same-second runs share a directory name.
- **F14 Major [Adjacent] — `pg_restore` version skew makes the validator destroy a
  good archive (M6).**

## Testing Findings

Infrastructure re-derived: `vitest.config.ts:11-12` does include
`scripts/__tests__/**/*.test.mjs`; `ci.yml`'s `app:` filter includes `scripts/**`
and runs `npm run test:coverage`; `pre-pr.sh:36` mirrors it. That part of the plan
holds. `pg_dump`/`pg_restore`/`psql` are absent from the host and installed by no
workflow.

- **F-01 Critical — C5's adjudicator is unreachable under C9's stubbing (M6).**
  In Compose mode `pg_restore` is only reachable through `docker`, which C9 stubs.
  C5's three criteria would be decided by the stub's exit status. RT1 and RT5 both
  violated on the plan's most load-bearing invariant. Byte fixtures do not rescue it.
  Adjacent: this also undercuts VE1's cost-justification, which argued the two modes
  share validation code.
- **F-02 Critical — one exit code for every failure + exit-status-only criteria.**
  Deny tests cannot fail for the reason they claim; INV-C9a's "deleting any guard
  reds a test" is unachievable. The repo's own gates already emit stable identifiers
  (`FORBIDDEN:`, `ENV_POLLUTION_GUARD:`, `MISSING_GATE_SELFTEST:`, `EMPTY_SCAN:`).
- **F-03 Critical — RT11: default `BACKUP_DIR` is `${HOME}/passwd-sso-backups` and
  the pruner `rm -rf`s there.** No `HOME` override in the spawn env, no fixture-mode
  pollution guard. A test of default behaviour destroys the developer's real backups.
- **F-04 Major — gate table wrong (M1).** Two further rows belong:
  `check-gate-selftest-coverage.sh` scans `scripts/checks/` only, so nothing notices
  if `backup-db.test.mjs` is later deleted; `check-test-hygiene.sh` filters
  `\.test\.(ts|tsx)$`, so a `.test.mjs` self-test is outside the hygiene gates.
- **F-05 Major — nine forbidden patterns with no runner (M10).** INV-C4a
  (creation-time mode, not `chmod`) is only enforceable by source inspection; its
  behavioural criterion cannot distinguish the two implementations.
- **F-06 Major — INV-C6d unreachable (M8).**
- **F-07 Major — RT10: C6's symlink / non-matching-entry criteria have no defined
  candidate-count semantics and no paired real-directory deletion.**
- **F-08 Major — the `bash -x` criterion is unpassable as stated (M9).**
- **F-09 Major — VE classification incomplete.** C5's three criteria and C8's
  criterion are unverifiable in VE1, VE2 and VE3 alike. VE1's justification names a
  substitute ("a unit test … without executing it") that C9 does not build.
- **F-11 Major — `*.dump` gitignore blocks the fixtures (M3).**
- **F-10 Minor — the cited precedent stubs nothing.** `deploy-rollback.test.mjs` is
  the real PATH-stub harness; `set-outbox-worker-password.test.mjs` is the precedent
  for shelling out to an operator script with an allowlisted env. No shared helper
  exists (`scripts/__tests__/lib` absent).
- **F-12 Minor — C3's "exactly two files" omits MANIFEST; C4's `git check-ignore`
  criterion is red-before-green and unmarked.**
- **F-13 Minor — C3's derivation omits the connection-URL spelling** (`DB_URL:
  postgresql://…/jackson` at `docker-compose.yml:68`), so the promised drift alarm
  would miss a URL-only third database.

## Adjacent Findings

- Func F13 → Security: `set-outbox-worker-password.sh:93` puts the same variable's
  password in argv (taken up as Security F12).
- Func F5 → Testing: a check that cannot fail cannot be red-proved (taken up as
  Testing F-05/F-06).
- Func F14 → Testing: fixture committability (taken up as Testing F-11).
- Security F14 → Functionality: `pg_restore` availability/version skew (merged into M6).
- Testing F-08 → Security: argv-vs-environ reasoning (taken up as Security F3).
- Testing F-01 → Functionality: VE1's shared-validation-code justification.

## Quality Warnings

None. All three experts shipped reproducing commands with their claims; the
orchestrator independently re-verified M1, M6's host-binary premise, and the
absence of a `*.dump` gitignore rule.

## Recurring Issue Check

The three experts' per-rule status blocks are preserved in full in their raw
outputs. Consolidated non-`N/A` entries, by expert:

### Functionality expert
R1 F13 · R2 F11 · R3 F18 · R14 F12 · R16 Checked · R17 N/A · R18 F14 · R25 F15 ·
R27 Checked · R29 F1,F2,F3 (+8 claims verified correct) · R30 Checked · R31 F9,F17 ·
R33 Checked · R34 Checked · R35 Checked · R36 Checked · R37 Checked · R38 F8 ·
R39 Checked · R40 F6,F7 · R41 F4,F11 · R42 F1,F11 · R44 F3 · R47 F13 · R48 Checked ·
R49 F2,F3,F5,F9 · R50 F4 · R51 F10 · R53 Checked · R54 Checked · R55 F5 · R57 F9.
All other R-numbers: N/A with stated reason.

### Security expert
R1 F11/F12 · R2 Checked · R3 F12 · R14 F4 · R16 Checked · R18 F5 · R25 F2 ·
R29 F3 (rationale re-derived correct; probe reproduced) · R30 Checked · R31 F7,F8 ·
R33 Checked · R34 F12 · R35 Checked · R36 Checked · R37 Checked · R39 F3 ·
R40 Checked · R41 F6 · R42 F1,F3,F4,F10 · R43 Checked · R44 Checked · R47 F11 ·
R48 F11 · R49 F6,F8 · R50 Checked+Adjacent · R51 F8,F9 · R53 Checked · R54 F9 ·
R55 Checked · R57 F7 · RS1 N/A · RS2 N/A · RS3 F10,F11 · RS4 F5 · RS5 F1 · RS6 F11.
All other R-numbers: N/A with stated reason.

### Testing expert
R1 F-10 · R2 Checked · R3 Checked · R16 F-01 · R19 F-02 · R25 F-11 · R29 F-04,F-10 ·
R30 Checked · R31 F-03 · R33 Checked · R35 Checked · R36 Checked · R40 Checked ·
R41 F-05 · R42 F-04,F-13 · R44 F-02 · R45 Checked · R47 F-05 · R48 Checked ·
R49 F-01,F-05,F-06 · R50 F-01 · R51 Checked · R53 Checked · R54 Checked ·
R55 Checked · R57 Checked · RT1 F-01 · RT2 F-07,F-08 · RT3 Checked · RT4 N/A ·
RT5 F-01 · RT6 N/A · RT7 F-02,F-05,F-06 · RT8 F-02 · RT9 N/A · RT10 F-06,F-07,F-08 ·
RT11 F-03. All other R-numbers: N/A with stated reason.

## Orchestrator assessment

All 31 merged findings are accepted as valid. None is skipped, deferred, or
accepted-as-is, so no Anti-Deferral entries are required for round 1.

The five Criticals and the ten converged Majors are not independent defects: they
share three roots.

1. **The plan adjudicated predicates with the wrong authority.** A bash regex for a
   libpq URI (M2), an exit status for "is the service running" (Func F3), a byte
   count for "is this archive readable" (Func F5), a name for the object `rm`
   operates on (Sec F8), a name-enumeration for the gate member set (M1). Each is
   R47/R51 in a different costume.
2. **Controls were declared stronger than their mechanisms (M10).** Nine forbidden
   patterns with no runner, "enforceable boundary" for a convention, "schema-enforced"
   for `.gitignore`, and a guard whose branch cannot be reached (M8).
3. **The verification story was written before checking what the environment has.**
   No Postgres client on the host, `pg_restore` reachable only through the binary the
   test stubs, one exit code for every failure, and a default `BACKUP_DIR` the test
   harness would delete from (M6, Test F-02, F-03).

Round 2 revises the plan against all three roots rather than patching findings
individually.

---

# Plan Review: db-backup-script — Round 2
Date: 2026-08-03
Review round: 2

## Changes from Previous Round

Revision 2 restructured the plan against round 1's three roots: wrong adjudication
authority, overstated control classes, and an unverified environment premise. All
31 round-1 findings were addressed in the plan text.

## Totals

Functionality 18 new (3 Critical), Security 18 new (2 Critical, both escalate:true),
Testing 13 new (1 Critical). 49 new findings, 6 Critical.

Round-1 resolution across the three experts: 11 resolved / 6 partial / 1 regressed
(Functionality); 6 resolved / 7 partial / 1 partial+regressed (Security); 8 resolved /
4 partial / 1 not-resolved (Testing).

## The character of round 2

Every round-2 Critical was **red-proved by execution**, not argued:

| Claim in revision 2 | Measured result |
|---|---|
| `pg_restore --list /dev/stdin` validates the archive | `did not find magic string in file header`; without the filename, 33 lines / 18 non-comment entries |
| `PGSSLMODE` overrides the URL's `sslmode` | `PGSSLMODE=require` + `?sslmode=disable` connected in cleartext |
| `PGDATABASE` selects the second target in URL mode | URL path wins; only `?dbname=` works |
| `pg_dumpall --globals-only` carries database-level ACLs | 31 lines, all `CREATE ROLE`/`ALTER ROLE`; no `GRANT … ON DATABASE` |
| `flock -n` provides mutual exclusion | `flock(1)` is util-linux; absent on macOS, the declared primary operator host |
| CI has no Postgres client | `ci.yml:616-628` and `ci-integration.yml:140` already run bare `psql` |

Two Critical security findings are escalated:

- **S-01** — the TLS floor is adjudicated by a bash regex over a string libpq
  percent-decodes, and libpq gives an explicit URI parameter precedence over the
  environment. `?%73slmode=disable` defeats it. Round-1 F1 is not closed.
- **S-02** — the password strip's only rejection is "does not start with
  `postgres://`". When the narrow match does not fire on a URL that *does* carry a
  password, the full URL reaches `pg_dump -d` in `argv`. The declared invariant
  fails **open**, on the one component the plan says must never reach `argv`.

One regression was introduced by a round-1 fix:

- **S-04** — `!scripts/__tests__/fixtures/**` in `.gitignore` is last-match-wins and
  subtree-wide, so it un-ignores `.env`, `*.pem`, `*.key`, `*.p12` under that
  directory. The repo's own precedent (`.gitignore:98-101`) un-ignores two *named*
  files with a comment. The negation is also unnecessary — INV-C9f already renames
  fixtures to `*.pgdump`.

## Exit decision

Saturation (Common Rules, Step 1-6) is **not** met: Criticals and Majors are open.
The loop is exited early by explicit user decision, with the cost surfaced and
accepted: continuing to specify call shapes in prose costs a review round per wrong
shape and buys nothing the toolchain settles in seconds, while the architecture
(validate with the real reader, atomic publish, bounded prune, delegate URI meaning
to libpq) survived both rounds unchallenged.

Every open finding is carried into the plan's `## Carried-Forward Plan Findings`
section with an Anti-Deferral entry and the measured correction that settles it.
Phase 2 Step 2-1 reads that section.
