# Code Review: rls-health-context-and-gate-gaps
Date: 2026-08-26
Review round: 1

Phase 3 standalone — no Phase 1 plan or deviation log exists for this branch; the
work came from a session handoff. Plan/deviation cross-checks in the Phase 3
template are therefore `N/A`, and the "Implementation Checklist vs diff" check
has no checklist to read.

## Changes from Previous Round
Initial review.

## Merge method
Mechanical merge pre-pass over the three experts' fenced json indices, joined on
(file, line ±5, root cause). Prose consolidation done by the orchestrator rather
than through `merge-findings` — the json join had already resolved every
duplicate group and the three raw outputs were in context. Convergence groups are
stamped with the severity floor per "Perspective Convergence as a Severity
Signal".

35 raw findings across three experts → 24 consolidated (2 Critical, 9 Major,
13 Minor).

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
→ src/workers/probe.ts:6  db.$queryRaw  ->  audit_outbox   exit 1
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
err.message (S6/S7)"*, `retention-gc-worker/index.ts:149`; same shape at
`audit-anchor-publisher.ts:446`). The third keeps `{ err }`. pino's default `err`
serializer emits `message` and `stack`; pg pool errors carry text such as
`password authentication failed for user "passwd_outbox_worker"` and
`getaddrinfo ENOTFOUND <db-host>`. `src/lib/logger.ts:22` redacts by top-level key
name, which does not reach message text, so the DB role name and connection target
land verbatim in shipped, indexed logs.

**F-M5 / Major / `docs/operations/alerts.md:8` (claim) vs
`scripts/checks/check-worker-logtype.mjs:77` (`SEARCH_DIRS`)** — R42/R49. The doc's
class is "logs emitted by a worker"; the gate's class is "files under `src/workers`
and `scripts`". `audit-outbox-worker.ts:1032` lazily imports `deliverToWebhookRecords`
from `@/lib/webhook-dispatcher`, whose two error-level pino calls carry no `_logType`:
`webhook-dispatcher.ts:201` (webhook secret decryption failed — master-key/AAD-version
failure on an active webhook) and `:234` (webhook dispatch error). Both execute in
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

**F-m6 / Minor (question) / `src/lib/logger.ts:21`** — R40. `base` writes
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
member (`auth-adapter.ts:99` is reached only from inside `withBypassRls` callbacks;
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
into the message"*), pinned by fixture at `helpers.test.ts:33` and confirmed against a
real database at `audit-outbox-depth-check.integration.test.ts:106`.

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
followed: `audit-outbox-worker.ts:1794` exports `readOutboxDepth` as a seam solely for
this, and `audit-outbox-depth-check.integration.test.ts:84` drives it against a
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
own suite (`audit-outbox-worker.test.ts:1719` pins `outbox.depth.check_failed` by exact
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
which of the three `REASON` classifications was printed); F-m11 `health.test.ts:22`
(`BYPASS_PURPOSE.SYSTEM_MAINTENANCE` value is invented by the mock factory and asserted as a
string literal, so a change to the real constant stays green); F-m12
`check-worker-logtype.test.mjs:30` (`afterAll` calls `rmSync(root)` where `root` is assigned
inside `beforeAll`; a `mkdtempSync` failure raises a TypeError masking the real cause);
F-m13 (third and fourth hand-rolled copies of the unwrap at
`audit-outbox-concurrent-delivery.integration.test.ts:36` and `helpers.test.ts:157`).

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
_Pending — see round 1 fixes below._
