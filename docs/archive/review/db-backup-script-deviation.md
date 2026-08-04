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
**Closed in round 4.** Round 3 took the settling move this entry named — PATH
stubs for `ls`, `mount` and `df`, testing the parsing rather than the platform —
but every case it added stubbed a *succeeding* tool, so the branch where the tool
fails or is absent stayed both unfixed and unpinned. Round 4 found both helpers
folding "could not answer" into "verified clean", made them tri-state
(unsafe / verified safe / undetermined ⇒ `DEST_UNSAFE`), and added the failure
cases. Six mutants over the pair are killed, including the two that restore the
fail-open.

**[Test-12] Major — several guards are proven only by the source-level ERR_CODES
mirror, never behaviourally.** **Mostly closed in round 4.** The settling move
this entry named — the `BACKUP_DB_SCRIPT` seam from round-2 finding N-09 — is
implemented, and the sweep it enables ran: `BACKUP_DIR` newline rejection,
`COMPOSE_DB_SUPERUSER` form, the ancestor-writability branch and `RUN_VANISHED`
now have behavioural cases and their mutants die. Round 4 also measured five
guards this list did not name (authority newline, `gssencmode=disable`, the TLS
floor's POSITION, the collision-suffix naming, the dry-run `.pgpass` preview);
all five are pinned. `PRUNE_ABORTED` and `OLD_BASH` remain open — see the
round-4 residuals below for what each still needs.

The entry also understated the problem. The mirror fires only when a code stops
being emitted ANYWHERE, so a guard sharing its code with another site is
invisible to it: `RUN_VANISHED` has three emitters and deleting any one left the
other two, so no single deletion could red the mirror. "Proven by the mirror" was
never a weaker form of proof — for those guards it was none.

**[Test-10] Major — Group B's reader differs between local and CI.**
**Half closed in round 4**, and round 4 showed it was not the diagnosability gap
this entry described. Which reader is discovered *decided whether two test bodies
executed at all*: one delegating case early-returned whenever a host `pg_restore`
existed — the CI shape — so "144 passed" locally and in CI named two different
suites. That case is fixed (it uses the shared delegating stub, which works with
either reader). The resolved kind, path and version are now printed, and asserted
when `BACKUP_DB_EXPECT_READER` is set. Setting it in CI is the open half — see
the round-4 residuals.

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

## Round-4 residuals

**[Test] `PRUNE_ABORTED` and the device:inode re-verification are still not
individually pinned.** Open, and now measured rather than asserted: a sweep
through the `BACKUP_DB_SCRIPT` seam confirms that reverting
`assert_root_unchanged` from a device:inode comparison to a path-text one keeps
the suite green. Both need the same thing — a seam that substitutes the root at
a chosen point mid-run — which is the same unmet precondition round 3 recorded.
What would settle it: a `BACKUP_TEST_HOOK` invoked between publish and prune.

**[Test] `OLD_BASH` remains a source assertion, not a behavioural one.** The
branch is reachable only under an actual bash 2.x; `BASH_VERSINFO` is read-only,
so no stub can drive it. The case now says so in its name and asserts the
comparison reads the MAJOR element with a positive control, rather than reading
as behavioural coverage it does not have.

**[Ops] `BACKUP_DB_EXPECT_READER` is honoured by the suite but not set in CI.**
Group B now prints which reader it resolved and asserts the kind when the
variable is present, so the local/CI divergence is visible in the log. Setting
it in the workflow makes a runner image that drops `postgresql-client` a red
rather than a silent change of shape. Deferred as a separate change: it edits a
shared workflow and belongs with its own verification that the assertion fires
in CI, not only locally. Owner: the follow-up issue filed with this PR.

**[Sec-7 / R51 extension] The EXIT trap's removals stay outside
`assert_root_unchanged`.** The trap performs a rename and three removals — one
of them the credential file — that re-resolve `$BACKUP_ROOT` by name. Calling
`fail` from inside the trap re-enters cleanup, and a skip-on-mismatch would
leave the passfile on disk, which is the worse of the two outcomes. The comment
at the helper now names the three loops it actually governs and states the trap
is deliberately excluded, instead of claiming a completeness the code does not
have. Bounded by the same destination property as the recorded Sec-7 residual.

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
