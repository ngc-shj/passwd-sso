# Plan Review: centralize-route-guards (SUPERSEDED)

> **SUPERSEDED — corresponding plan was abandoned. See [`proxy-csrf-enforcement-plan.md`](proxy-csrf-enforcement-plan.md) for the replacement.**

Date: 2026-04-26
Review round: 1
Phase: 1 (Plan Review)

## Changes from Previous Round

Initial review.

## Summary

3 expert agents reviewed the plan in parallel. **9 Major / 13 Minor findings** were raised across the three perspectives. The most significant finding (S1 / F1, raised independently by Functionality and Security experts) is that the plan's `withSession` HOF would lock out the browser extension's Bearer-token flow for password and api-key routes — a pre-migration design gap that must be resolved before implementation begins.

Escalation evaluation: Security expert flagged S1 with `escalate: true`. Orchestrator independent assessment — the finding is concrete, evidence-backed (file paths and line numbers), and the fix is well-scoped (introduce a `withCheckAuth(options)` HOF that maps 1:1 to `checkAuth(req, options)`). This does not require an Opus re-run; it is actionable as-is.

## Functionality Findings

### F1 [Major]: C2 misclassifies mixed-auth routes — `withSession` would regress extension-token callers

- **Plan section**: C2, HOF design table
- **Evidence**:
  - `src/app/api/api-keys/route.ts:69` — `checkAuth(req, { allowTokens: true })`
  - `src/app/api/api-keys/[id]/route.ts:16` — `checkAuth(req, { allowTokens: true })`
  - `src/app/api/passwords/route.ts:135` — `checkAuth(req, { scope: EXTENSION_TOKEN_SCOPE.PASSWORDS_WRITE })`
  - `src/app/api/passwords/[id]/route.ts:77` — `checkAuth(req, { scope: EXTENSION_TOKEN_SCOPE.PASSWORDS_WRITE })`
  - `src/proxy.ts:185-194` — these paths are explicitly Bearer-bypass routes
- **Impact**: Browser extension password create/update/delete + API key management would receive 401.
- **Recommended action**: Introduce `withCheckAuth({ scope?, allowTokens? })` HOF that maps 1:1 to `checkAuth(req, options)`. CI config (`route-guards-config.json`) maps each route to the correct HOF chain per auth class.

### F2 [Major]: C4 enumeration is incomplete — 7 `assertOrigin` call sites omitted

- **Evidence (additional callers found via `grep -rn 'assertOrigin(' src/app/api`)**:
  - `src/app/api/teams/[teamId]/rotate-key/route.ts:69`
  - `src/app/api/teams/[teamId]/webhooks/route.ts:75`
  - `src/app/api/tenant/breakglass/route.ts:31` (plan only lists `[id]`)
  - `src/app/api/tenant/members/[userId]/reset-vault/route.ts:47`
  - `src/app/api/tenant/members/[userId]/reset-vault/[resetId]/revoke/route.ts:30`
  - `src/app/api/tenant/webhooks/route.ts:74`
  - `src/app/api/watchtower/alert/route.ts:39`
- Also: `extension/bridge-code` and `auth/passkey/verify` are listed as "if applicable" but are confirmed callers — remove the hedging.
- **Recommended action**: Add the 7 missing routes to C4; remove "if applicable" hedging.

### F3 [Major]: C2 lists `teams/[teamId]/member-key/route.ts (POST)` — this route has no POST handler

- **Evidence**: `src/app/api/teams/[teamId]/member-key/route.ts` exports only `GET`. File is 85 lines, GET-only.
- **Recommended action**: Remove from C2.

### F4 [Minor]: C3 omits `audit-outbox-metrics/route.ts` (uses `requireMaintenanceOperator` inline, GET-only)

- **Evidence**: `src/app/api/maintenance/audit-outbox-metrics/route.ts:16,58`.
- **Recommended action**: Either include in C3 with note "GET-only; CI gate doesn't cover" OR explicitly defer with rationale.

### F5 [Minor]: AUDIT_LOG_PURGE registration plan misses 3 test consumers + group-coverage decision

- **Evidence**: `HISTORY_PURGE` consumers found via grep:
  - `src/lib/constants/audit/audit.ts:207, 389, 464, 520` (4 group arrays)
  - `src/lib/constants/audit/audit.test.ts:25`
  - `src/components/settings/developer/tenant-webhook-card.test.tsx:163-164`
  - `src/app/api/maintenance/purge-audit-logs/route.test.ts:302`
  - `src/app/api/maintenance/purge-history/route.test.ts:284`
- **Decision needed**: AUDIT_LOG_PURGE goes to TENANT.ADMIN only (not PERSONAL/TEAM HISTORY).
- **Recommended action**: Enumerate all 7 consumer locations in the plan; state explicit group-coverage decision.

### F6 [Minor]: C3 verification doesn't specify `dryRun` flag for the new audit-emit verification

- **Recommended action**: Specify the `--dry-run` flag invocation in the verification command.

### F7 [Minor]: Build verification only at C9 — regressions in C6/C7/C8 not caught early

- **Recommended action**: Add `npx vitest run` (full suite, no path filter) and `npx next build` to C6/C7/C8 verification.

## Security Findings

### S1 [Major, escalate: true → orchestrator-overridden to false]

Same as F1. Concrete and well-evidenced. Orchestrator: no Opus re-run needed; fix is clear (introduce `withCheckAuth({scope, allowTokens})` HOF).

### S2 [Minor]: `route-guards-allowlist.txt` not protected by CODEOWNERS

- **Evidence**: `.github/CODEOWNERS` lists `/scripts/checks/**`, `/scripts/pre-pr.sh`, `/scripts/env-allowlist.ts` but NOT `/scripts/route-guards-allowlist.txt` or `/src/lib/http/guards/**`.
- **Recommended action**: Add to CODEOWNERS as part of C5.

### S3 [Minor]: `audit-chain-verify` "(if exists)" hedge — file confirmed to exist

- **Evidence**: `src/app/api/maintenance/audit-chain-verify/route.ts:91` uses `verifyAdminToken` + inline operator check (lines 106-125) that duplicates `requireMaintenanceOperator`.
- **Recommended action**: Remove "(if exists)" hedging; treat as confirmed migration target. Note: migration to `withMaintenanceOperator` closes the helper-divergence gap.

### S4 [Minor]: F1/S3 forensic note missing — historic `HISTORY_PURGE` rows ambiguous after rename

- **Recommended action**: Add code comment + ops runbook note: "Audit log purges executed before this migration are recorded under `HISTORY_PURGE` with `metadata.targetTable = 'auditLog'`. SIEM queries must include both action values for complete coverage."

### S5 [Info]: S2 CSP form-action localhost deferral verified as correct

- **Evidence**: `cli/src/lib/oauth.ts:405` confirms CLI uses `http://127.0.0.1:<port>/callback`. Tightening CSP would break CLI OAuth PKCE flow.
- **Verdict**: Deferral accepted.

## Testing Findings

### T1 [Major]: Mock strategy unspecified for HOF migration

- **Problem**: Plan's "Regression tests" section is ambiguous between mocking HOFs vs. inner primitives. C4 says "no new tests required" (implies inner-primitive mocks); other sections say "mock the HOF instead of `checkAuth`."
- **Recommended action**: Add explicit constraint to C2/C3/C4: "All migrated route tests continue to mock the inner primitives (`checkAuth`, `assertOrigin`) — HOFs delegate to them. The HOF module barrel (`src/lib/http/guards/index.ts`) is never mocked in route tests."

### T2 [Major]: `with-origin-assertion` test misses the `getAppOrigin()` fallback path

- **Evidence**: `src/lib/auth/session/csrf.ts:34-57` has two paths — `APP_URL` set OR Host-header derivation. C1 test spec only covers the first.
- **Recommended action**: Add to C1 test spec for `with-origin-assertion`: "APP_URL unset, Host present, origin matches derived origin → handler called; APP_URL unset, Host missing → 403."

### T3 [Major]: F3 (dryRun audit) inverts existing assertions — must update tests

- **Evidence**:
  - `src/app/api/maintenance/purge-history/route.test.ts:297-308` asserts `expect(mockLogAudit).not.toHaveBeenCalled()` for dryRun.
  - `src/app/api/maintenance/purge-audit-logs/route.test.ts:316-328` same pattern.
- **Recommended action**: Add to C3 verification: "Update both dryRun test assertions to verify `logAuditAsync` IS called with `metadata.dryRun: true` and `metadata.matched: <count>`."

### T4 [Major]: F1/S3 needs Prisma migration + 5+ test file updates not enumerated

- **Evidence**: `src/lib/constants/audit/audit.ts` uses `as const satisfies Record<AuditAction, AuditAction>`. Adding `AUDIT_LOG_PURGE` to `AUDIT_ACTION` requires:
  1. Prisma `AuditAction` enum update + migration (build-time blocker)
  2. `messages/{en,ja}/AuditLog.json` labels (otherwise `audit-i18n-coverage.test.ts:21-28` fails)
  3. `src/lib/constants/audit/audit.test.ts:25` may need update
  4. `src/components/settings/developer/tenant-webhook-card.test.tsx:163-164` (hardcodes "HISTORY_PURGE")
  5. `purge-audit-logs/route.test.ts:302` (literal "HISTORY_PURGE")
  6. `purge-history/route.test.ts:284` (literal "HISTORY_PURGE" — keep)
- **Recommended action**: Enumerate all 6 update sites in C3. Add Prisma migration as a substep BEFORE the route change (the `satisfies` constraint is a build-time blocker).

### T5 [Minor]: Cross-origin POST test pattern needs Origin header in existing tests

- **Problem**: After `withOriginAssertion` wraps C2 routes, existing tests that don't send an Origin header will get 403 (since missing Origin = forbidden in `assertOrigin`).
- **Recommended action**: Add to C2 verification: "Update all existing POST test fixtures to include `headers: { Origin: 'http://localhost:3000' }`. Add a separate negative test with mismatched Origin → 403."

### T6 [Minor]: T2 (`vi.useFakeTimers` for TTL) requires fetch mock — estimate 40-50 lines

- **Recommended action**: Update T2 plan note from "~30 lines" to "~40-50 lines including fetch mock setup."

### T7 [Minor]: AST scanner has no permanent fixture test

- **Recommended action**: Add to C5: "Add `scripts/check-route-guards.test.ts` with at least 2 fixture cases (conforming → exit 0; bare handler → exit 1)."

### T8 [Minor]: F4 staleness eviction has no test

- **Recommended action**: Add to C9: "Export `_passkeyAuditEmitted` as test-only shim. Add test: fill map to PASSKEY_AUDIT_MAP_MAX, verify the entry with the oldest `lastEmitted` is evicted (not first-inserted)."

### T9 [Minor]: Integration test bypass-RLS path coverage gap

- **Problem**: CI integration job connects as `passwd_app` (NOBYPASSRLS); maintenance routes call `withBypassRls`. The bypass-RLS path is only verified by manual shell scripts.
- **Recommended action**: Document this limitation in C3 considerations.

## Adjacent Findings

- **[Adjacent] (Func → Sec)**: Mixed-auth route + `withOriginAssertion` interaction needs explicit invariant documentation.
- **[Adjacent] (Sec → Func)**: CI gate covers POST/PUT/DELETE/PATCH only; GET-only maintenance routes (audit-outbox-metrics, audit-chain-verify) escape unless explicitly migrated.
- **[Adjacent] (Sec → Test)**: No HOF test for `chrome-extension://` origin (intended-403 boundary documentation).
- **[Adjacent] (Func → Test)**: `requireMaintenanceOperator` return shape `{ ok: true, operator: { tenantId, role } }` matches the planned `MaintenanceOperator` interface — confirmed.

## Recurring Issue Check

### Functionality expert
- R1-R30: see Functionality Findings section above. Notable:
  - R3: Pattern propagation gap → F2 (7 missed sites)
  - R10: Circular import → no cycle (verified)
  - R12: Enum coverage → F5 (group decision + 3 test consumers)
  - R17/R22: Helper adoption coverage → F2

### Security expert
- R1-R30 + RS1-RS3: see Security Findings section. Notable:
  - R1 (utility reimpl): `audit-chain-verify` reimplements `requireMaintenanceOperator` inline (S3)
  - R3 propagation: gap reflected in F2
  - R13: re-entrant audit dispatch → safe (proxy emits via HTTP, not in-process)
  - RS1: timing-safe → preserved
  - RS2: rate limit on new routes → preserved (HOFs delegate to existing limiters)
  - RS3: input validation → S1 fix bundled in C2; flag for ADJACENT review of other C2 routes

### Testing expert
- R1-R30 + RT1-RT3: see Testing Findings. Notable:
  - R12 (Enum coverage): T4 — Prisma + i18n + test cascade
  - R19 (test mock alignment): T1 (mock strategy ambiguity)
  - R30 (change propagation): T4 enumeration
  - RT1: `withSession` ctx shape vs. existing `auth` mock returns — potential drift if `tenantId` is required

## Resolution Status

(updated after plan revision below)
