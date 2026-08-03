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

The Linux mount regression is the one worth carrying forward: a fix for a
false-positive (matching the mount POINT) removed true-positive detection on the
platform that was not being tested.

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

Five ordering defects also recurred: a value written into an artifact before the
step that computes it, or a destructive step placed before the exit that is
supposed to prevent it. Both patterns are recorded in the deviation log's
round-3 residuals as the reason the destination-check reorder was deliberately
not attempted.
