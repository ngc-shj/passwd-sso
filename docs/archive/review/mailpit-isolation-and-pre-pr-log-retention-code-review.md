# Code Review: mailpit-isolation-and-pre-pr-log-retention
Date: 2026-08-30
Review round: 1

Phase 3 standalone — no Phase 1 plan or deviation log exists for this branch. The
work rebuilds two independently-converged pieces from the discarded
`fix/audit-dead-letter-bound` branch (deliberately not cherry-picked), plus one
pre-existing bug the verification walked into. Plan/deviation cross-checks are
therefore `N/A`.

## How to read the citations in this file
**Findings** cite the code as it was when written (against `main` `0ef3e1476`
plus this branch's three commits). **Resolution Status** cites HEAD after the
round-1 fixes. `verify-references.sh --base main --strict` reports the latter as
SHIFTED by construction.

## Changes from Previous Round
Initial review.

## Merge method
Mechanical merge pre-pass over the three experts' fenced json indices, joined on
(file, line ±5, root cause), then `merge-findings` run over the three raw outputs
(saved to `$TRI_DIR/{func,sec,test}-findings.txt` per the Step 3-4 obligation).
Its output produced 4 Major and 3 Minor groups; the groupings below keep the
experts' finer granularity where the defects have distinct fixes, and keep the
experts' severities where those rested on execution — `merge-findings` downgraded
the TMPDIR leak to Minor against the Testing expert's executed Major.

21 raw findings across three experts → 13 consolidated (0 Critical, 6 Major,
7 Minor).

## Functionality Findings

**F-M1 / Major / `docker-compose.override.yml:125,133,136` — the pin's numbers are
not reproducible from the command shipped beside them.** Converged by ALL THREE
experts (Func F1+F2, Sec S4, Test T3), which is itself the evidence: three
independent re-derivations produced a number different from the comment's, which
is precisely what the next operator bumping the pin will experience.

**The experts' proposed correction is wrong, and adopting it would make the
comment false.** All three queried only the global advisory database. Re-derived
by the orchestrator:

| source | query | affecting v1.29.1 |
|---|---|---|
| global advisory DB | `gh api '/advisories?ecosystem=go&affects=github.com/axllent/mailpit'` | **8** of 13 |
| repository advisories | `gh api repos/axllent/mailpit/security-advisories` | **+2** — CVE-2026-67446, CVE-2026-67445 (both published 2026-07-09, patched 1.30.4), absent from the global DB |
| **total** | | **10** |

Likewise the date: `2026-07-28` is the **repository-side** publication date of
CVE-2026-67448; `2026-08-20` is when the global DB ingested the same advisory.
Both are real; they are different clocks.

So the arithmetic was right and the sourcing was not. The defect is that the
comment ships one command which reaches one of the two sources, so neither figure
can be confirmed from what is printed next to it. Fix by naming both sources,
shipping both commands, and stating the margin on the conservative clock.

**F-M2 / Major / `scripts/pre-pr.sh:87` — the `return 0` guarantee is defeated by a
failing `rm` under `set -e`.** `[ "$keep" -eq 1 ] || rm -f "$logfile"` is an OR
list whose last element is `rm`; a non-zero `rm` fires `set -e` and the function
never reaches `return 0`. Reproduced independently by the orchestrator with a
non-writable TMPDIR:

```
[branch] green body, rc=1
[main  ] green body, rc=1     ← pre-existing, identical
[writable TMPDIR] rc=0
```

An all-green run prints `✓ All pre-PR checks passed` and then exits 1. Direction
is green→red only, so this is a false-red rather than a false-green — Major, not
Critical. Pre-existing, and in scope because the diff adds a second comment
(`:82`) asserting the guarantee that does not hold.

**F-m1 / Minor / `scripts/pre-pr.sh:85`** — `${failed_entry#*|}` loses retention if
a step label ever contains `|`; the failed step's log is then deleted, the exact
outcome the commit exists to prevent. No current label contains one (77 labels
checked). `#*|` is the correct choice over `##*|` because `$TMPDIR` is
environment-controlled and may contain `|`. What is absent is anything keeping the
assumption true as labels are added. Converges with Sec S6.

**F-m2 / Minor (question) / `.github/dependabot.yml`** — no `docker` ecosystem, so
the new pin has no automated watcher. Folded into F-M4.

**F-m3 / Minor / `docker-compose.override.yml:161`** — on hosts that ran the old
config, the now-undeclared `passwd-sso_default` network survives as an empty
bridge holding its address-pool subnet, and `docker compose down` will not remove
it because compose acts on the current config.

**F-m4 / Minor (question) / `docker-compose.override.yml:116`** — does any mailpit
consumer run inside compose? `docker-compose.yml` gives `app` `env_file: .env`,
which carries `SMTP_HOST=localhost`, so a containerised app has never reached
mailpit. **Closed by evidence:** `docs/operations/dev-host-migration.md:322`
brings the stack up as `redis jackson mailpit audit-outbox-worker` — without
`app` — and the dev server runs host-side. The comment is accurate as written.

## Security Findings

**F-M3 / Major / `docker-compose.override.yml` + `.github/dependabot.yml` +
`.github/workflows/ci.yml:693`** — the pin fixes the instance, not the class.
Nothing in the repo watches third-party container image versions, which is why
`:latest` was able to sit on v1.29.1 carrying ten unpatched advisories until a
human noticed. `check-compose-log-caps.mjs` is the only compose-reading gate and
inspects `logging:` only; dependabot declares `github-actions` + three `npm`
ecosystems and no `docker`; Trivy scans `image-ref: passwd-sso:scan`, the app's
own build, not the third-party images. The repo treats pinning as gate-worthy
elsewhere (`check-actions-sha-pinned.sh`, `check-dockerfile-prisma-pin.sh`), so
this is a coverage hole rather than a deliberate choice. Converges with Test T4
and Func F5.

**F-M4 / Major / compose `app` service — RAISED, NOT FIXED. See Open Decisions.**
`app` publishes without a `host_ip` while every other dev service in the changed
file is loopback-pinned.

**F-m5 / Minor / `docker-compose.override.yml:165`** — the new `mail` network is
declared without `internal: true`. Verified live: `docker exec
passwd-sso-mailpit-1 wget https://example.com` succeeds. mailpit is a terminal
sink — it accepts SMTP and serves a UI, and initiates nothing — so `internal:
true` costs it no function while removing the egress path from a container that
accumulates live magic-link sign-in tokens. The commit's stated purpose is
confining that component; it confined ingress and left egress open.

**F-m6 / Minor / `scripts/pre-pr.sh:65,137`** — retained logs have no expiry, no
count cap, and no declared contract on what may enter them, over a gate list of
73 and growing. The Security expert found **no** positive secret-disclosure path
(gitleaks runs `--redact`; the Node fallback prints an 8-hex-char prefix;
`check-dockerignore-secrets.sh` prints paths not contents; no gate dumps
`process.env`), and explicitly retracted the brief's premise that the files are
world-readable — `mktemp -t` gives mode 0600, verified. What retained logs do
carry is DB usernames, hostnames, ports and database names from pg/Prisma
connection errors. The defect is unbounded lifetime, not disclosure.

**Verified, not findings** (recorded so the negatives are not read as unexamined):
- No R43 widening and no R31 boundary removal. mailpit's reachability from
  `internal` is identical before and after — three separate non-internal bridges
  in both states, cross-bridge traffic blocked by Docker isolation either way.
  `docker network inspect passwd-sso_mail` → exactly one member;
  `passwd-sso_default` → empty, no stale container, no partial-restart path back
  onto `internal`. Published loopback ports byte-identical.
- No R49 overstatement in the **network** rationale: the comment explicitly
  concedes the residual exposure is the loopback port it deliberately keeps.
- RS4 clean — no PII, hostnames or operator identity in the diff or comments.

## Testing Findings

**F-M5 / Major / `scripts/pre-pr.sh:83,136,163` — RT7: nothing in the repository
can fail if any of the three changed behaviours is reverted.** Evidence that it is
missing rather than merely absent from the diff:
- `rg 'cleanup_tempfiles|show_failure_context|Running tests with seed|log retained|sequence\.seed'`
  over `scripts/__tests__/`, `scripts/checks/`, `.github/` → **zero hits**.
- `check-gate-selftest-coverage.sh` cannot demand one: its member sets are
  `checks/*.sh|*.mjs` and inline `run_step "Static:…"` gates. `pre-pr.sh`'s own
  functions are in neither, and the diff adds no inline gate — so no debt entry is
  required and none is missing.
- `pre-pr-run-batch.test.mjs` splices from `SCHED_START = "batch_labels=()"` at
  `scripts/pre-pr.sh:229`; both changed functions are at 65 and 98, **above** the splice.

The author's mutations were real but the harness was uncommitted. A proof outside
the tree cannot red a future PR.

**F-M6 / Major / `scripts/__tests__/pre-pr-run-batch.test.mjs:196,463` — RT11.**
`run()` `mkdtempSync`s `dir` and `rmSync`s it in `finally`, but passes
`env: { ...process.env, ...env }` — **`TMPDIR` is inherited, not redirected** — so
the spliced `run_batch`'s `mktemp -t` resolves outside the tree teardown reclaims.
15 files leak per run. Verified 15 on this branch and 15 on main, so the author's
"measured identical" claim reproduces; pre-existing, and in scope because the diff
sharpens it: `/tmp/pre-pr.*` is now also the name production uses for
*deliberately retained* logs, so a developer following `(log retained: …)` can land
on a self-test's corpse.

**F-m7 / Minor / `scripts/pre-pr.sh:137`** — `(log retained: %s)` prints
unconditionally, but CI runs `PRE_PR_STATIC_ONLY=1` on an ephemeral runner
(`.github/workflows/ci.yml:242`), where the named path does not survive the job. The failure output
prints a follow-up instruction that cannot be followed in the one environment CI
uses. (The seed grep is merely inert there — `Test` / `Extension: Test` are gated
out by `STATIC_ONLY`.)

## Adjacent Findings
- [Adjacent] Minor — retained logs have no reaper (Functionality → Security;
  adopted as F-m6).
- [Adjacent] Minor — the retention logic and here-string fix ship without a test
  (Functionality → Testing; adopted as F-M5).
- [Adjacent] Minor — retention match splits on the first `|` with unvalidated
  free-text labels (Security → Functionality; adopted as F-m1).
- [Adjacent] Minor — the gitleaks-fallback branch pushes a `failures` entry with an
  empty logfile half (`scripts/pre-pr.sh:743`), the one entry not satisfying the
  `label|logfile` invariant the new loop's comment states universally. Harmless
  today: `[ -n "$logfile" ] || continue` runs first. Folded into F-m1's fix.
- [Adjacent] Minor — advisory numbers (Testing → Security/Functionality; adopted as
  F-M1).

## Quality Warnings
`merge-findings` flagged none: every finding carries a file/line, a concrete fix
and reproducible evidence. No VAGUE / NO-EVIDENCE / UNTESTED-CLAIM.

**One cross-expert adjudication, resolved against all three experts.** Func F1/F2,
Sec S4 and Test T3 converged on correcting "TEN" → "eight" and "2026-07-28" →
"2026-08-20". The orchestrator re-derived both figures and found the experts had
queried only the global advisory database; two further advisories affecting
v1.29.1 exist as repository-level entries the global API does not carry, and the
two dates are two different clocks for the same advisory. Applying the converged
fix would have replaced a correct number with an incorrect one. Convergence is a
severity signal, not a correctness proof — the finding stands (the figures are not
reproducible from what is shipped), the proposed remedy does not.

**One misattributed evidence line, noted so it is not carried forward.** Sec S2
cites `ss -ltnp` showing `*:3000` as confirmation that the compose `app` service
binds all interfaces. That listener is the host-side `next-server` (pid observed),
and no `app` container is running. The compose-config gap is real; the live
evidence offered for it is a different process.

## Recurring Issue Check
### Functionality expert
R1 OK · R2 OK · R3 OK · R4-R15 N/A · R16 OK (no CI path consumes the override) ·
R17 OK · R18 OK · R19-R28 N/A · **R29 FIRED — F-M1** · R30 OK · R31 N/A ·
R32 OK (v1.31.0 observed running) · R33 OK (five compose files enumerated) ·
**R34 partially fired — F-M2** · R35 N/A · R36 OK · R37 N/A · R38-R40 N/A ·
R41 OK · R42 OK for code classes (2 `mktemp` sites, 4 `failures+=` sites) ·
R43 OK (reach narrowed) · R44 examined OK (both new pipelines are display paths;
verdicts still come from `PIPESTATUS[0]` and per-index `wait`) · R45 OK ·
R46-R48 N/A · **R49 FIRED — F-M2** · R50 OK · R51 OK · R52 OK · R53 OK · R54 N/A ·
**R55 FIRED — F-m1** · R56-R57 N/A

### Security expert
R1-R17 N/A · R18 checked (no allowlist gates the changed surfaces) · R19-R28 N/A ·
**R29 FIRED — F-M1** · R30 N/A · R31 checked clean (all docker inspection
read-only; no `down`, nothing stopped) · R32 N/A · **R33 FIRED — F-M3** ·
R34-R38 N/A · R39 checked — F-m6 (bounded-lifetime hygiene, not a zeroization
defect) · R40-R42 N/A · R43 checked clean · R44-R48 N/A · R49 checked — network
rationale correctly calibrated; the arithmetic is F-M1 · R50-R57 N/A ·
RS1-RS3 N/A · RS4 clean · **RS5 FIRED — F-M3** · RS6 N/A

### Testing expert
R1-R15 N/A · R16 checked clear (STATIC_ONLY divergence is by design, documented at
`scripts/pre-pr.sh:11`; covered as F-m7) · R17-R28 N/A · **R29 FIRED — F-M1** (also
re-derived the 15-file leak claim, which reproduces) · R30-R32 N/A · R33 checked
clear (one CI path, `.github/workflows/ci.yml:242`) · R34 checked clear (the here-string bug was
fixed not deferred; the TMPDIR leak is reported as F-M6) · R35-R41 N/A ·
R42 checked (changed-behaviour class derived from the diff: retention, seed,
here-string, image pin — all four covered) · R43-R49 N/A · R50 checked ·
R51-R57 N/A · RT1 N/A · RT2 satisfied · RT3-RT6 N/A · **RT7 FIRED — F-M5** ·
RT8-RT9 N/A · **RT10 checked → folded into F-M5** · **RT11 FIRED — F-M6**

## Environment Verification Report
N/A — no environment constraints declared in Phase 1 (no Phase 1 for this branch).

All verification ran locally. Both gate self-tests and every mutation ran under
`mktemp -d` copies; no repo file was modified during verification. The dev stack is
live and shared — all Docker inspection was read-only, and the one write
(`docker compose up -d mailpit`) was the pin's own boot smoke test.

## Open Decisions (raised, not fixed)

### F-M4 — compose `app` publishes on all interfaces
`docker compose config` renders `app` with no `host_ip` (`3000->3000`) while `db`,
`jackson`, `redis`, `mailpit` and `minio` are all `127.0.0.1`-pinned in the changed
file. Not fixed in this round, for three reasons stated together:

1. **Out of the diff's reach.** The port is declared in `docker-compose.yml`, which
   this branch does not touch. The finding is "the override should have an `app`
   entry it has never had" — a requirement about code the change does not contain
   (Finding Floor clause 2).
2. **The live evidence was misattributed** (see Quality Warnings): the observed
   `*:3000` is the host-side dev server, and no `app` container runs in this
   workflow.
3. **It may be deliberate.** `docs/architecture/machine-identity.md:145-149`
   documents remote access via `tailscale serve` proxying to the local daemon, and
   notes the app process is "not directly reachable". Whether the compose `app`
   path is meant to be host-only is the maintainer's call, and changing the bind
   could break an intentional workflow — the tradeoff protocol's "do not fix by
   deleting what made the feature useful".

**Recommended if adopted:** `${DEV_BIND_ADDR:-127.0.0.1}:3000:3000` in the
override, so the default is closed and any widening is a named, deliberate act.
Pin the allow side by asserting `app` keeps `networks: [internal]` — compose
*replaces* rather than merges a `ports:` sequence, so an override entry becomes the
whole published set.

**Still open** — `docker-compose.yml:49` still publishes `app` as `"3000:3000"` with no `host_ip`,
and `docker-compose.override.yml` still has no `app` entry to pin it, while `db`/`jackson`/`redis`/
`mailpit`/`minio` remain `127.0.0.1`-pinned there. The reason is unchanged: it is a requirement about
a file that branch did not touch, and the bind may be deliberate.

## Resolution Status

Round 1: 6 Major and 7 Minor findings. Fixed 10, rejected 1 with evidence, raised
2 for a decision, closed 1 by evidence. No deferrals.

### F-M1 Major — the pin's figures are not reproducible from the shipped command
- Action: **the converged remedy was NOT adopted.** All three experts queried only
  the global advisory database and proposed "TEN" -> "eight". Re-derivation showed
  two further advisories affecting v1.29.1 (CVE-2026-67446/67445, published
  2026-07-09, patched 1.30.4) exist only as repository-level entries the global
  API does not carry, and that 2026-07-28 and 2026-08-20 are the repository and
  global-DB clocks for the same advisory. Ten was right; the sourcing was not.
  Both commands are now shipped, `vulnerable_version_range` is selected because
  it is the field that decides whether a RUNNING version is affected, and the
  margin is stated on the conservative clock (2 days, not 25). The comment also
  records that an unauthenticated `gh` returns `[]`, which reads like a clean bill.
- Modified: `docker-compose.override.yml:123` (the rationale block) and `:163` (the pin)

### F-M2 Major — a failing `rm` defeats the `return 0` guarantee
- Action: routed to a named stderr warning inside an `if`, so `rm`'s status is no
  longer the OR list's last command.
- Modified: `scripts/pre-pr.sh:93` (the `keep` branch) and `:95` (the warning)
- Red-proof, three runs observed: rm-fails + green body -> rc 0 with the warning
  (was rc 1); rm-fails + red body -> rc 1; writable + green -> rc 0.

### F-M5 Major (RT7) — nothing could fail if the changed behaviours were reverted
- Action: added `scripts/__tests__/pre-pr-failure-context.test.mjs` — 15 cases
  splicing the production functions verbatim, every spawn bounded by a timeout
  because the here-string defect's symptom is a hang, and the splice asserting it
  found its anchor so "not found" cannot be spelled like "empty".
- Red-proof, one mutation per clause: retention -> unconditional `rm` (1 red);
  seed grep deleted (2 red); here-string back on the assignment (1 red); label
  guard removed from both entry points (2 red) and from `run_step` only (1 red);
  CI suppression removed (1 red).
- **Two of its own assertions were decorative and were repaired**, which the
  mutation run is what exposed: the seed fixtures put the seed adjacent to the
  markers, so the context window echoed it and deleting the dedicated grep stayed
  green — the fixtures now carry 200 filler lines with the seed at line 1, outside
  the 60-line window. And the label cases drove only `queue_step`, so a
  non-global mutation removing `run_step`'s copy went unseen; both entry points
  are now driven by `it.each`.

### F-M6 Major (RT11) — the sibling self-test leaked 15 files per run
- Action: `TMPDIR: dir` last in the spawn env at both sites, so a caller's `env`
  cannot escape containment.
- Modified: `scripts/__tests__/pre-pr-run-batch.test.mjs:202,469`
- Red-proof: 15 -> 0, with 21/21 still passing (the allow side — the concurrency
  cases read files at absolute paths under their own mkdtemp dirs).

### F-m1 Minor — a label containing `|` would delete a failed step's log
- Action: invariant asserted at BOTH entry points. `#*|` is kept deliberately —
  `$TMPDIR` is environment-controlled and may contain `|`, which `##*|` would
  break — so the guard is on the half we control.
- Modified: `scripts/pre-pr.sh` (`run_step`, `queue_step`)

### F-m7 Minor — the retention notice named a path CI discards
- Action: suppressed under `CI`. The context itself still prints.
- Modified: `scripts/pre-pr.sh:149`

### F-m3 Minor — the orphaned `passwd-sso_default` network
- Action: documented in the `networks:` block with the one-line reclaim, noting
  `docker network rm` refuses while a container is attached so it is safe to run
  blind.

### F-m4 Minor (question) — CLOSED by evidence
`docs/operations/dev-host-migration.md:322` brings the stack up as
`redis jackson mailpit audit-outbox-worker`, without `app`; the dev server runs
host-side. The comment's `SMTP_HOST=localhost` claim is accurate as written.

### F-m5 Minor — REJECTED with evidence
`internal: true` on the `mail` network does block mailpit's egress, as the
reviewer said. It also stops the daemon publishing the ports at all: with it set,
`docker port passwd-sso-mailpit-1` prints nothing, the host has no LISTEN on
8025/1025, and mailpit reports healthy inside while unreachable from outside —
the entire dev mail workflow, traded for an egress path nothing was shown to use.
The reviewer's fix asserted "published-port DNAT is unaffected by `internal`";
that is false on this Docker. Caught by the allow-side check the Remedy Floor
requires. Reverted, service restored, and the measurement recorded in the file so
the next reader does not re-derive it — with the condition for revisiting stated:
egress blocked AND `curl 127.0.0.1:8025` answering 200, both re-tested.

### F-M3 / F-m2 Major+Minor — no watcher for compose image pins: RAISED
See Open Decisions. Adding a `docker` Dependabot ecosystem plus a compose
image-pin gate is a new CI control with its own self-test, beyond what this
branch was cut for. The pin it would protect is correct today; what is missing is
what keeps it so.

### F-M4 Major — compose `app` binds all interfaces: RAISED
See Open Decisions.

### Unplanned: CI Trivy failure (CVE-2026-9496, High)
Not a review finding — CI went red while this round was in progress. `pacote`
21.5.0 bundled inside npm, range `>= 11.2.7, < 21.5.1`. Unrelated to this
branch's contents (main's last run was green; the advisory is new), fixed here
per the no-dismissal rule. Added to `Dockerfile` in the established form, plus
the post-patch assertion in the tail block that every sibling entry has and this
one would have been missing. Verified by building the real image and scanning it
under CI's exact flags: pacote 21.5.1, Trivy exit 0, `npm -v` still 11.16.0.

## Verification
- `bash scripts/pre-pr.sh` — 73/73 (runs lint, the full vitest suite, and the
  production build)
- `docker build -t passwd-sso:scan .` + Trivy under CI's flags — exit 0
- mailpit boot smoke test on the live stack: SMTP banner on 127.0.0.1:1025, HTTP
  200 on :8025, and `mailpit` unresolvable from `internal`

## Round 2 decision
Not required. Every round-1 finding is fixed, rejected with evidence, or raised
as a decision; the two raised items are recorded in Open Decisions with what
would close them. The tightening-only skip does not apply — this round's fixes
are substantive — so the stop condition is the ordinary one.

R42 note: no class in this review expanded its member-set twice. The changed
behaviours are now covered by a mutation-verified self-test wired into the
default vitest run, which is the artifact that condition would have demanded.
