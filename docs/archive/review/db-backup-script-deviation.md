# Coding Deviation Log: db-backup-script

## Deviations from the plan

**D1 — Group B lives in the default vitest project, not `vitest.integration.config.ts`.**
Round-2 finding N-06 recommended moving it, but that config's `include` is
`src/**/*.integration.test.ts` and does not reach `scripts/__tests__`. Moving Group
B there means widening a shared config, which changes what every integration run
executes. Kept in the default project; the reader is discovered (host `pg_restore`,
else the compose `db` service) and the delegating-stub cases return early with an
explicit assertion when neither is present, rather than silently skipping.

**D2 — no `postgresql-client` install step was added to CI.**
Round-2 finding N-05 established that VE3's premise was false: `ci.yml` and
`ci-integration.yml` already invoke bare `psql`, so the runner image ships the
client. Adding an install step would have been justified by a claim that does not
reproduce.

**D3 — the ancestor check is stricter than the plan described.**
The plan said "refuse any component writable by group/other and not owned by EUID
or root". Implemented as "refuse any component writable by group/other without the
sticky bit": ownership does not prevent a rename, write permission does, so the
EUID exemption would have admitted a directory the operator owns at 0777. This
refuses paths under a group-writable share — including this session's scratchpad —
which is the intended direction for a store of plaintext database dumps.

## Carried-forward findings not closed in Phase 2

Each entry follows the Anti-Deferral format: what is open, why it stays open, and
what would settle it.

**[Sec-8 / Func-F3] Major — `has_extended_acl` and `mount_is_unsafe` have no test.**
Skipped. The off-by-one in the ACL glob was fixed and verified by hand (a default
ACL now yields `DEST_UNSAFE`), but no automated case covers either helper.
Justification: a test would need `setfacl` on Linux and `chmod +a` on macOS, and a
mount-option fixture needs a mount — neither is available in CI, so the test would
either skip (reading as coverage) or red for environment reasons. What would settle
it: a fixture that fakes `ls -ld` / `mount` output through the same PATH-stub
mechanism the rest of Group A uses, testing the parsing rather than the platform.

**[Test-12] Major — several guards are proven only by the source-level ERR_CODES
mirror, never behaviourally.** Open: `BACKUP_DIR` newline rejection,
`COMPOSE_DB_SUPERUSER` form, the ancestor-writability branch, `PRUNE_ABORTED`,
`OLD_BASH`, `RUN_VANISHED`. Justification: each needs a fixture that is either
platform-specific (an old bash), destructive to construct (a mid-prune rename), or
unreachable without mutating the script. What would settle it: the script-path seam
(`BACKUP_DB_SCRIPT`, read only by the test) that round-2 finding N-09 proposed, so
mutants can be driven through the real harness.

**[Test-10] Major — Group B's reader differs between local and CI.**
Open. Locally it resolves to the compose `db` service; in CI to the runner's host
binary. The suite asserts the major version is ≥ 16 but does not record which
implementation ran. What would settle it: printing the resolved reader and its
version, and pinning the CI client's major version.

**[Sec-7 / R51] Major — the pre-`rm` re-verification narrows the window, it does not
close it.** The check now compares device:inode rather than path text, so a
rename-and-recreate is detected. A swap between that comparison and `rm`'s own
resolution remains possible in principle. Justification: closing it needs
descriptor-relative removal (`openat`/`unlinkat`), which bash does not expose.
What would settle it: reimplementing the pruner in `.mjs`, or accepting the residual
explicitly — which the destination-safety check (owner-exclusive, sticky-bit-guarded
ancestors) is what bounds today.

**[SC5] `check-doc-paths.mjs` is still not wired into `pre-pr.sh`.**
Unchanged from the plan. The documentation references are asserted by the test suite
instead, which is stronger for this change and weaker for nothing.

**[SC6] The `$MIGRATION_DATABASE_URL` credential-egress class is not closed for the
four sibling scripts.** Unchanged from the plan, and round 2 widened the class
description: `set-outbox-worker-password.sh:81` echoes the whole URL to stderr on
its `DRY_RUN` path, which is a wider egress than argv. Owner: a follow-up issue, to
be filed with this PR.

## Round-3 residuals

**[Test] The `PRUNE_ABORTED` branch is not individually pinned.** Skipped. A root
replaced mid-run is caught by whichever check the swap lands in front of — the
archive redirect, the publish, or `assert_root_unchanged` — and racing for one of
them produced a flaky test. The committed case asserts the outcome instead: the
run does not succeed and leaves nothing published in the substituted directory.
What would settle it: a seam that lets a stub trigger the swap at a chosen point
(for example a `BACKUP_TEST_HOOK` invoked between publish and prune) so the
branch is reachable deterministically.

**[Test] `BACKUP_FAILED_MAX_AGE_DAYS=0` means "older than 24 h", not "keep none".**
Accepted, not changed. `find -mtime +0` is "at least one day", which is find's
documented behaviour; special-casing 0 to mean immediate removal would make this
script's meaning differ from every other `-mtime` a reader knows. The usage
header states it explicitly.

**[Ops] The destination check runs after the Compose connectivity preflight.**
Skipped. An unsafe destination is therefore only reported once the database is
reachable, which is the wrong order for a safety property. Moving it is a
three-line change with no dependencies, but this branch has produced four
defects from reordering (the passfile before `BACKUP_ROOT` existed, the sweep
before the dry-run exit, the sweep after the passfile, the MANIFEST before both
`verify_transport` and the cluster reconciliation), and the cost of a fifth
outweighs the diagnostic improvement. What would settle it: doing it as its own
change, with the ordering asserted by a test rather than by reading.
