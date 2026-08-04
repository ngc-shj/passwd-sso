# Code Review: db-backup-script
Date: 2026-08-04
Review rounds: 3 (sub-agent), plus 4 external review passes interleaved

**Recorded late.** Step 3-4 requires each round's findings to land here. Rounds 1
to 3 were run and acted on, but the artifact was never written — the findings
lived only in commit messages. This file reconstructs them from the round
outputs. Treat the per-round finding text as a faithful summary rather than the
experts' verbatim prose, which was not preserved; the identifiers, severities,
evidence and dispositions are exact.

## Changes from Previous Round

Initial code review follows Phase 2's self-R-check, which had already fixed five
defects (two Critical) that a 60/60-green suite had been hiding.

## Convergence map

| Subject | Func | Sec | Test | Round |
|---|---|---|---|---|
| Credential reaches `pg_dump` argv | F13 | F-01, F-02, F-03 | — | 1, 2 |
| TLS floor defeated | — | F-01, F-02 | — | 1, 2 |
| Database-level ACLs lost on restore | F5 | F4 | — | 1 |
| Lock wedge / lock race | F2 | F-05, N1 | T3 | 1, 2, 3 |
| `.partial` / `.FAILED` unbounded | F3 | F-05, F-09 | — | 1, 2 |
| Stamp collision nests the run | F4 | — | T2 | 1, 3 |
| Suite cannot fail for the reason it claims | — | — | F1, F2, T1, T2 | 2, 3 |
| Destination guards unpinned | — | — | F5, T5 | 2, 3 |

---

# Round 1

## Changes from Previous Round

Initial review of the branch.

## Functionality Findings

14 findings (4 Major). The load-bearing ones:

- **F1 [Critical]** Whitespace-only `BACKUP_DATABASES` published a generation
  containing no database at all and exited 0 — the empty check stripped spaces
  while the loop split on `IFS`.
- **F2 [Major]** A hard-killed run left `.lock.d` forever; every later run,
  including a dry run, failed `LOCKED`. The pid was written and never read.
- **F3 [Major]** An orphaned `<stamp>.partial` matched neither pruner and
  accumulated without bound — a full plaintext corpus per hard kill.
- **F4 [Major]** `mv partial final` with `final` existing nests instead of
  failing, so a stamp collision printed "published" and then `RUN_VANISHED`
  while the pruner operated on the wrong generation.
- **F5 [Major]** `dev-host-migration.md` step 5 restored without `--create`, and
  `--create` cannot be used against an initdb-created database, so the
  database-level ACLs the dump captures were never applied. The migrated host
  silently regained `PUBLIC` `CONNECT`.
- **F6 [Major]** `INTERRUPTED` always reported "signal 2", including for SIGTERM.
- F7–F14 Minor: macOS `noowners` dead-end, no cluster enumeration, mode/target
  never logged, `.FAILED` retention hardcoded, no mode read-back, no digest,
  incident-runbook ordering, URL mode undocumented.

## Security Findings

7 findings, 1 Critical (escalated).

- **F-01 [Critical, escalate: true]** A raw `/`, `?` or `#` in the userinfo made
  the password strip fall through: the whole URL, password included, reached
  `pg_dump`'s argv and the MANIFEST. The `?` spelling additionally destroyed the
  TLS floor — verified connecting in cleartext against the live cluster.
- **F-02 [Major]** `gssencmode`, `dbname` and `sslrootcert` were matched over the
  raw URL while libpq percent-decodes keywords, so `?%67ssencmode=require` passed
  and superseded the floor.
- **F-03 [Major]** `host=` / `hostaddr=` were not refused: they redirect the peer
  while the MANIFEST records the authority, and the wildcard pgpass entry offered
  the superuser password to the redirect target.
- **F-04 [Major]** Only INT/TERM were trapped, so SIGQUIT/SIGPIPE/SIGHUP left the
  superuser password on disk under an undeclared `$TMPDIR`.
- **F-05 [Major]** A killed run wedged all future backups; `.partial` orphans
  accumulated.
- **F-06 [Major]** The ancestor walk admitted a sticky directory owned by another
  principal, who can rename the audited root.
- **F-07 [Major]** `BACKUP_ALLOW_IN_REPO=true` left `globals.sql` and `MANIFEST`
  un-ignored by git and inside the Docker build context.
- F-08, F-09 Minor: `prune_failed` had no inode re-verification; `.FAILED` had no
  age bound.

## Testing Findings

17 findings, 2 Critical. **Mutation sweep: 51 of 74 mutants survived — a 31%
kill rate.** Nearly every guard the review rounds had added could be deleted with
the suite green.

- **F1 [Critical]** The two delegating-reader cases early-return whenever a host
  `pg_restore` exists — the CI shape — so the `--list /dev/stdin` regression was
  uncaught exactly where the suite is authoritative.
- **F2 [Critical]** The globals case asserted fixture content only; no script
  defect could red it.
- **F10 [Critical]** One sentinel password containing none of `:` `\` `/` `?` `#`
  `%` or a newline left eleven credential guards unpinned.
- F3–F9, F11–F17 Major/Minor: compose-mode flags unpinned, masked dump-guard
  pair, ACL/mount deferral was a disguised skip, the `ERR_CODES` mirror only
  fires on the last emission site, forbidden patterns miss the script's own
  spellings, `.gitignore` half untested.

## Adjacent Findings

- Func F13 → Security: `set-outbox-worker-password.sh:93` passes the same
  variable to `psql` in argv (taken up as SC6).
- Test F1 → Functionality: VE1's "the two modes share validation code"
  justification does not hold once the reader differs per mode.

## Quality Warnings

None. All three experts shipped reproducing commands.

## Resolution Status — Round 1

All Critical and Major findings fixed in `a04ccc5eb` and `88a9da80d`. Four of the
fixes were themselves wrong and were corrected in round 2 — see below.

## Environment Verification Report

- C1, C2, C3, C4, C6, C7, C8 — `verified-CI` (Group A, stubbed).
- C5 — `verified-local` via the compose reader; `verified-CI` unproven, see
  Test F1.
- URL mode end-to-end against RDS — `blocked-deferred`, linked to VE1 in the plan
  and to the deviation log's D2.

---

# Round 2

## Changes from Previous Round

The round-1 fixes landed. Four of them were wrong.

**The security expert died mid-run with an API error, so this round has no
security coverage.** Round 3 was run as a full security review rather than an
incremental one to compensate.

## Functionality Findings

17 findings, 4 High.

- **N1 [High]** The lock reclaim was fail-**open**: `mkdir` and the pid write are
  not atomic together, so a run arriving in that window saw a lock with no pid,
  called the holder dead, and both proceeded — and the loser's cleanup removed
  the winner's lock.
- **N2 [High]** The passfile was relocated into `$BACKUP_ROOT` for the SIGKILL
  case and then no sweeper covered that namespace, so the superuser password sat
  in the directory the runbook says to hand-carry.
- **N3 [High]** The `.FAILED` rename still nested: the no-clobber check was
  applied at one of two `mv` sites.
- **N4 [High]** `${BACKUP_DATABASES%% *}` splits on space while the validating
  loop splits on `IFS`; a tab-separated value reached libpq unsplit, and a
  leading space produced an empty `dbname`, which libpq resolves to the role name.
- **N6 [Medium]** `achieved_tls` was always `unknown` — the MANIFEST group ran
  before `verify_transport`.
- N5, N7–N17: `verify_transport` discards libpq's diagnostic, no cluster
  enumeration, URL mode undocumented, macOS dead-end, stamp-retry identity, mode
  never logged, no digest, `.FAILED` retention, no mode read-back, dry-run
  preview scope.

## Security Findings

None recorded — the expert terminated with an API error before producing output.

## Testing Findings

17 findings, 4 Critical. Kill rate unchanged at 31% at the start of the round.

- **F1, F2 [Critical]** carried from round 1, unfixed.
- **F9 [Critical]** `achieved_tls` never populated and no test reads the URL-mode
  MANIFEST; deleting the whole transport probe left the suite green.
- **F10 [Critical]** The single sentinel left eleven guards unpinned.
- F3–F8, F11–F17: compose flags, masked guard pair, ACL deferral, `ERR_CODES`
  mirror strength, forbidden-pattern reach, `.gitignore` untested, passfile
  properties asserted nowhere, lock metadata planted rather than observed.

## Resolution Status — Round 2

Fixed in `88a9da80d` and `b1c818f97`. The suite grew 67 → 88 cases and the kill
rate moved 31% → 71%. Three claims made in that commit were later found false
(see round 3, T2/T8/T9).

---

# Round 3

## Changes from Previous Round

Run with all three perspectives. Security had no round-2 coverage, so it ran as a
full review. **Security returned no Critical for the first time on this branch.**

## Functionality Findings

14 findings, 4 Major.

- **F1 [Major]** The dry run never previewed the `.FAILED` deletions the same run
  performs — a regression introduced by the round-2 fix, which turned an inert
  `keep=1` post-publication step into an age- and count-bounded sweep before
  every dump.
- **F2 [Major]** `verify_transport` discards libpq's diagnostic and reuses
  `DUMP_FAILED`, so a missing CA, a wrong host, a rejected password and a server
  with TLS off are one indistinguishable line on the RDS path.
- **F3 [Major]** URL mode entirely undocumented; the client and CA preflight
  precede the dry-run exit, so a preview cannot preview.
- **F4 [Major]** Cluster databases outside `BACKUP_DATABASES` silently not backed
  up, with no signal in the MANIFEST.
- F5–F14 Minor: `assert_root_unchanged` missing from the `.pgpass` sweep,
  `BACKUP_FAILED_MAX_AGE_DAYS=0` semantics, no mode read-back, mode never logged,
  macOS remedy absent from the message, stamp exhaustion reports `INTERNAL`, the
  published justification for the lock wedge misdescribes the removed code,
  `mount_is_unsafe` matches anywhere in the mount line, `\restrict` client floor,
  plan scenario 4 stale.

## Security Findings

7 findings, 1 Major, no Critical.

- **F-1 [Major]** The `.pgpass` newline refusal and the `:`/`\` escaping were
  scoped to the password field; the host slice reached the same line-oriented
  file unvalidated. `postgres://u:pw@dbhost\n*` injected a second `.pgpass` line
  and split the MANIFEST; the legal socket form `postgres://u:pw@/db` produced an
  empty host that `${:-*}` turned into the wildcard entry the narrowing exists to
  prevent.
- **F-2 [Minor]** The `.dockerignore` glob translator mapped `[!x]` to a negated
  class, citing Go's `filepath.Match`. Docker does not use `filepath.Match` here:
  moby's patternmatcher copies the class verbatim into a Go regexp, where `!` is
  an ordinary member. Verified against a real `docker build` — a fail-open in the
  gate whose only job is faithfulness.
- **F-3 [Minor]** The relaxed stamp regex applied the optional `.<pid>` to the
  empty suffix, so a stray `<stamp>.<digits>` counted as a published generation
  and pushed a real one out of the retention window.
- **F-4 [Minor]** The age prune's `find -maxdepth 1` includes depth 0, so the
  root's own mtime could satisfy the bound for a fresh corpus.
- F-5, F-6, F-7 Minor: `assert_root_unchanged` absent from two removal paths and
  stat'ing the wrong path; the in-repo guard fail-open when git is unavailable;
  plaintext dumps left in `/tmp` by earlier rounds.

## Testing Findings

11 findings, 2 Critical. **Kill rate 31% → 71%** (87 of 122 mutants killed).

- **T1 [Critical]** The delegating-reader cases still early-return under a host
  `pg_restore`. Proven: with a host reader on PATH, the `--list /dev/stdin`
  mutant left the suite 97/97 green; under the compose reader the same mutant is
  killed, and those two cases are the only killers.
- **T2 [Critical]** The no-clobber publish case passes on the stamp-retry guard
  it never gets past — both emit `INTERNAL`, so a code-only assertion cannot tell
  them apart, and the publish guard itself survives deletion.
- T3–T11 Major/Minor: lock verdicts interchangeable, destination guards
  unpinned, root-identity class unpinned, credential-sink member set omits
  published artifacts, collision-form name pinned on the consuming side only,
  ignore rules missing a representative path, MANIFEST fields unpinned.

## Adjacent Findings

- Func F5 / Sec F-5 converge on `assert_root_unchanged`'s member set.
- Sec F-7 → operations: real dumps left in `/tmp` and `$HOME` by review rounds.

## Quality Warnings

None.

## Resolution Status — Round 3

Fixed in `66b2f685c` and `882f41c1a`. Three residuals recorded in the deviation
log rather than closed:

- The `PRUNE_ABORTED` branch is pinned by outcome, not by branch.
- `BACKUP_FAILED_MAX_AGE_DAYS=0` keeps `find`'s documented `-mtime` meaning.
- The destination check still runs after the connectivity preflight.

## Environment Verification Report

Contracts declaring `Verification environment constraints` in Phase 1:

- **VE1 (no RDS reachable)** — URL mode end-to-end remains `blocked-deferred`.
  Linked to the plan's VE1 entry and to deviation-log D2. Substituted by URL-mode
  runs against the local cluster over TCP with stubbed and real clients.
- **VE2 (Compose local)** — `verified-local`: the script was executed end to end
  against the dev stack in every round; MANIFEST, modes and retention inspected.
- **VE3 (CI has no Postgres server)** — corrected in round 2: CI *does* ship a
  Postgres client (`ci.yml` runs bare `psql`). Group B's reader therefore differs
  between local (compose) and CI (host), which is finding T1's subject.

---

# Round 4

## Changes from Previous Round

All three perspectives, run against the round-3 fixes. Ollama was down, so Step
3-2's seed generation fell back to full-diff review and the merge was manual.
32 findings after dedup: **1 Critical, 17 Major, 12 Minor** — a higher count than
round 3, because the round-3 fixes introduced five of them and because the
testing sweep was run independently rather than re-derived from the previous
round's numbers.

## Functionality Findings

11 findings, 5 Major.

- **F1 [Major]** The cluster reconciliation decided membership with
  `case " $BACKUP_DATABASES "` — a space-only split — while every other consumer
  splits on `IFS`. A tab-separated list made the MANIFEST report both databases
  it had just dumped as not backed up. Re-introduced the class `88a9da80d` fixed
  for `${BACKUP_DATABASES%% *}`.
- **F2 [Major]** A failed enumeration was recorded as `not_backed_up: (none)` —
  the all-clear sentinel — with no warning. `(none)` is a legitimate value of the
  field's own domain (R55), so no consumer could distinguish "nothing was left
  out" from "we could not tell".
- **F3 [Major]** `list_stamped` read candidates with `ls -1` instead of INV-C6e's
  mandated `find -print0`, an undeclared deviation. A directory whose name
  contains a newline is emitted as two lines; when both halves look like
  generations the pruner deletes one MORE validated generation than
  `BACKUP_RETAIN` permits. Red-proved.
- **F4 [Major]** The in-repo guard wrote git's stderr to `/tmp/.backup-db-git-err.$$`
  — predictable, world-writable, symlink-followable, and before `umask 077`.
  Converges with Sec S1.
- **F5 [Major]** `mount_is_unsafe` kept two filesystem lists differing by six
  members, and on macOS — the platform the guard exists for — only the shorter
  one is ever consulted.
- **F6 [Minor]** The port anchoring added for `5432evil` also rejected the legal
  libpq empty-port form `postgres://u:pw@host:/db`, and named an empty value in
  the error.
- F7–F11 Minor: achieved-mode read-back covered 1 of 3 run-directory members; a
  `.gitignore` comment contradicted the rule three lines below it; a section
  banner sat over an empty block; a failed lock-metadata write wedged the
  destination permanently; the INV-C2a mode/target log line ran after
  `verify_transport`, so `CONNECT_FAILED` still printed without it.

## Security Findings

5 findings, 3 Major, no Critical (second round with none).

- **S1 [Major]** The `/tmp` write is a symlink-follow write primitive against the
  operator. Red-proved by pid spray: the victim file was truncated and
  overwritten with git's stderr on the fourth attempt. **Introduced by the
  round-3 fix** that tightened the same guard to fail closed — confirmed with
  `git log -L`.
- **S2 [Major]** The filesystem member set missed the whole Linux `fuse.*` family
  and every VM-share type. `fuse.s3fs` / `fuse.rclone` mean the corpus is written
  unencrypted to a remote store. The declared member `sshfs` was dead on both
  platforms: prefixed on Linux, no `type` field on macOS.
- **S3 [Major]** `has_extended_acl` and `mount_is_unsafe` failed **open** when
  their tool failed or was absent — the exact class `882f41c1a` closed for the
  sibling in-repo guard in the same commit. macOS keeps `mount` in `/sbin`, which
  cron's default PATH omits.
- **S4 [Minor]** `assert_root_unchanged`'s "one place, so a future removal loop
  cannot be added without it" claim omits the EXIT trap's four removal sites, one
  of which deletes the credential.
- **S5 [Minor]** Converges with Func F1.

## Testing Findings

14 findings, 1 Critical, 10 Major.

- **T1 [Critical]** The Group B truncated-archive case executed **zero**
  assertions whenever a host `pg_restore` exists — i.e. always, in CI. The
  round-3 fix for exactly this shape landed on its twin and not on this one
  (RT9 twin drift inside the test file). Red-proved with a tripwire in both
  environment shapes.
- **T2 [Major]** The URL-mode preflight filtered `pgsql` out of the inherited
  PATH, which does not remove `/usr/bin` where a Debian runner keeps
  `pg_restore`; every assertion sat inside an `if` that then skipped.
- **T3 [Major]** Independent mutation sweep: **25 of 50 non-equivalent mutants
  survived**. The claimed 71% reproduces only for *deletion* mutants (68.8% on
  32); against *weakening* mutants that keep the `fail <CODE>` token the rate was
  **0/10**. Eleven unpinned guards beyond the six `[Test-12]` lists.
- **T4 [Major]** `expect(lastIndexOf(a)).toBeGreaterThan(indexOf(b))` is
  satisfied when `b` is missing, because `indexOf` returns −1. A conninfo builder
  that dropped the operator's whole query (including `sslrootcert=`) and put the
  floor first kept the suite green.
- **T5 [Major]** The achieved-mode case asserted the two `stat_mode`
  ASSIGNMENTS in the source text; deleting the refusals left it green, and it
  carried no positive control.
- **T6 [Major]** "names a collided failure" never produced a collision, and its
  regex made the `.<pid>` group optional. The pre-`c02762c8f` naming defect
  survived.
- **T7 [Major]** Two of four forbidden-pattern scans had no paired positive
  control, violating INV-C9d.
- **T8 [Major]** No test exercised lock contention: the "concurrency" case
  pre-creates a stale lock, so both runs take the existing-lock branch and
  neither races for a free one. A non-atomic test-then-create acquire survived.
- **T9 [Major]** The C8 documentation cases are unreachable on a docs-only PR —
  neither `ci.yml`'s `app` filter nor `pre-pr.sh`'s `app_paths` includes
  `docs/**`, and SC5's justification for not wiring `check-doc-paths.mjs` rests
  on those cases running.
- T10–T14: reader identity unrecorded (and load-bearing, per T1); a 5089 ms case
  under the 10 s default timeout in a batch that already produced expiries; a
  non-boundary-adjacent allow case; the default `BACKUP_DIR` never exercised; the
  sentinel literal duplicated.

## Adjacent Findings

- Func F4 → Security: converges with S1 (the `/tmp` write).
- Func F5 → Security: converges with S2/S3 (the mount member set).
- Sec S5 → Functionality: converges with F1 (the membership split).
- Test T4 → Security: the surviving mutants are transport-floor behaviour
  changes; the finding itself is the vacuous assertion.

## Quality Warnings

None. All three experts shipped reproducing commands, and all three verified a
clean tracked tree and removed their artifacts.

## Findings raised by the user in this round

Reproduced before fixing, per the standing instruction. All confirmed.

| # | Severity | Finding |
|---|---|---|
| 1 | High | The predictable `/tmp` file (independently S1/F4) |
| 2 | Medium | mount undecidability treated as safe (independently S3) |
| 3 | Medium | Enumeration failure recorded as `(none)` (independently F2) |
| 4 | Low | `not a git repository` matched without `LC_ALL=C` |
| 5 | Low | The collision test creates no collision (independently T6) |
| 6 | Medium | `datallowconn` used as a WHERE condition hid every database with connections disabled — raised after the first fix pass and fixed with a regression test over the query condition itself |
| 7 | Low | A `datname` containing a newline mis-parsed the enumeration. Reproduced before fixing: `evil\ninjected: not a database` was reported as TWO databases, the second one's first byte eaten as the connect flag, and the MANIFEST recorded `njected: not a database` — a database that does not exist. The name travels hex-encoded now |

## Findings found while fixing

- **The `.pgpass` wildcard class was closed for one spelling only.**
  `66b2f685c` refused `postgres://u:pw@/db` because the empty host became
  `${…:-*}`. `postgres://u:pw@:5432/db` produces the same empty host and was
  accepted — measured as `*:5432:*:*:<password>`. The refusal is decided on the
  computed host now, not on the authority's spelling.
- **MANIFEST values were not constrained to one line.** Round 3 closed this for
  the authority; `tool_version` and `ACHIEVED_TLS` reach the same line-oriented
  file from command output. Observed corrupting a MANIFEST during a
  reproduction.
- **`fstype_is_unsafe` inherited `IFS=,` from its caller** — bash scopes `local`
  dynamically — so its member list collapsed to one token and every macOS
  option-list lookup matched nothing. Found by the paired allow/deny probe, not
  by review.
- **A sixth ordering defect, mine, caught by the suite.** `hex_of` was defined
  hundreds of lines below the validation loop that calls it, so every
  environment check reported `INTERNAL` instead of `BAD_ENV` — 113 failures on
  the first run. The same shape as the five before it: a value (here, a
  function) used before the block that defines it.
- **The trailing-newline spelling fails silently where the others fail loudly.**
  Command substitution strips trailing newlines, so decoding a datname of
  `trailing\n` yields `trailing`, which IS identifier-shaped and is therefore
  printed as a plain, legal-looking name — the operator reads a database that
  does not exist and never sees the one that does. A sentinel byte preserves it.
  The mutant that removes the sentinel survived the first sweep; it has its own
  case now.
- **A dead guard read as a second layer.** The newline arm on the host slice was
  unreachable: `hp` is a substring of `authority`, which is checked first.
  Deleting it kept the suite green. Removed, and the live check pinned for both
  the username and host slices.

## Recurring Issue Check

### Functionality expert
R1 · R3 · R29 · R31 · R42 · R43 · R47 · R48 · R49 · R50 · R51 · R55. Findings
fired on R1 (F4), R3 (F1), R29 (F8), R42 (F5, F7), R43 (F1, F2, F4, F5, F6),
R48 (F1), R49 (F2, F3), R50 (F2), R55 (F2). Others `pass` or `n/a` with a stated
reason.

### Security expert
R3 · R29 · R42 · R43 · R47 · R48 · R49 · R51 · RS1–RS6. Findings fired on
R3 (S3, S5), R42 (S2, S3, S4), R43 (S1), R47 (S2), R49 (S2, S3, S4), R51 (S4).
RS1, RS2 `n/a`; RS3, RS4, RS5, RS6 `pass`, RS5 and RS6 red-proved.

### Testing expert
R16 · R21 · R29 · R31 · R33 · R34 · R42 · R44 · R45 · R49 · R50 · R51 · R55 ·
RT1–RT11. Findings fired on R16 (T1, T2, T10), R42 (T3), R49 (T3, T5, T9),
R50 (T1, T2), R51 (T3), RT3 (T14), RT4 (T8), RT5 (T1), RT7 (T3), RT8 (T6, T14),
RT9 (T1), RT10 (T3, T12). RT2, RT6, RT11, R21, R31, R33, R44, R45 `pass` or
`n/a` with a stated reason.

## Resolution Status — Round 4

Every Critical and Major fixed. Minors fixed except the ones recorded in the
deviation log's round-4 residuals with a full Anti-Deferral entry.

**R42 class `destination-safety predicates` — member-set expanded 2× (mount
options → mount options + fstype → fstype + fstype prefix + tool-failure
verdict).** Per Step 3-8 this is the accretion signature, so "no findings" alone
does not close it. Closed instead by a mutation sweep through the new
`BACKUP_DB_SCRIPT` seam: **23 mutants, 23 killed, baseline green through the
seam first** so a false-KILLED verdict is impossible. The sweep is re-runnable in
one command rather than re-derived, which is what the seam buys.

The first run of that sweep reported 16/16 killed and was **wrong**: it passed
`--reporter=basic`, which Vitest 4 does not accept, so every mutant exited
non-zero regardless. Re-run with a baseline assertion, the true figure was 7 of
16 surviving. The corrected harness is what the 23/23 above comes from. Recorded
because the failure mode — a verification harness that cannot report a pass —
is the same shape as the findings it was measuring (RT7 shape b), and because
the first number was already written down before it was checked.

## Environment Verification Report

- **VE1 (no RDS reachable)** — URL mode end-to-end remains `blocked-deferred`,
  linked to the plan's VE1 entry and to deviation-log D2. Substituted by URL-mode
  runs against stubbed clients, including the empty-host and empty-port forms.
- **VE2 (Compose local)** — `verified-local`. No sub-agent ran the script against
  the live database this round; every run used PATH stubs and a throwaway root,
  and all three reported their artifacts removed and `git status --porcelain`
  empty.
- **VE3 (CI has no Postgres server)** — unchanged from round 2. Round 4 closed
  the consequence rather than the constraint: the delegating cases no longer
  branch on which reader was found, and the resolved reader is now printed.

---

# External review passes

Four additional review passes were performed by the user between sub-agent
rounds. They are not skill rounds and have no Recurring Issue Check, but their
findings drove five commits and are recorded here so the disposition is
auditable.

| Pass | Findings | Disposition |
|---|---|---|
| After round 1 | 4 High, 3 Medium — restore ACLs, GSS bypasses TLS, ancestor ACLs, stamp collision, `.pgpass` escaping, `oauth_client_secret`, stale lock | All fixed in `a04ccc5eb` |
| After round 2 | 3 High, 3 Medium — concurrent stale-lock reclaim, dry run deletes, third-party ancestor, literal newline, SCRAM keys, ACL step lacks `ON_ERROR_STOP` | All fixed in `f53bf8c92` and `c02762c8f` |
| After the lock change | 2 Medium, 1 Low — `BACKUP_FORCE_UNLOCK` kept the race, age bound unvalidated, ignore rules miss `.partial` / collision form | All fixed in `c02762c8f` |
| After round 3 | 1 High, 2 Medium, 2 Low — Linux mount detection regression, git check fail-open, lock message quoting, dry-run double count, authority validation scope | All fixed in `882f41c1a` |
| During round 4 | 1 High, 2 Medium, 2 Low — predictable `/tmp` file, mount undecidability read as safe, enumeration failure recorded as `(none)`, `LC_ALL=C`, the collision test that collides with nothing | All fixed this round; three were found independently by the sub-agents (S1/F4, S3, F2) |
| After the round-4 fixes | 1 Medium — `datallowconn` used as a WHERE condition hid every database with connections disabled | Fixed, with a regression test over the query condition itself |

Two are worth carrying forward. The Linux mount regression: a fix for a
false-positive (matching the mount POINT) removed true-positive detection on the
platform that was not being tested. And the `/tmp` file: the round-3 fix that
made the in-repo check fail closed opened a symlink-follow write primitive in the
same edit — the tightening and the new hole were one change.

## Recurring Issue Check

Each expert's per-rule block was produced in every round. The blocks were not
preserved verbatim when this artifact was reconstructed; the rules that fired,
consolidated across the three rounds:

### Functionality expert
R2 · R3 · R14 · R17 · R22 · R25 · R29 · R31 · R34 · R36 · R38 · R40 · R41 · R42 ·
R44 · R47 · R49 · R50 · R51 · R52 · R53 · R55 · R57. All others `N/A` or
`Checked — no issue` with a stated reason.

### Security expert
R1 · R3 · R14 · R17 · R18 · R25 · R29 · R31 · R34 · R38 · R39 · R40 · R41 · R42 ·
R43 · R47 · R48 · R49 · R51 · R54 · R55 · RS3 · RS4 · RS5 · RS6. Round 2 has no
block — the expert terminated with an API error.

### Testing expert
R1 · R3 · R12 · R16 · R18 · R19 · R25 · R29 · R31 · R33 · R36 · R39 · R41 · R42 ·
R44 · R47 · R49 · R50 · R51 · R53 · R55 · RT1 · RT2 · RT4 · RT5 · RT7 · RT8 ·
RT10 · RT11.

## Process note

Three defects on this branch were introduced by the fix for a previous round's
finding, and one by the fix for an external pass:

1. The lock reclaim (round 1 fix) was fail-open; its replacement (round 2 fix)
   raced; the mechanism was removed entirely rather than patched a third time.
2. The passfile relocation (round 1 fix) created a namespace no sweeper covered.
3. The stamp-regex relaxation (round 2 fix) widened what the pruners delete.
4. The mount-options fix (round 3) removed Linux filesystem detection.
5. The in-repo fail-closed fix (round 3) introduced the predictable `/tmp` write.

A second pattern is now the dominant one, and it is not the same as the first:
**a class closed for one member and recorded as closed.** Four instances, each
found a round after the commit message said the class was shut.

1. `.pgpass` line injection was closed for the password field while the host
   slice reached the same file (round 3).
2. The empty-host wildcard entry was closed for `postgres://u:pw@/db` while
   `postgres://u:pw@:5432/db` produced the identical wildcard (round 4).
3. MANIFEST line-orientation was closed for the authority while `tool_version`
   and `ACHIEVED_TLS` reach the same file from command output (round 4).
4. The delegating-reader early return was closed on one twin of two (round 4).

The common shape: the member set was enumerated from the instance that was
reported, not derived from the primitive — "values reaching a line-oriented
file", "authority forms yielding an empty host", "call sites of this stub".
Round 4's countermeasure is mechanical rather than editorial: the
`BACKUP_DB_SCRIPT` seam makes the mutation sweep a single command, so the next
round re-runs it instead of re-deriving it, and a member that was closed in
prose but not in code shows up as a surviving mutant.

Five ordering defects also recurred: a value written into an artifact before the
step that computes it, or a destructive step placed before the exit that is
supposed to prevent it. Both patterns are recorded in the deviation log's
round-3 residuals as the reason the destination-check reorder was deliberately
not attempted.
