# Code Review: CSRF / Admin Token / Session Cache (pre-existing findings triangulate)

Date: 2026-04-26
Review round: 1 (validation-only — no diff, no code modification)
Branch: main
Source findings: 3 user-supplied (Low / Low-Info / Info)

## Scope

This is NOT a diff-based review. The branch is clean `main`; the user surfaced 3
pre-existing findings against shipped code and asked to triangulate them. Three
expert sub-agents reviewed the target files and their immediate call graph.

Target files:
- `src/app/api/internal/audit-emit/route.ts`
- `src/proxy.ts` (session cache + extractSessionToken)
- `src/lib/auth/tokens/admin-token.ts`
- `src/lib/auth/access/maintenance-auth.ts`
- `src/app/api/maintenance/purge-history/route.ts`
- `src/app/api/maintenance/purge-audit-logs/route.ts` (sibling)
- `src/app/api/admin/rotate-master-key/route.ts` (sibling)

## Validation of Pre-existing Findings

| ID | Title | Proposed | Functionality | Security | Testing | Final |
|----|-------|----------|---------------|----------|---------|-------|
| pre1 | audit-emit `assertOrigin` missing | Low | Low | Low | Low | **Low** |
| pre2 | Raw session token as cache key | Info | Info | **Minor (upgrade)** — 30s session-revocation bypass window | Medium (test gap) | **Minor** (upgrade) |
| pre3 | Shared ADMIN_API_TOKEN + operatorId | Info | Low (borderline) | **Minor (upgrade)** — purge-audit-logs amplifies; major if token leaks | Medium (no binding test) | **Minor** (upgrade) |

Key escalation rationale:
- pre2: not just a heap-dump exposure — the 30s in-process cache means a session
  revoked via `DELETE /api/sessions/[id]` remains accepted for up to 30s per
  worker. This is a functional auth-bypass window for revocation, not just info.
- pre3: `purge-audit-logs` uses the identical pattern. If `ADMIN_API_TOKEN`
  leaks, an attacker can destroy audit evidence and falsely attribute the act
  to any admin UUID. Severity escalates to Major *conditional on token leakage*.

## New Findings

### Functionality (F1-F4)

- **F1 [Low]**: `purge-audit-logs` uses `AUDIT_ACTION.HISTORY_PURGE` instead of a
  dedicated `AUDIT_LOG_PURGE` action — collapses two semantically different
  operations under the same UI/SIEM label.
  - File: `src/app/api/maintenance/purge-audit-logs/route.ts:94`
- **F2 [Low]**: `rotate-master-key` accepts any active user UUID as `operatorId`,
  not just OWNER/ADMIN — weaker check than the other 4 maintenance routes.
  - File: `src/app/api/admin/rotate-master-key/route.ts:80-92`
  - Fix: replace ad-hoc `user.findUnique` with `requireMaintenanceOperator`.
- **F3 [Info]**: `dryRun` on both purge routes emits no audit log → admin probes
  are unobservable. Compliance gap (SOC 2 / ISO 27001 typically require all
  admin actions to be auditable, including dry runs).
- **F4 [Info]**: `passkeyAuditEmitted` map uses FIFO insertion-order eviction
  rather than staleness-based eviction; under load, recently-active users may be
  evicted prematurely.

### Security (S1-S3)

- **S1 [Minor]**: `audit-emit` `metadata` field has no size/depth/key-count
  bound. Authenticated attacker can inflate `audit_outbox` rows up to ~20/min.
  Fix: add Zod schema with size cap.
- **S2 [Minor]**: CSP `form-action` allows `http://localhost:* http://127.0.0.1:*`
  unconditionally in all environments (proxy.ts:37 — *citation unverified for
  RFC 8252 reference; please confirm*). Fix: gate localhost behind dev-only CSP.
- **S3 [Info]**: same as F1 (action constant collision) — adjacent overlap.

### Testing (T1-T4)

- **T1 [Medium]**: `SESSION_CACHE_MAX = 500` hardcoded in
  `src/__tests__/proxy.test.ts:550` instead of imported from `common.server.ts`.
  Drift = silent false-positive (RT3).
- **T2 [Low]**: TTL expiry path (`proxy.ts:341-352`) has no test using
  `vi.useFakeTimers`. The 30s expiry branch is uncovered.
- **T3 [Low]**: `audit-emit/route.test.ts` hardcodes the literal string
  `"PASSKEY_ENFORCEMENT_BLOCKED"` rather than importing
  `AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED` (RT3).
- **T4 [Low]**: No dedicated unit test for `requireMaintenanceOperator` —
  coverage only via route-level tests with mocked Prisma.

## Adjacent Findings (cross-expert)

- [Adjacent] `/api/admin/*` and `/api/maintenance/*` are not in proxy
  allowlist — they reach the route handler via the default fall-through. Auth
  enforcement is route-handler-only. (Functionality → Security)
- [Adjacent] 30s session revocation cache bypass — overlaps Functionality &
  Security. No test verifies a revoked session is rejected within the cache
  window. (Security → Testing)
- [Adjacent] `_sessionCache` and `_setSessionCache` are exported (proxy.ts:485-486)
  for test access. No production code path imports them, but the surface
  exists. (Security → Functionality)

## Cross-Cutting Pattern (R3)

The Security expert enumerated session-authenticated POST/PUT/DELETE routes
lacking `assertOrigin`:

- `src/app/api/api-keys/route.ts` (POST), `[id]/route.ts` (DELETE)
- `src/app/api/passwords/route.ts` (POST), `[id]/route.ts` (PUT/DELETE)
- `src/app/api/teams/route.ts` (POST)
- `src/app/api/teams/[teamId]/passwords/route.ts` (POST)
- `src/app/api/teams/[teamId]/passwords/[id]/route.ts` (PUT/DELETE)
- `src/app/api/teams/[teamId]/member-key/route.ts` (POST)
- `src/app/api/internal/audit-emit/route.ts` (POST) — pre1

`assertOrigin` is currently applied only to vault-key handling and
authentication operations (~15 routes). The broader pattern of session-only
mutating routes without `assertOrigin` is currently accepted by design (relying
on the SameSite=lax + Content-Type + CSP three-layer baseline). Audit-emit (pre1)
is the one called-out deviation; the broader pattern is a structural concern
rather than a bug per route.

## Recurring Issue Check (consolidated)

| ID | Functionality | Security | Testing |
|----|---------------|----------|---------|
| R1 (utility reimpl) | Checked — no issue | — | — |
| R2 (constants hardcoded) | Checked — no issue | — | T1, T3 |
| R3 (pattern propagation: assertOrigin) | F-pre1 (one called-out site) | S-pre1 + 9 sibling routes (by-design baseline) | — |
| R4 (event dispatch gaps) | Checked — single dispatch site OK | — | — |
| R5 (transaction wrapping) | N/A | N/A | — |
| R6 (cascade delete orphans) | N/A | N/A | — |
| R7 (E2E selector breakage) | N/A | N/A | E2E does not cover targets |
| R8-R30 | No issues | No issues | No issues |
| RS1 (timing-safe compare) | — | PASS — SHA-256 + 32-byte buffers | — |
| RS2 (rate limit) | — | PASS — per-user / global keys | — |
| RS3 (input validation) | — | PASS for maintenance, FAIL for audit-emit (S1) | — |
| RT1 (mock-reality divergence) | — | — | No issue |
| RT2 (testability) | — | — | Redis migration not unit-testable |
| RT3 (shared constants in tests) | — | — | T1, T3 |

## Resolution Status

This review is **validation-only**. No code changes were applied; no fixes were
committed. To proceed with fixes, create a feature branch and route the new
findings (F1-F4, S1-S3, T1-T4) through Phase 1 (plan) before implementation.

## Recommended Triage Order (if user proceeds with fixes)

1. **F2** (`rotate-master-key` weaker operatorId check) — 1-line fix, structural
   inconsistency with sibling routes; low risk of regression.
2. **T1** (proxy test SESSION_CACHE_MAX import) — 1-line fix, eliminates silent
   false-positive in eviction tests.
3. **F1 + S3** (action constant collision for purge-audit-logs) — coordinated
   change to constants + i18n + group filters + route handler.
4. **S1** (audit-emit metadata Zod schema) — direct hardening, testable.
5. **pre2 / Adjacent (session revocation bypass)** — design discussion required;
   options are (a) reduce TTL to ~5s, (b) Redis-backed cache with active
   invalidation, (c) accept and document.
6. **pre3 / S-pre3 (operator binding)** — design discussion required; options
   are (a) per-operator JWT with sub claim, (b) mTLS + cert→operator mapping,
   (c) accept and rotate ADMIN_API_TOKEN regularly.
7. **R3 baseline** — separate architectural decision (see follow-up Q&A about
   route handler wrappers / proxy modularization).
