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
five sibling scripts.** Unchanged from the plan, and round 2 widened the class
description: `set-outbox-worker-password.sh:81` echoes the whole URL to stderr on
its `DRY_RUN` path, which is a wider egress than argv. Owner: issue #756, filed with PR #755.

**[SC7] `psql -X` is applied in this script and not in its siblings.** Round 6
(F4/S3) established the class and round 7 measured its worst member:
`scripts/rls-cross-tenant-negative-test.sh` decides whether the RLS check PASSED
from a SUBSTRING of psql's output, so `\echo [E-RLS-MANIFEST-EXTRA]` in
`~/.psqlrc` forges a pass without the database being asked anything. The three
`set-*-password.sh` scripts connect as a superuser and execute `~/.psqlrc` as
SQL.

The member set, derived rather than counted — round 7 found this entry said
"five siblings" and then named four:

```
for f in scripts/*.sh; do
  grep -qE '(^|[^a-z_])psql ' "$f" && printf '%s\n' "$f"
done
```

Five members: `rls-cross-tenant-negative-test.sh`,
`set-audit-anchor-publisher-password.sh`, `set-outbox-worker-password.sh`,
`set-retention-gc-worker-password.sh`, and **`migrate-prf-per-credential-salt.sh`**
— which the earlier text omitted, and which is also the fifth SC6 member: line
20 puts `"$MIGRATION_DATABASE_URL"`, password included, straight onto psql's
argv. `scripts/pre-pr.sh:358` invokes psql without `-X` and is NOT a member: it
runs through `docker exec` into the db container, where the operator's
`~/.psqlrc` does not exist.

Not fixed here, by decision: the fix touches five files this branch's diff does
not otherwise reach, and it widens what the remaining review round must cover.
Worst case: a compromised or careless `~/.psqlrc` turns a security regression
test green, or runs attacker SQL as a superuser. Likelihood: low — it needs write
access to the operator's home, which is already most of the game. Cost-to-fix:
one flag per invocation across five scripts, plus a test per script that the flag
is present. Owner: issue #756, the same as SC6.

## Round-7 residuals

**[Ops] Three of the destination check's arms are proven against FIXTURES, not
against the thing they describe.** Named in the round-7 approval, and true: the
FUSE `user_id=` refusal, the `idmapped` member, and the whole macOS `df` +
`mount(8)` path are driven by hand-written tables and PATH stubs. What that
proves is the READER — that these bytes produce that verdict. What it does not
prove is that the kernel and `mount(8)` emit those bytes.

Worst case, per arm. FUSE: if a real `fuse.gocryptfs` line spells the owner
differently from `user_id=<uid>`, the operator's own encrypted volume is refused
and they need `BACKUP_ALLOW_UNVERIFIED_MOUNT` — a false deny on the medium both
operator documents prescribe. `idmapped`: the option is already recorded as
defensive, and an id-mapped mount needs `CAP_SYS_ADMIN`, so it is outside this
reader's threat model either way. macOS: the shapes came from the verification
host's real `mount` and `df -P` output and are quoted verbatim in the cases, so
the fixtures are transcriptions rather than inventions — but no case runs
against a live macFUSE mount.

Likelihood of the FUSE arm being wrong: low. `user_id=` is what
`fs/fuse/inode.c` writes into the super options and what this host's own FUSE
mounts print. Cost-to-fix: one gocryptfs mount on the verification host, one
`cat /proc/self/mountinfo`, and the line pasted into the case as a transcription
like the macOS ones. What would settle it: exactly that — the arms stay as they
are, and the fixture gains a provenance comment naming the host and date it was
copied from, which is the standard the macOS cases already meet and the FUSE and
idmapped cases do not.

**[Ops] A forged mount line is still a DENIAL, and an unprivileged user can
cause one.** On the text path (macOS) a line injected through `-o fsname=` that
claims the mount point `df` named now collides with the real entry for it, and
two claims are an unattributable table rather than a verdict. So the spoof is
closed and a fail-closed denial takes its place: any local user can make the
destination check undetermined and stop the scheduled backup until the operator
removes the mount or sets `BACKUP_ALLOW_UNVERIFIED_MOUNT`, which is the weaker
state. Worst case: backups stop, or run with the mount check disabled.
Likelihood: low — it needs a local account on the backup host. Cost-to-fix: not
payable from a shell; it needs a per-mount structured table, which macOS does
not expose to one. Bounded by: the same direction as every other verdict here —
an unanswered check is not a passed check.

**[Ops] On Linux the reader descends the mount TREE, and the rule is
order-independent by construction.** Recorded because the first two spellings
were both wrong and the reason is not obvious. Longest covering mount point is
wrong: `/backup/sub` mounted before `/backup` is hidden by it, and the hidden
child's mount point is the longer string — measured reporting a destination on
exFAT as verified safe. "Last among siblings" is wrong for a subtler reason:
mountinfo's order is not a promise about visibility, so the same tree listed the
other way round flips the verdict. What is used instead is a deduction from the
tree: two children of one parent can only stand in a prefix relation if the
shorter was mounted last, because otherwise the longer would have landed inside
it and be its child rather than its sibling. Both orderings are committed cases,
as is the paired allow case where the child is NOT hidden and must answer.

**[Ops] The two stat(2)-only designs do not work on macOS, and the measurement
is recorded so they are not proposed again.** Both were tried first, on the
verification host (Darwin 25.5.0). Walking ancestors while `st_dev` is unchanged
runs to `/`: every ancestor of a `/private/var` destination reports the DATA
volume's `st_dev`, and so does `/`, whose `mount` line describes the sealed,
read-only SYSTEM volume — the walk would adjudicate the wrong filesystem.
Selecting lines by `st_dev` has the same cause and matches two of them, `/` and
`/System/Volumes/Data`, so every macOS run would be undetermined. `df -P` names
`/System/Volumes/Data`, which is the filesystem the backup actually lands on,
and it is the only structured answer a shell gets there. Note that df's answer
is NOT an ancestor of the destination path on that platform, so no
prefix-relationship check may be added between the two.

## Round-6 residuals

**[Ops] The mount table is parsed from `mount(8)`'s human-readable output, and
an ambiguous line now refuses rather than being attributed.** **Superseded in
round 7 — the ambiguity check was necessary and not sufficient.** The user's
review pass showed that a newline in `-o fsname=` injects a WHOLE line, and that
every fragment can be made well-formed: the leading one is the attacker's to
spell and the trailing one gets ` on <their own mount point> (…)` appended by
mount(8) itself, so the injected middle line carries exactly one of each
separator and no per-line parse can see it. Measured: adopted as the
destination's filesystem and reported verified safe. Settled as this entry
named for Linux — `/proc/self/mountinfo`, whose `\040 \011 \012 \134` escaping
makes the input unrepresentable — and on macOS by taking WHICH line answers
from `df -P`'s `f_mntonname` rather than from the table, then requiring exactly
one line to claim it. See the round-7 residual for what that leaves.


Round 6 returned **42 findings (4 Critical, 22 Major)** across the three
perspectives. The four Criticals and six Majors were fixed; the rest are open
and listed here so the next round starts from a true statement of what is done.

**[Test] `assert_mode_private "$PGPASS_FILE"` runs before the write, but nothing
pins the ORDER.** **Closed in round 7**, by exactly the instrument this entry
named: a `stat` stub that records `wc -c` of the passfile when asked for its
mode, asserting 0. The mutant that makes the file non-empty at check time dies.

**[Test] Twelve Major coverage gaps are open, each with a named seam.**
**All twelve closed in round 7**, each with a mutant that dies. Two of them
turned out to be more than coverage:

- The compose-mode `psql` stub had no arm at all, so the cluster enumeration
  failed silently in EVERY compose case and the whole reconciliation block —
  the row validation, the malformed-row `break`, the unlisted-database
  reporting — was reachable by nothing. It has fixtures now, in both
  directions.
- The `.partial` stamp-collision arm is unreachable on the ordinary path:
  `prune_orphaned_partials` runs under the lock and removes every `.partial`
  BEFORE the stamp is chosen. That is why nothing exercised it. What reaches it
  is the sweep not succeeding — its removal is best-effort — so the case drives
  it through an `rm` that fails, which is the situation the arm exists for.

The remaining ten were coverage as described: both halves of the `077` mask at
both sites that spell it, `first_line` at `achieved_tls` including the CR arm,
the row-charset guard with an EVEN-length non-hex payload, the malformed-row
`break`, the `.FAILED` arm, the empty enumeration, the port anchoring, the
member sets now READ OUT of the script rather than copied beside it, and the
query refusal list derived from the script's own case arms.

**[Test] `PRUNE_ABORTED`'s second emitter — the seam is now named.** **Closed in
round 7** with exactly that instrument: an `rm` stub that exits non-zero for one
generation name and delegates everything else. Replacing the clause with
`|| true` now reds. Open across rounds 3, 4, 5 and 6; the seam was available the
whole time, and each round's entry named a harder one.

**[Process] A review ran against a moving tree.** The Testing expert's sweep was
in flight when this session committed `f5eb6770d` and left further uncommitted
edits in the same worktree. It detected the change, discarded fifteen verdicts,
rebuilt a frozen mirror of `b377b642d` and re-ran them there. The findings
survived; the cost was ~80 minutes and it was avoidable. Editing the subject
while an agent reviews it invalidates its instrument.

## Round-5 residuals

**[Ops] A mount whose device AND mount point both contain a space is
undetermined.** **Closed in round 7, by a different move than this entry
proposed.** It named "matching by longest mount-point prefix over `mount`'s own
output and dropping `df` entirely" — which round 6 did, and which is exactly
what the newline injection then defeated, because a table nobody can attribute
cannot be made attributable by a better prefix rule. What closed it instead was
keeping df for one thing only: the mount point of the PATH, taken as the whole
field after the capacity column rather than with `##* `, so a space in it is an
ordinary byte; and matching a line on its own mount point, so the device column
is never a key at all. Both measured shapes from that host — `map auto_home on
…` and `/dev/disk5s1 on /Volumes/Backups of mrx33 (apfs, …)` — now resolve, and
the second is a committed test case.

**[Ops] macOS cannot verify an encrypting FUSE backend, by design.** macFUSE
reports the generic type `macfuse` for every backend it carries, so the mount
table cannot distinguish gocryptfs from s3fs — verified on the host with both
line shapes. Allowlisting `macfuse` would admit s3fs on the identical line, so
the script refuses and names `BACKUP_ALLOW_UNVERIFIED_MOUNT` in the message.
Both operator documents state it. The Linux spellings are on the allowlist and
need no flag. What would settle it: identifying the backend from the device
field (`gocryptfs@/path`), which a mount can spell however it likes — a
heuristic, not a verification, which is why it was not taken.


**[Test] `PRUNE_ABORTED`'s second emitter is still unpinned.** The
root-identity branch is now driven behaviourally (a `stat` PATH stub that flips
device:inode once the dump has run), but `( cd … && rm -rf ) || fail
PRUNE_ABORTED "could not remove generation"` has no case: replacing that clause
with `|| true` keeps the suite green. What would settle it: an `rm` stub, or a
root chmod-ed 0500 between the publish and the prune.

**[Ops] `BACKUP_ALLOW_UNVERIFIED_MOUNT` widens what the destination check
accepts, by operator decision.** Recorded because it is a boundary the plan did
not have. Worst case: an operator sets it, points `BACKUP_DIR` at exFAT, and the
plaintext corpus lands somewhere mode bits do not bind — the exposure SC3
already names, reached one step earlier. Likelihood: low; it is off by default,
the refusal message names it, and using it requires reading that message.
Cost-to-fix if it proves wrong: one line, plus the two documents. Chosen over the
alternative because round 5 measured the opposite failure — a blanket `fuse.*`
refusal denied gocryptfs and veracrypt, the media both operator documents
prescribe, with no way for the operator to proceed at all. A guard that stops the
only backup path is not a safe default.

**[Ops] The allowlist is a member set that will need extending.** `ext2 ext3
ext4 xfs btrfs zfs f2fs jfs reiserfs apfs hfs hfsplus ufs tmpfs overlay` plus
five encrypting FUSE backends. A legitimate filesystem outside it stops the run
until the operator sets the flag or the list grows. This is the deliberate
direction — a denylist answered "safe" for every type nobody enumerated, and
round 5 measured prl_fs, vmhgfs, ceph, glusterfs, lustre, beegfs, afs, udf and
iso9660 passing it.

## Round-4 residuals

**[Test] `PRUNE_ABORTED` and the device:inode re-verification are still not
individually pinned.** **Closed in round 5, and this entry's stated reason was
wrong.** It claimed both needed "a `BACKUP_TEST_HOOK` invoked between publish and
prune". They did not: `stat_ident` shells out to a PATH-resolved `stat`, which
the suite already stubs in five other cases, so a stub that flips device:inode
once a marker appears drives the branch with no production change. The
precondition was never checked before it was written down — the same defect
shape as the findings the entry was recording.

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
in CI, not only locally. Owner: issue #756.

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
