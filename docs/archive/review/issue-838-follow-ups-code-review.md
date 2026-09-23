# Code Review: issue-838-follow-ups

Date: 2026-09-24 · Branch: `fix/issue-838-follow-ups` · Review round: 1

## Changes from Previous Round

Initial code review, on top of the Phase 2 self-R-check baseline (whose four findings — the
non-total membership ordering, two test gaps and a fixture leak — were fixed before this round).
Three experts reviewed the implemented branch; one Critical was escalated to the Opus tier, which
settled the mechanism rather than re-deriving the finding.

Every finding below was reproduced by EXECUTION, not by reading — the experts were told that a
claimed bypass had to be shown against the real hook or gate. The orchestrator independently
re-reproduced each leak before accepting it, and re-ran the deny/allow matrix after the fix.

## Functionality Findings

- **F-F1 (Major)** — reserved words shadow the command word: `if true; then echo "$_CRED"; fi` and
  `for i in 1; do echo "$_CRED"; done` were ALLOWED while printing the credential, because the
  segment's command word was `then` / `do`. **Fixed** by the mechanism change below.
- **F-F2 (Major)** — process substitution was not a nested region, so
  `echo safe <(true; false) "$_CRED"` split at the `;` inside it and the credential landed in a
  segment whose command word was `false)`. ALLOWED. **Fixed**: `<( )` / `>( )` recurse like `$( )`.
- **F-F3 (Minor)** — `#` comments were not modelled, so a benign trailing comment mentioning
  `_CRED` caused a false refusal. **Fixed**: comments skipped at word-start position.
- **F-F4 (Minor)** — a compiled `.pyc` was committed with the scanner and `.gitignore` had no rule.
  **Fixed** (`2f9ae9fc3`): removed from the index, `__pycache__/` and `*.pyc` ignored.
- No findings on C3's gate (the reviewer read the full ~1000-line diff and confirmed each rule
  matches its plan item and that the rewritten header describes what the code does), on C4, on C2,
  or on the `(createdAt, id)` reader set (re-derived independently by grep — five readers, all
  covered).

## Security Findings

- **S-F1 (Critical, escalated)** — invocation prefixes defeat every command-word classifier at once:
  `command echo "$_CRED"`, and the same with `env`, `nice`, `builtin`, `exec`, `time`, `nohup`,
  `stdbuf`. Worse, `command passwd-sso decrypt X` was allowed outright — a bare decrypt putting
  plaintext on stdout, which is the accident the hook exists for. Not the declared SC2 residual:
  nothing is quoted, split, computed or variable-indirected; one ordinary leading word does it.
  **Escalated to Opus**, which settled the mechanism (below) rather than adding words to a list.
- **S-F2 (Major)** — `check-no-pipe-into-grep-q.sh` read only `.claude/settings.json`, while Claude
  Code merges `.claude/settings.local.json` — the sanctioned place for a personal hook. A hook wired
  there and living outside `.claude/hooks/` was neither wired-found nor present-found, and the gate
  printed OK over a script carrying the exact SIGPIPE race it exists to catch. **Fixed**
  (`2f884104d`); orchestrator-verified on a fixture: pre-change exit 0, post-change exit 1 naming
  the file.
- **S-F3 (Minor)** — same `.pyc` as F-F4. Fixed.
- No findings on C3 (two concrete bypass hypotheses built as fixture trees and run against the real
  gate; both caught) or on C4 (`--by` validated before a client exists, dry-run prints ids only, the
  per-user transaction re-reads and re-derives, both tenants get their audit row).

## Testing Findings

- **T-F1 (Major)** — two A-C1-2 allow cells contained no decrypt occurrence, so the scanner
  short-circuited before the rules they named ever ran: they could not fail. **Fixed**: wrapped in
  the capture helper so they reach Shape 1.
- **T-F2 (Major)** — the D8 total-order fix was unpinned in the backfill's two readers, and no DB
  fixture can observe a tie (D1: the unique index makes one unconstructible), so only an assertion
  on the query itself can catch a dropped secondary key. **Fixed**: two unit cells spy the
  transaction client and assert the SQL text and the `orderBy` shape.
- **T-F3 (Major)** — seven C3 deny cells (Rule A ×5, item 5c ×2) also trip the pre-existing
  round-13 indirect-reference check. Verified unavoidable — possessing the namespace is what the
  fixture is about. **Fixed** by asserting BOTH messages, so the confounding is recorded rather
  than invisible, with a comment saying why exclusion is impossible.
- **T-F4 (Minor)** — the barrel cell asserted only a file path, not which rule decided it. **Fixed**.
- **T-F5 (Minor)** — the ambient `@prisma/client` stub had nothing tying it to the installed
  package. **Fixed** by scoping the comment to what it does NOT model (the real client has no string
  index signature and exposes models as named non-callable getters); no CI check added, since
  nothing depends on the divergence today.
- No findings on the integration test's acquisition-time cleanup (every row tracked as created; the
  suite-level `cleanup()` is a second backstop) or on the C2/C4 unit suites.

## Escalation (Security Critical S-F1, Opus tier)

The tier was asked to settle the MECHANISM, not to re-derive the finding, and it prototyped both
candidate designs before recommending one.

**Rejected: compute an effective command word by stripping prefixes.** Each prefix carries its own
option grammar (`env -u X`, `timeout --preserve-status 5s`, `nice -n 5`, `sudo -u x --`); misreading
one silently allows. And reserved words have nothing to strip TO — `case x in a) echo "$_CRED";;`
has command word `a)`, and `for x in "$_CRED"` has no command at all. A compound command is not a
deeper prefix; it is outside the parser's unit.

**Adopted: invert the default inside Shape 1.** A segment whose command word cannot be determined
is REFUSED. Unattributable is defined structurally (reserved word, displacing invocation prefix, a
command word that is not a plain word or contains `$`/backtick, an `env` form beyond the modelled
`NAME=value*`), so an unknown future construct falls on the refusing side by construction. Process
substitution and `#` comments are modelled exactly, because both are cheap and one of them was
causing a false refusal. Detection strips transparent prefixes with a depth bound. Rule 6b refuses a
printer name appearing as a bare operand, which closes `torify echo` / `gosu u echo` without
enumerating prefixes.

Measured by the tier and re-measured on landing: the 94 pre-existing cells stay green, Patterns A–E
stay allowed, and the scanner got FASTER (it no longer tokenises comment padding).

**Cost, recorded rather than hidden**: inside a decrypt capture, a compound command (`if`, `for`,
`{ … }`, a function definition) or an invocation prefix is refused even when harmless, and rule 6b
refuses an unquoted printer name as an operand (`ssh host tail -f x`), which quoting avoids.

**What stays open afterwards** (the residual paragraph now says this): detection spellings the
scanner does not recognise — a quoted or split subcommand, one reached through a variable, one
behind `eval`, a prefix outside the transparent list — which is a RECOGNITION list whose gaps
degrade to "not seen", never to a wrong allow of a shape that WAS seen; a consuming command that
prints what it is handed, since Pattern C grants an arbitrary consumer; and anything bash assembles
at run time. SC2 — a decrypt surface that never returns plaintext — remains the only real closure.

## Orchestrator verification of the round's fixes

Re-run after all fixes landed, by the orchestrator rather than the implementing agents:

| Shape | Before | After |
|---|---|---|
| `command echo "$_CRED"` | ALLOW | BLOCK |
| `nice echo "$_CRED"` | ALLOW | BLOCK |
| `if true; then echo "$_CRED"; fi` | ALLOW | BLOCK |
| `for i in 1; do echo "$_CRED"; done` | ALLOW | BLOCK |
| `echo safe <(true; false) "$_CRED"` | ALLOW | BLOCK |
| `torify echo "$_CRED"` | ALLOW | BLOCK |
| `command passwd-sso decrypt abc` | ALLOW | BLOCK |
| Patterns A and D, `env DEBUG=1 cmd "$_CRED"`, an arbitrary consumer, a trailing comment, the quoted 6b escape | ALLOW | ALLOW |

Hook suite 111/111. Full suite 15976 passed. Build succeeds. `scripts/pre-pr.sh` 80/80.
Gate fixture for S-F2 re-proved independently: pre-change exit 0, post-change exit 1.

## Environment Verification Report

- **E1** (no production database) — `blocked-deferred`. The backfill's production run and the three
  measurements remain operator work, as Phase 1 predicted; the tool defaults to dry-run and reports
  before it writes. Anti-Deferral entry: plan `## Project context` E1, and deviation log D1 for what
  the shipped index changes about it.
- **E2** (no BSD grep / bash 3.2 locally) — `blocked-deferred` for macOS execution. Reduced in scope
  this round: `grep` left the hook entirely, so the BSD-grep axis no longer applies to C1. What
  remains is the C2 gate's awk and the hook's bash, both POSIX constructs checked by reading.
- **E3** (integration tests race the workers) — `verified-local`: the C4 integration cells were run
  with `docker compose stop audit-outbox-worker retention-gc-worker` and the workers restarted
  afterwards.

## Resolution Status

All round-1 findings are resolved in the branch; none carries an Anti-Deferral disposition.

- F-F1, F-F2, F-F3, S-F1 → `c9176ca5d` (scanner mechanism change + 17 cells)
- F-F4, S-F3 → `2f9ae9fc3`
- S-F2 → `2f884104d`
- T-F1 → `c9176ca5d` (the two cells wrapped) and `f0bb091fd`
- T-F2, T-F3, T-F4, T-F5 → `f0bb091fd`

---

# Rounds 2-7 — the credential lint, by differential

Date: 2026-09-24 · Review rounds: 2, 3, 4, 5, 6, 7

## Changes from Previous Round

Round 1 closed with the scanner mechanism change. Rounds 2-7 then found six more defects in
that same file, each by a method the previous round had not used. They are recorded together
because the sequence is the finding: what closed this file was not another rule, it was changing
how it was reviewed.

- **Round 2 (Critical, found independently by two reviewers)** — `_skip_transparent_prefixes`
  capped stripping at four, so five recognised prefixes hid a bare decrypt from detection and the
  command took the allow arm. Any finite cap reproduces it at cap+1, so the cap went, not up.
- **Round 3 (Critical)** — the same class through a different door: an option-taking prefix
  (`sudo -u alice`, `nice -n 10`, `env -i`) left the FLAG where the CLI name was expected.
  Modelling each prefix's option grammar was already rejected in round 1 as fragile, and refusing
  the unresolvable was not available — this hook runs on every Bash command, so it would refuse an
  ordinary `sudo -u alice ls`. The answer was to stop needing prefixes at all: the CLI token
  followed by `decrypt` is looked for at any position, and the prefix list is gone.
- **Round 4 (Major ×2)** — the review question changed here, and that is what made the rest
  findable: not "is the new code good" but "does this branch refuse everything main refused". A
  parser matches structure; the regex it replaced matched text anywhere. `./passwd-sso decrypt X`
  and `/usr/local/bin/passwd-sso decrypt X` were refused by main and allowed here — a fail-open
  this branch introduced. Fixed by matching the name as a whole path component; `index.js` joined
  `index.ts`, which main missed too.
- **Round 5 (Critical + Major)** — a 184-command differential, verified against real bash with a
  sentinel binary. An unquoted heredoc's body is expanded by bash, so `cat <<EOF` /
  `$(passwd-sso decrypt X)` / `EOF` ran the decrypt and printed it while the branch allowed the
  command: the body was captured as text and never parsed. Fixing it surfaced a third defect the
  corpus had masked — closing a backtick region was read as opening another, so EVERY command
  containing a backtick substitution raised and the hook refused it (`echo \`date\`` included).
  The entry-point spelling also matched by substring, refusing `myindex.jsx-report decrypt X`.
- **Round 6 (Major)** — 1008 commands, structurally generated over five axes. Zero Critical
  regressions: all 66 main-BLOCK/branch-ALLOW candidates were confirmed by real bash to print
  nothing (main false-positived on inert text). One over-refusal: bash does not treat a heredoc
  that reaches end of input without its terminator as an error — it warns and runs — while the
  scanner raised, so a mistyped terminator or any CRLF-authored heredoc refused ordinary work.
- **Round 7 (convergence, no findings)** — the fix moved exactly the 27 cells round 6 measured and
  nothing else, and a fresh 304-command sweep of ordinary commands containing no decrypt found no
  input that bash accepts and the scanner cannot parse.

## What this sequence says

Rounds 1-3 each answered a bypass with a better rule, and each answer was bypassed again. The
class only closed when round 3 REMOVED the mechanism instead of extending it, and the remaining
defects were not reachable by reading at all — they needed both hooks run over a generated corpus,
with real bash as the adjudicator of whether a credential actually reaches stdout.

Two directions of breakage came out of that method, and only one of them is intuitive:

- refusals main had that the parser lost (heredoc expansion, path-qualified names) — fail-open;
- ordinary commands main allowed that the parser refused (every backtick substitution, every
  CRLF heredoc) — a lint that blocks normal work gets disabled, so this direction is not cosmetic.

Neither was visible in the unit suite, which tests shapes someone thought of. The differential is
now the artifact that would catch the next one, and its harnesses are recorded in the scratchpad
rather than committed, which is a limit worth naming: a future rewrite of this file should
regenerate the corpus rather than trust these rounds.

## Environment Verification Report (updated)

- **E2** — the macOS/BSD axis shrank again: `grep` left the hook in round 1, and rounds 5-7 removed
  the last text-matching from detection. What remains platform-sensitive is the C2 gate's awk and
  both scripts' bash, all POSIX constructs, checked by reading. Still `blocked-deferred` for
  execution on macOS.
- **E1**, **E3** — unchanged from round 1.

## Resolution Status (rounds 2-7)

- Round 2 Critical (depth cap) → `c3ec9377d`
- Round 3 Critical (option-bearing prefix; position-free detection) → `b37609f23`
- Round 4 Major (path-qualified name lost against main; `index.js` added) → `57a2d3f40`
- Round 5 Critical (heredoc expansion) + Major (backtick region; entry-point substring) → `b4752de70`
- Round 6 Major (unterminated heredoc) → `fcd533e95`
- Round 7 → no findings

Hook suite: 120 cells. Full suite: 15985 passed. The differential corpora (1008 + 304 commands)
are the evidence behind the convergence claim, not the unit suite alone.
