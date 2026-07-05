# Code Review: PR #637 TOCTOU cap-race hardening — triangulate independent verification

Date: 2026-07-06
Review round: 1
Target: HEAD `2bf38259` (already merged to main) — `git diff HEAD~1...HEAD`
Trigger: user `/triangulate` on top of a human "Approve, 90/100" review.

## Summary

Three expert agents (functionality / security / testing) independently verified the human
review. The human review's headline — "no new Critical/High/Medium" — **does not hold**.
Two mutually-reinforcing findings, both confirmed by the orchestrator with direct evidence:

- **[S1] Critical**: a real per-tenant cap-bypass in `mcp/authorize/consent` (unlocked
  `count → cap-check → updateMany`-claim). A genuine member of the very TOCTOU class the PR
  set out to close, invisible to the guard because the claim write is `updateMany`, not `.create`.
- **[T1/T2] Major**: the CI guard is a **lexical floor**, not a mutation-verified convergence
  artifact. It is structurally blind to the *dominant* production cap shape (`findMany().length`)
  and to byte-aggregate caps. Orchestrator mutation-proof: removing the real `advisoryXactLock`
  from `bridge-code` (a security-critical token-issuance site) leaves the guard **green**.

Per triangulate Step 3-8, a class whose member-set expanded ≥2× (here 1→5→6→10→17) is only
"closed" when a mutation-verified guard goes red on a real omission. This guard cannot.
**The R42 class is NOT closed.**

## Orchestrator-verified evidence

```
# S1 — consent route: count + cap, NO .create (claims via updateMany), NO lock
src/app/api/mcp/authorize/consent/route.ts
  :131  count(mcpClient, tenantId)      # COUNT present
  :134  >= MAX_MCP_CLIENTS_PER_TENANT   # CAP present
  :171  updateMany(...tenantId: null->userTenantId)  # claim = create-equivalent
  grep .create( => 0  |  grep advisoryXactLock => 0
# mirror IS locked:
src/app/api/tenant/mcp-clients/route.ts:149  advisoryXactLock(tx, actor.tenantId)

# T1 — guard blindness, mutation-proven
$ node scripts/checks/check-count-then-create-lock.mjs                 -> OK (exit 0)
$ sed 's/await advisoryXactLock(tx, userId);/\/\/ removed/' bridge-code/route.ts
$ node scripts/checks/check-count-then-create-lock.mjs                 -> OK (exit 0)  # SURVIVED
# bridge-code uses findMany().length + BRIDGE_CODE_MAX_ACTIVE:
  grep -cE '\.(count|aggregate)\(' bridge-code/route.ts => 0   # COUNT_RE never matches
```

Guard-invisible real lock sites (findMany().length or byte-aggregate shape):
`extension/bridge-code`, `auth/tokens/extension-token.ts`, `auth/tokens/mobile-token.ts`,
`auth/session/auth-adapter.ts`, `sends/file` (aggregate + `SEND_MAX_ACTIVE_TOTAL_BYTES`,
excluded by the `MAX_…BYTES` negative-lookahead).

## Security Findings

### [S1] Critical: unlocked per-tenant cap in DCR-consent claim — TOCTOU cap bypass (A\B member)
- File: `src/app/api/mcp/authorize/consent/route.ts:128-181`
- Problem: `withBypassRls` callback does `count(tenantId) → if >= MAX_MCP_CLIENTS_PER_TENANT →
  updateMany` (claim `tenantId: null → userTenantId`) with no advisory lock. The claim
  increments the tenant's client count exactly like the locked mirror in
  `tenant/mcp-clients/route.ts:148-158`. Symmetric-counterpart gap (R42 clause ③ mirror):
  cap enforced on two mirrored surfaces, only one locked. The two surfaces can also race each other.
- Impact: A tenant at `MAX-1` clients exceeds `MAX_MCP_CLIENTS_PER_TENANT` (=10). Register N
  unclaimed DCR clients (distinct names) via `/api/mcp/register`, fire N concurrent consent
  "Allow" POSTs; each reads `count < MAX`, each CAS `updateMany` succeeds (distinct ids → no P2002).
- Fix: `await advisoryXactLock(tx, userTenantId)` as the first statement in the `withBypassRls`
  callback (before the `:131` count). Key on `userTenantId` so it shares lock identity with the
  `tenant/mcp-clients` mirror (which locks on `actor.tenantId`) — serializing both surfaces.
- escalate: true (exploitable per-tenant cap bypass; guard structurally blind to it)

### [S2] Major: guard cannot detect `updateMany`/`upsert`-based cap enforcers
- File: `scripts/checks/check-count-then-create-lock.mjs:49` (`CREATE_RE = /\.create\s*\(/`)
- Problem: create-detector matches only `.create(`; a claim/CAS via `updateMany`/`upsert` that
  bumps the counted set is create-equivalent but invisible. S1 slipped past for exactly this reason.
- Fix: broaden create-detection to include `updateMany`/`upsert` that sets a scoping FK; add S1's
  site as a mutation-kill fixture.

## Testing Findings

### [T1] Major: guard blind to `findMany().length` and byte-aggregate cap shapes (mutation-proven)
- File: `scripts/checks/check-count-then-create-lock.mjs:47-48`
- Problem: `COUNT_RE` matches only `.count(`/`.aggregate(`; the prevailing "evict-oldest"
  `findMany().length` shape and byte caps (`MAX_…BYTES`, negative-lookahead-excluded) never match.
  5 real production sites' locks can be removed with the guard staying green — incl. the
  security-critical `bridge-code`, `extension-token`, `mobile-token`, session `auth-adapter`.
- Fix: add `findMany(` to a count-like alternation; broaden the cap heuristic beyond `MAX_*`/`*_LIMIT`
  name-spelling (better: key on "reads a per-scope table then writes it under an RLS wrapper").

### [T2] Major: guard regression test never proves it catches a real evasion shape (RT7 shape b)
- File: `scripts/__tests__/check-count-then-create-lock.test.mjs:42-49,74-79`
- Problem: the only failing fixture (`CAP_THEN_CREATE_NO_LOCK`) uses `.count()`+`MAX_WIDGETS_PER_TENANT`
  — reverse-engineered from the guard's own regex. No fixture in the real `findMany().length`/byte shapes.
- Fix: add failing fixtures mirroring the real shapes; require exit 1.

### [T3] Major: sole real-DB concurrency proof races a hand-written replica, and runs in NO CI job
- File: `src/__tests__/db-integration/count-then-create-toctou.integration.test.ts:12-72`; CI wiring
- Problem: the test re-implements bridge-code/api-key CAS in raw SQL (its own header admits the
  production path "cannot be raced"), so it proves *a* lock serializes — not that production call
  sites are wired right. And no `.github/workflows/ci.yml` step runs `test:integration`.
- Fix: drive real route handlers / issuers concurrently; wire `test:integration` into a CI job
  (the Postgres service already exists at ci.yml:521).

### [T4] Major: new F3 unused-tx drift guard (48 LOC) has zero regression test
- File: `scripts/checks/check-bypass-rls.mjs:197-211,300-333`
- Problem: no `check-bypass-rls` test exists; the intricate `[\s\S]{0,120}?`-window regex is unproven
  and will silently stop matching after a refactor.
- Fix: add `scripts/__tests__/check-bypass-rls.test.mjs` (non-allowlisted disable+`(tx)=>` → exit 1;
  `tenant-context.ts`-shaped allowlisted → exit 0).

### [T5] Minor: stale-exemption detection asymmetric — F3 allowlist can rot
- Fix: mirror `raw-sql-usage.mjs:376` stale-entry detection into the F3 scan.

### [T6] Minor: `check-raw-sql-usage` lacks a STALE_EXEMPT regression case for the 22-file drop
- Fix: add an `it()` asserting a listed-but-clean file → exit 1 with `STALE_EXEMPT`.

## Functionality Findings

Verdict: the refactor is behavior-preserving in the `.create()`-shaped covered paths. No new
Critical/Major from the correctness angle — BUT the functionality expert derived its member-set
from `.create()` only, so it reported "no missed site" and did NOT flag S1/T1. This is the
triangulation split: security+testing caught what functionality's primitive choice hid.

### [F1] Minor [Adjacent]: 4 lock calls rely on the Prisma-proxy ALS fold, not an explicit `tx`
- Files: `api-keys/route.ts:116`, `sends/file/route.ts:214`, `teams/[teamId]/webhooks/route.ts:120`,
  `teams/[teamId]/passwords/[id]/attachments/route.ts:230`
- Problem: pass bare `prisma` to `advisoryXactLock` inside `withUserTenantRls`/`withTeamTenantRls`;
  the lock lands in the tenant tx only via the ALS re-target — the fragility the PR otherwise removes.
  Pre-existing (SC1-deferred F3 disposition). Future fix: thread `tx` through the wrapper signature.
### [F2] Nit: `service-accounts/[id]/tokens/route.ts` sentinel is a message-matched `Error`, not a class.
### [F3] Nit: `mcp/register/route.ts` `CapExceededError` used at :157/:176, declared at :214 (no TDZ at runtime).

## Adjacent Findings
- Testing [Adjacent]: api-keys lock target on singleton prisma — confirm lock+count+create share one
  connection/tx (advisory *xact* locks release at tx end). Orchestrator note: verified elsewhere
  that `withUserTenantRls` folds `prisma.$executeRaw` into the ambient tx via ALS; correct today,
  but the F1 fragility applies.

## Recurring Issue Check (key rules)
- R42 (class-membership derivation): **Finding S1/S2/T1/T2** — member-set was derived from the
  symptom-ish `.create()` shape (clause ①a violation: the true primitive is "a write that bumps
  the counted set", which includes `updateMany`-claim and the `findMany().length` read shape).
  Accretion signature 1→5→6→10→17 present; clause ①b says a ≥2×-expanded class must re-derive
  from the corrected primitive, not append-and-continue. A\B non-empty (consent). Class NOT closed.
- R38 (fail-open by omission): S1 is fail-open-by-omission (cap not enforced) — Critical floor.
- RT7 shape b (authored-but-unproven gate): T2/T4 — guard/test green without proving red on real shapes.

## Resolution Status
Pending user decision (see orchestrator message). No fixes applied yet — S1 is a security-boundary
change requiring impact analysis + real-flow verification before applying.
