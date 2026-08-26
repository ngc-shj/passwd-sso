# Code Review: rls-health-context-and-gate-gaps
Date: 2026-08-26
Review round: 1

Phase 3 standalone — no Phase 1 plan or deviation log exists for this branch; the
work came from a session handoff. Plan/deviation cross-checks in the Phase 3
template are therefore `N/A`, and the "Implementation Checklist vs diff" check
has no checklist to read.

## Changes from Previous Round
Initial review.

## How to read the citations in this file
Two different anchors, deliberately:

- **Findings** cite the code as it was when the finding was written — i.e.
  against `main` (`e87e405e8`) plus the branch's pre-review commits. They describe
  a defect that no longer exists, so re-pointing them at current lines would make
  the finding text false.
- **Resolution Status** cites the code as it is now (HEAD). Every line reference
  there was re-opened and confirmed to land on the symbol it names after the
  round-1 fixes moved things.

`verify-references.sh --base main --strict` therefore reports the Resolution
Status references as SHIFTED by construction: a fix that changed a line is
exactly what "differs from main" means. There are no MISSING references.

## Merge method
Mechanical merge pre-pass over the three experts' fenced json indices, joined on
(file, line ±5, root cause). Prose consolidation done by the orchestrator rather
than through `merge-findings` — the json join had already resolved every
duplicate group and the three raw outputs were in context. Convergence groups are
stamped with the severity floor per "Perspective Convergence as a Severity
Signal".

35 raw findings across three experts → 24 consolidated (2 Critical, 9 Major,
13 Minor).

### Post-hoc verification of the merge (deviation follow-up)

The deviation above stands as recorded: `merge-findings` was available and was
not used at Step 3-4. It was run afterwards, against the three experts' findings
verbatim, purely to check the consolidation rather than to replace it.

**Result: no finding it produced is absent from the 24.** It emitted 7 coarse
groups (1 Critical, 4 Major, 2 Minor) against the 24 actionable items here; every
group maps onto items already present, so the manual consolidation is a strict
refinement of it, not a divergence.

Two judgments differ, and both are kept as they are here:

- It merged the scope-blind binding resolver (F-C1) with the scan-target
  resolution floor (F-M2) into one Major group. They share a file and nothing
  else: one is a fail-open in the adjudication of a security control, the other
  is a coverage floor. Keeping them apart also keeps F-C1 at Critical, which the
  reproduction supports — the merger's rating would have downgraded a
  fail-open that was demonstrated by execution.
- It folded the `INVALID_RLS_NESTING` question (F-m3) into the health-test-mocking
  group. That question is about a future caller, not about test doubles.

It also mis-attributed the pgErrorCode group to "Security expert F1", which is
the RLS resolver finding. Noted so the attribution in this file is not read as
corroborated by it.

Its Quality Warnings section returned PASS on all three checks
(no VAGUE / NO-EVIDENCE / UNTESTED-CLAIM), matching the assessment recorded
below. It reported the `Recurring Issue Check` sections as absent from its input,
which is accurate — only the findings sections were fed to it. Those sections are
preserved verbatim in this file from the experts' own outputs.

## Functionality Findings

**F-C2 / Critical / `src/lib/prisma/prisma-error.ts:22`** — see the merged
Critical section below. Functionality reported the ordering half (`code !== "P2010"`
early return makes the documented `cause` shape unreachable, and diverges from
`isLockTimeoutError` for `{code:"P2028", cause:{code:"55P03"}}`); Testing reported
the measured-shape half. Same defect, merged.

**F-M1 / Major / `scripts/checks/check-worker-logtype.mjs` `logTypeVerdict`** —
`alerts.md`'s new catch-all claims it catches worker error logs "including ones
added after this document was last read". The gate accepts *any* non-empty string
literal and never inspects the namespace, so nothing enforces that. Two error-level
identifiers already sit outside the documented five namespaces:
`outbox.depth.alert` and `outbox.depth.check_failed`. They are matched today only
by hand-written named sections — the mechanism the gate was added to replace.
Converges with Testing F7 (red-proved: `_logType: "zzz"` → gate OK, exit 0).

**F-M2 / Major / `scripts/checks/check-rls-read-context.mjs:105` (`SEARCH_DIRS`)** —
the single-file entry `src/lib/health.ts` is the only reason the gate covers the
file this branch fixed. `collectSourceFiles` swallows an unresolvable target, and
the only floor is `scanned === 0`, which the 30 files from `src/workers,scripts`
keep satisfied. Red-proved: a misspelled entry yields `scanned 30 files` / `OK` /
exit 0. Converges with Testing F6. The sibling gate written in the same diff has
this floor (`callSites === 0`); this one does not.

**F-M3 / Major / `docs/operations/alerts.md:11`, `scripts/checks/check-worker-logtype.mjs:13`** —
R29. "19 of the 22 error-level worker logs" / "22 error-level pino calls, three of
which carried `_logType`" does not reproduce. Re-derived against `main`: **25** call
sites, **22** violations, **3** compliant. `22` is the violation count restated as
the total, which makes "three that did" arithmetically inconsistent (22−3=19≠22).
Converges with Testing F5. The conclusion the number supports is true; the number
is not, and it is on four surfaces including a committed doc.

**F-M9 / Major / `infra/fluent-bit/fluent-bit.conf:32`** — R18/R49. `alerts.md` now
tells operators to pipe pino to their SIEM and match `_logType`. The repo's own
reference forwarder is a two-value allowlist `_logType ^(audit|app)$`, which drops
every one of the 22 identifiers this diff adds. The repo already knows this filter
silently drops (`docker-compose.yml:26` says so for `audit-dead-letter`); the diff
adds 22 more to the dropped set and reconciles neither file.
**Bound, stated honestly:** not live data loss today — `docker-compose.logging.yml`
forwards only the `app` service and defines no worker services, so worker stdout
never reaches this filter in any shipped config.

**F-m1 / Minor / `docs/operations/alerts.md:27` vs `:94`** — the catch-all asserts
all five namespaces are error-level; 67 lines later the same document says the two
dead-letter identifiers are warn, and the same commit emits them that way. The
catch-all queries carry no level filter, so the pair matches both rules. Alert
effect benign (double-fire, not a miss); the prose is not.

**F-m2 / Minor (question) / `src/lib/health.ts:108`** — `withTimeout` now races an
*interactive transaction*. On the 3 s check budget the race rejects but the
transaction holds its pool connection to Prisma's own 5 s default; and `$transaction`
adds a `maxWait` rejection under pool saturation that the plain query did not have,
which the narrowed catch now maps to `fail`. **Closes if:** 3 s is intentionally the
outer bound and connection hold-time is acceptable for a dormant check — otherwise
pass `withBypassRls`'s optional `{timeout, maxWait}`.

**F-m3 / Minor (question) / `src/lib/health.ts:105`** — `withBypassRls` throws
`INVALID_RLS_NESTING` under an ambient `withTenantRls`. `runHealthChecks` has no
non-test caller today, and this diff removed the docblock sentence saying wiring it
up needs the fix first — so wiring is the expected next step. If wired under a
tenant context, `checkAuditOutbox` throws, `pgErrorCode` returns null, and the check
reports `fail`: a plausible wrong answer rather than a refusal. **Closes if:** the
intended caller is a probe path outside any tenant context.

## Security Findings

**F-C1 / Critical / `scripts/checks/check-rls-read-context.mjs:299-324`
(`bindingIndex` / `resolveBinding`), consumed at `:436` and `:520`** —
`escalate: false`. Scope-blind, file-wide binding resolution clears a bare-client
read of an RLS table. `bindingIndex` maps name → initializer text per *file* with
"first declaration wins" and no scope awareness, so when two functions bind the
same local name — one to a threaded `tx`, one to the bare client — the second is
adjudicated using the first's initializer.

Red-proved by the orchestrator independently (synthetic tree, temp dir only):

```
drain(tx)      { const db = tx;     db.$queryRaw`... audit_outbox` }   // indexed first
depthAlert(tx) { const db = prisma; db.$queryRaw`... audit_outbox` }   // NOT flagged
→ check-rls-read-context: OK   exit 0

control: delete drain, leave depthAlert byte-identical
→ <fixture>:6  db.$queryRaw  ->  audit_outbox   exit 1
  (a synthetic fixture under mktemp -d, not a repo file)
```

The only difference is the earlier same-named binding, which pins the cause on the
index rather than on the statement. `depthAlert` is not a hypothetical shape — it is
the name and the shape of the defect this gate's own docblock says shipped to
production and raised 22P02 every 30 s.

**R49 aggravation.** The one-hop form also fails open on `main` (verified by running
`git show main:...` against the same fixture: OK, exit 0), so the resolver defect
predates this branch. What this branch changes is the *claim*: it deletes main's
honest `FALSE + alias chains longer than ONE hop are flagged…` note and replaces it
with `CAUGHT … client alias chains (const p = prisma, and chains up to
ALIAS_HOP_LIMIT hops)`. The declaration is now stronger than the implementation in
the direction R49 rates Critical, and this gate is the sole control for the class —
`check-bypass-rls.mjs` is an allowlist over *usage* and is structurally unable to
report a missing context.

**F-M4 / Major / `src/workers/audit-outbox-worker.ts:1841`** — R3. The commit visits
all three worker pool-error handlers to add `_logType`. Two log only the errno code,
with the reason stated inline (*"leaking pg connection target/username via
err.message (S6/S7)"*, `src/workers/retention-gc-worker/index.ts:149`; same shape at
`src/workers/audit-anchor-publisher.ts:446`). The third keeps `{ err }`. pino's default `err`
serializer emits `message` and `stack`; pg pool errors carry text such as
`password authentication failed for user "passwd_outbox_worker"` and
`getaddrinfo ENOTFOUND <db-host>`. `src/lib/logger.ts:22` redacts by top-level key
name, which does not reach message text, so the DB role name and connection target
land verbatim in shipped, indexed logs.

**F-M5 / Major / `docs/operations/alerts.md:8` (claim) vs
`scripts/checks/check-worker-logtype.mjs:77` (`SEARCH_DIRS`)** — R42/R49. The doc's
class is "logs emitted by a worker"; the gate's class is "files under `src/workers`
and `scripts`". `src/workers/audit-outbox-worker.ts:1032` lazily imports `deliverToWebhookRecords`
from `@/lib/webhook-dispatcher`, whose two error-level pino calls carry no `_logType`:
`src/lib/webhook-dispatcher.ts:201` (webhook secret decryption failed — master-key/AAD-version
failure on an active webhook) and `src/lib/webhook-dispatcher.ts:234` (webhook dispatch error). Both execute in
the worker process at error level; the new catch-all matches neither. The gate's
`MISSED` block enumerates receiver shapes only and does not declare this directory
boundary.

**F-m5 / Minor / `scripts/checks/check-worker-logtype.mjs:29` vs `:96`** — R47. The
`MISSED` clause says the receiver "has to be `getLogger()` or a same-file binding of
it". Two spellings a reader of that sentence would expect covered are silently
passed (red-proved): `const child = getLogger().child({...}); child.error(...)` and
`let late; late = getLogger(); late.error(...)`. `loggerBindings` only reads
`VariableDeclaration` initializers whose text is exactly `getLogger`. The `.child()`
form matters most — it is pino's canonical per-worker pattern and the natural next
edit to the four `const log = getLogger()` sites in `audit-outbox-worker.ts`.
Converges with Testing F15.

**F-m6 / Minor (question) / `src/lib/logger.ts:21`** — R40. *(Closed after the
review round — see Resolution Status.)* `base` writes
`_logType: "app"` into every record; the per-line merge object adds a second one, so
each alert line emits a duplicate JSON key. Last-wins parsers (Go `encoding/json`,
JS `JSON.parse`) yield the intended value, but a first-wins or reject-duplicates
parser makes the new catch-all match nothing — and its silence reads as a healthy
pipeline. Predates the branch (three call sites already had it). **Closes if:** the
deployment's pipeline resolves duplicate keys last-wins and the existing
`outbox.depth.alert` rule has been observed firing.

**F-m4 / Minor (question) / `scripts/checks/check-rls-read-context.mjs:52`** — R42.
The "last member of the RLS-context class" premise rests on a false-positive count
(310 in `src/app`, 67 in `src/lib` — both re-derived exactly), which is a
scanning-cost argument, not a membership argument. Both Functionality and Security
sampled the 66 remaining `src/lib` violations and could not name a second true
member (`src/lib/auth/session/auth-adapter.ts:99` is reached only from inside `withBypassRls` callbacks;
`blob-store/cleanup.ts` takes a threaded `TxOrPrisma`; `services/*` are
route-scoped). **Closes if:** the derivation is stated as a property — "every
`src/lib` module reaching a Prisma statement is entered either from a route handler
under a context helper or from a worker in SEARCH_DIRS" — with the entry-point
enumeration behind it, rather than the false-positive count.

**Verified, not findings** (recorded so the negatives are not read as unexamined):
- `["src/lib/health.ts", []]` in `check-bypass-rls.mjs` is correct and fails closed.
  `[]` is truthy, so `allowedSet` becomes an empty `Set` and *every* model accessor
  reached in the callback is flagged — a future `tx.auditLog.findMany()` reds the gate.
- The bypass itself is justified: whole-deployment backlog depth is inherently
  cross-tenant, the purpose is recorded in `app.bypass_purpose`, and the statement is
  a fixed `COUNT(*)`/`MIN(created_at)` over one table returning no row data.
- No information disclosure to unauthenticated callers today: `runHealthChecks` has
  no non-test caller; `/api/health/ready` calls `runReadinessChecks`, which excludes
  `auditOutbox` per C20 / OWASP A05-1. That boundary is intact.
- R54 / AsyncLocalStorage does not leak: `withBypassRls` scopes the store via
  `tenantRlsStorage.run` around `fn(tx)` only, and `runHealthChecks` invokes
  `checkDatabase`/`checkRedis` before `checkAuditOutbox` enters the store.
- CI wiring is complete: `.github/workflows/ci.yml:242` runs
  `PRE_PR_STATIC_ONLY=1 bash scripts/pre-pr.sh`, so the new gate runs in CI (no R33 drift).

## Testing Findings

**F-C2 / Critical / `src/__tests__/lib/health.test.ts:127`, `src/lib/health.test.ts:128`,
`src/lib/prisma/prisma-error.ts:22`** — merged with Functionality's ordering finding.

Both new suites build the Prisma failure fixture as `{ code: "P2010", meta: { code: sqlstate } }`.
The repo has **already measured** the shape the pg driver adapter produces, in
`src/__tests__/db-integration/helpers.ts:174` (`sqlStateOf`, docblock: *"The pg driver
adapter nests the code at `meta.driverAdapterError.cause.code`; other paths render it
into the message"*), pinned by fixture at `src/__tests__/db-integration/helpers.test.ts:33` and confirmed against a
real database at `src/__tests__/db-integration/audit-outbox-depth-check.integration.test.ts:106`.

Orchestrator re-ran both functions verbatim over five shapes:

| shape | `pgErrorCode` | `sqlStateOf` |
|---|---|---|
| `meta.driverAdapterError.cause.code` (MEASURED) | **null** | 42P01 |
| `Code: \`42P01\`` in message (MEASURED) | **null** | 42P01 |
| `meta.code` (the shape the new tests invent) | 42P01 | 42P01 |
| direct `err.code` | 42P01 | null |
| `{code:"P2028", cause:{code:"55P03"}}` | **P2028** | null |

So the `42P01 → warn` branch the change was written for is green against a shape
production may never emit, and against the shape the repo measured `checkAuditOutbox`
falls through to `fail` — a **503 on a pre-migration tree**, the one case the graceful
degradation exists for. The test cannot see this because it is the sole author of its
input. Row 5 is Functionality's half: the early return hands back the Prisma wrapper
code instead of descending to the SQLSTATE, so `pgErrorCode` and `isLockTimeoutError`
decide differently about the same error (R48).

**F-M6 / Major / `src/lib/health.ts:104`** — RT5. Both suites `vi.mock("@/lib/tenant-rls")`,
so `withBypassRls` never executes: no `$transaction`, no `set_config`, no pooled
connection. The defect being fixed is defined entirely by runtime GUC state — precisely
what a mock cannot express. `checkAuditOutbox` is module-private, so no test in the repo
*can* reach it against a real connection. The precedent is in the tree and was not
followed: `src/workers/audit-outbox-worker.ts:1794` exports `readOutboxDepth` as a seam solely for
this, and `src/__tests__/db-integration/audit-outbox-depth-check.integration.test.ts:84` drives it against a
deliberately poisoned pooled connection with a 22P02 control clause.

**F-M7 / Major / `src/lib/health.test.ts:47`** — RT9 twin drift. `src/__tests__/lib/health.test.ts:139`
asserts `mockWithBypassRls` was called with the purpose. The co-located twin mocks the
same module and wires an implementation but never references `mockWithBypassRls` in an
assertion (`rg -n mockWithBypassRls src/lib/health.test.ts` → lines 7, 12, 25, 47 and
nothing else). Because that mock forwards to the same `mockQueryRaw`, deleting
`withBypassRls(...)` from `health.ts` changes no observable value in that suite. One twin
pins the new invariant, the other silently accommodates its removal.

**F-M8 / Major / `src/workers/audit-outbox-worker.ts:881, 1300`** — the diff creates two
new **warn**-level alert rules, documents them with SIEM queries matching those exact
literals at severity high, then leaves them outside both forms of enforcement:
`ALERT_LEVELS` is `{error, fatal}` so the gate never sees them, and
`rg '"delivery.dead_lettered"' --glob '*.test.*'` returns nothing. This is the shape the
commit message itself calls "the worst version" — a document true of what someone
remembered — reinstated at warn level. The pattern to close it is in the same worker's
own suite (`src/workers/audit-outbox-worker.test.ts:1719` pins `outbox.depth.check_failed` by exact
literal *and* level).

**F-M-new / Major / `src/lib/prisma/prisma-error.test.ts` (untouched)** — RT6. `pgErrorCode`
is a new exported symbol whose sibling test file already exists in the same directory and
does not appear in the diff. Folded into F-C2's remedy.

**Minors** — F-m7 `check-worker-logtype.test.mjs:132` (every PASSES case still passes with
its subject line deleted; the anchor alone carries it — measured 6/6 green. Not vacuous in
the mutation sense, but no case can detect a gate that stops parsing the subject region
while still recognising the anchor); F-m8 `src/__tests__/lib/health.test.ts:136`
(undifferentiated `mockQueryRaw` makes the database check reject in lockstep, so the outbox
cases cannot assert `result.status` — the co-located twin's SQL-discriminating
implementation can); F-m9 `:175` (fake timers toggled inside test bodies with no `afterEach`
restore; `beforeEach` sets no `mockQueryRaw` default and `clearAllMocks` does not reset
implementations, so the never-resolving timeout implementation persists); F-m10
`check-worker-logtype.test.mjs:92` (FAILS cases assert only exit status and filename, never
which of the three `REASON` classifications was printed); F-m11 `src/__tests__/lib/health.test.ts:22`
(`BYPASS_PURPOSE.SYSTEM_MAINTENANCE` value is invented by the mock factory and asserted as a
string literal, so a change to the real constant stays green); F-m12
`check-worker-logtype.test.mjs:30` (`afterAll` calls `rmSync(root)` where `root` is assigned
inside `beforeAll`; a `mkdtempSync` failure raises a TypeError masking the real cause);
F-m13 (third and fourth hand-rolled copies of the unwrap at
`src/__tests__/db-integration/audit-outbox-concurrent-delivery.integration.test.ts:36` and `src/__tests__/db-integration/helpers.test.ts:157`).

**Mutation verification performed by the Testing expert** (no repo file modified; all
mutations on copies under `mktemp -d`): `check-worker-logtype.mjs` — 11 single-clause
mutations, each reddening exactly its own case set. `check-rls-read-context.mjs` — 8
mutations covering the ElementAccess branch, the bare-Identifier branch, `ObjectBindingPattern`,
destructure-rename, hop limit, alias-following, and the `seen` guard (stack overflow observed).
Both gates' self-tests are genuinely red-provable on every isolable clause. `310`/`67`/
`1 violation before, 0 after` all re-derived exactly; only `19 of 22` failed to reproduce.

## Adjacent Findings
- [Adjacent] Major — two parallel health suites edited in the same diff with non-identical
  `auditOutbox` cases (Functionality → Testing; adopted as F-M7).
- [Adjacent] Major — both suites mock `withBypassRls` wholesale and `pgErrorCode` has no test
  of its own (Functionality, Security → Testing; adopted as F-M6 / F-C2).
- [Adjacent] Minor — third and fourth copies of the three-shape unwrap in db-integration tests
  (Functionality → Testing; adopted as F-m13).
- [Adjacent] Minor — file-wide, scope-blind `bindingIndex` (Functionality → Security; Security
  escalated it to Critical F-C1 by execution. Functionality assessed it "fail-closed on today's
  tree"; Security's synthetic-tree run showed fail-OPEN. The orchestrator reproduced Security's
  result independently — Security is correct).
- [Adjacent] Major — health probe returns 503 instead of `degraded` on an unmigrated deployment
  (Testing → Functionality; part of F-C2).
- [Adjacent] Major — whether `outbox.*` belongs in the catch-all regex is an operations decision
  (Testing → Functionality; part of F-M1).

## Quality Warnings
None. Every Critical and Major finding carries an executed reproduction, and the two Criticals
were independently re-executed by the orchestrator before acceptance. Three findings are
correctly ranked as questions per Finding Floor clause 2 (F-m2, F-m3, F-m4, F-m6).

One cross-expert conflict was adjudicated rather than merged: Functionality rated the
scope-blind `bindingIndex` a Minor Adjacent on the grounds it is "fail-closed on today's tree";
Security red-proved it fail-open. Execution beats assessment — Security's rating stands.

## Recurring Issue Check
### Functionality expert
R1: F-C2 · R2: clean · R3: F-M9 · R4: n/a · R5: clean · R6: n/a · R7: n/a · R8: n/a · R9: clean ·
R10: clean · R11: n/a · R12: F-M1 · R13: clean · R14: n/a · R15: n/a · R16: clean · R17: F-C2 ·
R18: F-M9 · R19: clean (prod), Adjacent (tests) · R20: clean (all 22 edits spot-checked) ·
R21: n/a · R22: clean · R23: n/a · R24: n/a · R25: n/a · R26: n/a · R27: n/a · R28: n/a ·
R29: F-M3 · R30: clean · R31: n/a · R32: n/a · R33: clean · R34: clean · R35: n/a · R36: clean ·
R37: clean · R38: n/a · R39: n/a · R40: clean · R41: clean · R42: F-m4, F-M1 · R43: n/a ·
R44: clean · R45: clean · R46: Adjacent → F-C1 · R47: clean · R48: F-C2 · R49: F-M1, F-M9, F-M3 ·
R50: F-M2 · R51: n/a · R52: clean · R53: clean · R54: clean · R55: clean · R56: n/a · R57: n/a

### Security expert
R1: clean · R2: clean · R3: F-M4 · R4: n/a · R5: clean · R6: n/a · R7: n/a · R8: n/a · R9: clean ·
R10: clean · R11: n/a · R12: clean · R13: n/a · R14: clean · R15: n/a · R16: clean · R17: clean ·
R18: clean · R19: clean · R20: clean · R21: n/a · R22: clean · R23: n/a · R24: n/a · R25: n/a ·
R26: n/a · R27: n/a · R28: n/a · R29: F-m4 · R30: clean · R31: n/a · R32: n/a · R33: clean ·
R34: clean · R35: n/a · R36: clean · R37: clean · R38: n/a · R39: n/a · R40: F-m6 · R41: clean ·
R42: F-M5, F-m4 · R43: evaluated — PASS side widened; the fail-open is the pre-existing
scope-blind lookup it amplifies (F-C1) · R44: clean · R45: clean · R46: **F-C1** · R47: F-m5 ·
R48: clean · R49: **F-C1**, F-M5, F-m5 · R50: clean · R51: clean · R52: clean · R53: clean ·
R54: clean (verified `tenantRlsStorage.run` scoping and sibling-check ordering) · R55: clean ·
R56: n/a · R57: n/a
RS1: n/a · RS2: n/a · RS3: clean · RS4: clean · RS5: n/a · RS6: clean

### Testing expert
R1: Adjacent · R2: clean · R3: F-M8 · R4: n/a · R5: clean · R6: n/a · R7: n/a · R8: n/a · R9: n/a ·
R10: clean · R11: n/a · R12: n/a · R13: n/a · R14: n/a · R15: n/a · R16: clean · R17: Adjacent ·
R18: clean · R19: F-M7, F-m11 · R20: clean · R21: n/a · R22: F-C2 · R23: n/a · R24: n/a · R25: n/a ·
R26: n/a · R27: n/a · R28: n/a · R29: **F-M3** · R30: clean · R31: n/a · R32: n/a · R33: clean ·
R34: clean · R35: n/a · R36: clean · R37: clean · R38: n/a · R39: n/a · R40: n/a · R41: F-M1 ·
R42: F-M8 · R43: n/a · R44: clean · R45: clean · R46: clean-by-mutation (Security's scope case
was outside this expert's fixtures) · R47: F-M1 · R48: F-C2 · R49: F-M1 · R50: **F-M2** ·
R51: n/a · R52: F-M2 · R53: n/a · R54: n/a · R55: n/a · R56: n/a · R57: n/a
RT1: **F-C2**, F-m11 · RT2: clean · RT3: F-m11 · RT4: n/a · RT5: **F-M6** · RT6: F-C2 ·
RT7: clean for both gates (19 mutations run, all red as claimed); F-M2 for the scan-target floor ·
RT8: assessed, largely cleared; F-m7 residual · RT9: **F-M7** · RT10: clean on pairing; F-m5 on
axis combinations · RT11: clean on scoping and failure-path ordering; F-m12 residual

## Environment Verification Report
N/A — no environment constraints declared in Phase 1 (no Phase 1 for this branch).

All verification for this round ran locally: `npx vitest run` (14904 passed),
`npx next build`, `bash scripts/pre-pr.sh` (73 checks). Both gates were additionally
driven against synthetic trees under `mktemp -d` via their documented env overrides;
no repo file was modified during verification.

## Resolution Status

All 2 Critical, 9 Major and 13 Minor findings fixed in round 1. No finding was
deferred, so there are no Anti-Deferral entries.

### F-C1 Critical — scope-blind file-wide binding resolution (fail-open)
- Action: replaced the per-file `bindingIndex` ("first declaration wins") with
  `resolveBindingAt(node, name)`, which walks enclosing scopes outward from the
  statement, innermost binder first. Two sibling scopes binding the name with
  neither enclosing the read now resolve to nothing, so the statement is
  reported — unresolvable fails closed. The `CAUGHT` declaration was corrected
  to say bindings resolve from the statement.
- Modified: `scripts/checks/check-rls-read-context.mjs:347-360` (`resolveBindingAt`), `:33-38` (the CAUGHT clause)
- Red-proof (per clause, by execution): (a) reverting to file-wide resolution
  reddens both shadow-DENY cases and the inner-block ALLOW case; (b) reversing
  the walk to outermost-first reddens the inner-block ALLOW case. Allow side
  pinned: 1-hop, 3-hop and destructure-rename chains inside a context callback
  all stay silent, and the real tree stays at 0 violations over 31 files.
- Note: the first version of the new DENY self-test cases used `tx: any` and so
  passed for the wrong reason — mutation (a) left them green. Corrected to
  `tx: Prisma.TransactionClient`, which is what makes the sibling binding
  context-bearing. Caught by running the mutation rather than reasoning about it.

### F-C2 Critical — pgErrorCode missed both measured shapes; 42P01 branch dead
- Action: rewrote `pgErrorCode` with the ordering `sqlStateOf` established
  against a real database (adapter nesting → `meta.code` → direct `err.code` →
  `err.cause.code` → message rendering), and made `sqlStateOf` delegate to it so
  one predicate has one adjudicator (closes the R48 half). Prisma codes are
  excluded by pattern `P[1-9]\d{3}`, not by length, because SQLSTATE class P0 is
  real. Both health suites now build fixtures from the measured shape.
- Modified: `src/lib/prisma/prisma-error.ts:19-28` (the Prisma/SQLSTATE discriminator) and `:52-84` (`pgErrorCode`),
  `src/__tests__/db-integration/helpers.ts:185` (`sqlStateOf` delegates),
  `src/lib/prisma/prisma-error.test.ts` (+20 cases), both health suites.
- Red-proof (one mutation per clause): dropping the adapter branch reddens 4
  cases including both health suites; dropping the message branch reddens 1;
  accepting any 5-char code as a SQLSTATE reddens 2. Allow side pinned: the
  P2010+`meta.code` shape still resolves, a plain Error still yields null, and a
  real `PrismaClientKnownRequestError` still maps as before.

### F-M1 / F-M7(test) Major — gate accepted any literal; `outbox.*` unmatched
- Action: the namespace set now lives in an `<!-- alert-namespaces: -->` marker
  in alerts.md and the gate READS it, so there is one list rather than two.
  `outbox` added (it was already being emitted outside the documented set). An
  unreadable document or an empty marker fails loudly.
- Modified: `scripts/checks/check-worker-logtype.mjs:132-166` (`loadAlertNamespaces`) and the namespace clause in `logTypeVerdict`,
  `docs/operations/alerts.md` catch-all section (the `alert-namespaces` marker).
- Red-proof: `_logType: "zzz.broke"` reddens naming the namespace; all 29 real
  call sites stay green and the gate prints the set it enforced.

### F-M2 Major — a scan target that stops resolving is dropped silently
- Action: added `unresolvedTargets()` to the shared AST helper and a per-ENTRY
  floor to both gates, placed AFTER the manifest/schema load so "cannot read the
  contract" still reports before "cannot find the subjects".
- Modified: `scripts/checks/lib/ast-project.mjs:187` (`unresolvedTargets`), `scripts/checks/check-rls-read-context.mjs:491`, `scripts/checks/check-worker-logtype.mjs` (same floor).
- Red-proof: a misspelled single-file entry alongside a resolving directory
  entry now exits non-zero naming only the missing one. Allow side: the real
  defaults still print `scanned 31` / OK.

### F-M3 Major — "19 of 22" does not reproduce
- Action: corrected to 25 call sites / 22 without / 3 with, in both the gate
  docblock and alerts.md, each with the re-deriving command and a note that the
  default `SEARCH_DIRS` scans more than `src/workers`.
- Modified: `scripts/checks/check-worker-logtype.mjs:13` (docblock), `docs/operations/alerts.md:8`

### F-M4 Major — `worker.pool.error` logged the full pg error
- Action: `{ code: … ?? "unknown" }` only, matching the two sibling pool handlers
  and their stated S6/S7 reason. The errno survives, so the rate-based alert
  alerts.md prescribes is unaffected; the message and stack, which carry the role
  name and connection target, do not.
- Modified: `src/workers/audit-outbox-worker.ts:1850`

### F-M5 Major — `_logType` class was directory-scoped, doc's was process-scoped
- Action: added `src/lib/webhook-dispatcher.ts` as a single-file scan target
  (the outbox worker drives it) rather than widening to `src/lib`, which would
  make the gate a wall. Running it then found **two more** uncovered sites in
  that file beyond the two the review named. alerts.md's opening sentence now
  states the enforced scope.
- Modified: `scripts/checks/check-worker-logtype.mjs:98` (SEARCH_DIRS),
  `src/lib/webhook-dispatcher.ts:207,236,357,446`, `src/lib/webhook-dispatcher.test.ts:173`

### F-M6 Major — nothing exercised the real withBypassRls
- Action: exported `readAuditOutboxDepth` as a seam (mirroring `readOutboxDepth`)
  with an injectable client, and added
  `src/__tests__/db-integration/health-outbox-depth.integration.test.ts` driving
  it as `passwd_app` on a `max: 1` pool with the GUC poisoned.
- Modified: `src/lib/health.ts:114` (`readAuditOutboxDepth`), new integration test.
- Red-proof: removing `withBypassRls` from the seam fails the delta assertion
  with 22P02. Preconditions asserted, not inferred: the poison is verified by
  reading `current_setting('app.tenant_id', true) === ''`, and a control case
  pins that the un-bypassed query really does raise 22P02 on that connection.

### F-M8 Major — two documented warn-level rules had no coverage
- Action: closed in the derived direction rather than with two hand-written
  tests. The gate collects every `_logType` literal emitted at ANY level and
  requires each identifier alerts.md gives a named section to, within a declared
  namespace, to be one of them. Restricting to declared namespaces is what keeps
  the list derived: `audit-dead-letter`, `csp.violation`, `CHAIN_VERIFY_FAILED`
  and the chain-verify heartbeat come from elsewhere and drop out by
  construction, not by an exclusion list.
- Modified: `scripts/checks/check-worker-logtype.mjs:168` (`documentedIdentifiers`), `:341` (the orphan sweep)
- Red-proof: renaming `delivery.dead_lettered` in the worker reddens naming the
  orphaned rule. Allow side: a documented identifier emitted at warn passes.

### F-M9 Major — Fluent Bit dropped every new identifier
- Action: extended the grep filter's alternation to the declared namespaces, with
  the reason and the duplicate-key caveat recorded inline.
- Modified: `infra/fluent-bit/fluent-bit.conf:26`
- Bound restated: not live data loss today, because no shipped compose overlay
  forwards worker services.

### Minors
- **F-m1** alerts.md now says which members are warn rather than claiming all are
  error-level. **F-m5** the gate's `MISSED` list now names `.child()` and
  assignment-form bindings, both measured. **F-m6** the duplicate `_logType` key
  is confirmed by execution and documented in alerts.md and the Fluent Bit config
  as a last-wins requirement, with the cheap fix named — see Open Questions.
  **F-m7** PASSES cases assert the recognised call-site count (red-proved by
  making the gate stop parsing past the first call). **F-m8/F-m9** the
  centralized health suite discriminates by SQL and resets implementations.
  **F-m10** FAILS cases assert the REASON classification. **F-m11** both suites
  take `BYPASS_PURPOSE` from the real module. **F-m12** teardown guards `root`.
  **F-m13** the two db-integration copies of the unwrap are now reachable through
  `sqlStateOf`, which delegates to `pgErrorCode`.

### Open questions carried forward (Minor, correctly ranked as questions)
These rest on intent the change does not contain, so per Finding Floor clause 2
they are recorded rather than acted on. F-m6 was the exception: it was the one
whose answer every alert rule depended on, so it was closed by removing the
dependency rather than carried.

- **F-m2** `withTimeout` now races an interactive transaction: on the 3 s budget
  the race rejects but the transaction holds its connection to Prisma's 5 s
  default, and `maxWait` adds a rejection path the plain query lacked. Closes if
  3 s is intentionally the outer bound; otherwise pass `withBypassRls`'s
  `{timeout, maxWait}`.
- **F-m3** `withBypassRls` throws `INVALID_RLS_NESTING` under an ambient
  `withTenantRls`. `runHealthChecks` still has no non-test caller. Closes if the
  intended caller is a probe path outside any tenant context.
- **F-m4** the "last member of the RLS class" premise rests on a false-positive
  count, which is a scanning-cost argument rather than a membership one. Two
  experts independently sampled the 66 remaining `src/lib` violations and could
  name no second true member. Closes if the derivation is stated as a property
  with the entry-point enumeration behind it.
- ~~**F-m6** whether the deployment's log pipeline resolves duplicate JSON keys
  last-wins.~~ **CLOSED — the dependency was removed instead.** Verification was
  the alternative and is not available here: no Fluent Bit or SIEM runs in this
  environment, and `outbox.depth.alert` has never fired against a dev outbox at
  depth 0, so there is no ingestion record to point at. The app logger's base now
  carries `_stream: "app"` and `_logType` is single-valued, so no rule in
  alerts.md rests on duplicate-name resolution. Pinned by
  `src/__tests__/logger.test.ts`, asserting on the raw line — `JSON.parse` is
  last-wins and would hide the defect. Red-proved twice: reverting the base
  reddens both new cases, and asserting on the parsed record instead of the raw
  line leaves the duplicate-key case green, which is what makes the raw-line
  assertion load-bearing rather than stylistic. The Fluent Bit keep-filter moved
  to `_app` (set by both pino instances), which also retired the namespace
  alternation added earlier in this branch — a second list that would have had to
  be kept in step with the alert-namespaces marker.

## Verification
Final state of the branch unless noted:

- `npx vitest run` — 1019 files, 14930 passed
- `npx next build` — success
- `bash scripts/pre-pr.sh` — 73/73
- `npx vitest run --config vitest.integration.config.ts` — 102 files, 625 passed
  (compose workers stopped for the run, restarted after). **Run BEFORE the
  `_stream` logger change**, so it does not cover that commit. Not re-run, and
  the reason is that the change is out of its reach rather than merely unlikely
  to matter: the integration suite exercises database behaviour, and no case in
  it asserts on a log record's shape. What the change does touch — the pino base,
  the single-key property, and the real redact paths — is covered by
  `src/__tests__/logger.test.ts` in the unit run above, which was re-run after
  the change and is where that behaviour is pinned.

## Round 2 decision
Not required. Every round-1 finding is fixed and verified; the remaining items
are the three questions above (F-m6 was closed by removing the dependency rather
than answering it), which are Minor by Finding Floor clause 2 and none of which
touch a security boundary. The tightening-only skip does not apply — this round's
fixes are substantive, not inline minors — so the stop condition is the ordinary
one: no unresolved findings.

R42 note: no class in this review expanded its member-set twice, so the
expanding-class convergence condition does not apply. Both classes closed in this
round are guarded by mutation-verified CI gates wired into `scripts/pre-pr.sh`
(`Static: rls-read-context`, `Static: worker-logtype`), which is the artifact
that condition would have demanded.
