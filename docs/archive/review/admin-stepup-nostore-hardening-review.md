# Plan Review: admin-stepup-nostore-hardening
Date: 2026-06-24
Review round: 1 (3 parallel expert sub-agents — functionality / security / testing)

## Changes from Previous Round
Initial review. Origin: 3 security-review findings (MCP-client PUT/DELETE step-up gap; mobile/token bridge-code consume-before-network-check; one-time-secret responses missing `no-store`). All 3 verified to exist in this repo (the finding referenced a sibling `/Users/...passwd-sso-ios` path).

## Functionality Findings
- **F1 (Minor → folded into C3)**: mcp-clients step-up fix feasible; insertion point clean (after authz + existence check, before mutation). **R3 propagation gap**: `service-accounts/[id]` PUT/DELETE + SA `tokens` DELETE share the identical pattern and also lack step-up. `req` in scope in all target handlers; `stored.userId/tenantId` non-nullable.
- **F3 (Major → folded into C2)**: no-store enumeration INCOMPLETE — `mcp/token/route.ts` (~:132 authorization_code, ~:217 refresh_token) returns `access_token`+`refresh_token` with NO `no-store` (RFC 6749 §5.1). `mcp/register` correctly N/A (no secret in body). Inline-vs-helper: codebase convention is uniformly inline; if a helper is introduced it must migrate the whole secret-bearing class, not split.

## Security Findings
- **S1 (Major, escalate:false → C3)**: PUT/DELETE step-up gap is real (redirectUris rewrite = OAuth credential-interception, RFC 9700 §4.1 class; `isActive:false` DoS; irreversible hard delete). Gated on pre-existing session compromise → Major not Critical. DELETE step-up appropriate (destructive). **[Adjacent R34] enumeration**: same "step-up on mint POST, absent on mutating sibling" asymmetry across service-accounts/[id], token-revoke DELETEs, scim-tokens DELETE, webhooks (exfil sink), directory-sync, and **tenant/policy PATCH** (which governs the very access-restriction policy C4 enforces). Surfaced to user → user chose to fix all 7.
- **S2 (Minor, escalate:false → C4)**: reorder is net-neutral-to-positive on security, real win is availability. No new replay oracle (consume only happens after all crypto checks pass). No timing-uniformity (S7) weakening — network gate is IP-based, secret-independent, already a distinct `ACCESS_DENIED` error. Best placement: immediately after `!stored` guard (boundary-first).
- **S3 (Minor, escalate:false → C2)**: `no-store` is the correct directive (not `no-cache`/`private`/`must-revalidate`). POST is not cached by default (RFC 9111 §4 — section text cited from memory, marked unverified); residual threat = non-conformant intermediaries / bfcache / debugging proxies. Cheap hardening, convention exists.

## Testing Findings
- **T1 (Major → Testing strategy C3)**: `mcp-clients/[id]/route.test.ts` has NO `recent-current-auth-method` mock (route doesn't import it yet). Must add `vi.mock` + `beforeEach` pass-through (`undefined`) + reject cases asserting mutation mock `not.toHaveBeenCalled()`. Vacuous-pass trap if mock absent. Same applies to every C3 route's test file (R19).
- **T2 (Major, highest value → Testing strategy C4)**: `mobile/token/route.test.ts:338` asserts 403 but NOT that the code is unconsumed. Add `mockMobileBridgeCodeUpdateMany).not.toHaveBeenCalled()` on the denial path — FAILS on current code, passes after reorder → true regression guard. **R5**: do NOT add a mocked "retry succeeds" test (mock returns canned `{count:1}`, no `usedAt` state — vacuous). Defer to integration suite (VC1).
- **T3 (Minor→Major → Testing strategy C2 / SC4)**: no-store assertable (mirror `extension/token/route.test.ts:118`). But `share-links/route.test.ts` and `sends/route.test.ts` DO NOT EXIST — 2 of 5 routes have no create-endpoint test. Decision: create the two minimal test files.

## Adjacent Findings
- [F1/S1-A] service-accounts + tenant/policy + webhooks + directory-sync step-up gaps → routed into C3 (user approved full scope).
- [F3-A] mcp/token no-store → routed into C2.
- [S2-A]/[T2-A] mobile/token denial-path CAS assertion → routed into C4 testing strategy.

## Resolution Status
All findings incorporated into the plan (no deferrals requiring Anti-Deferral justification except VC1 / SC2 / SC3 / SC4, each recorded in the plan with cost-justification). Open verification items resolved post-review:
- `directory-sync/[id]` → PUT + DELETE present (added to C3).
- `webhooks/[webhookId]` → DELETE only, no PUT (C3 corrected).
- `tenant/policy` PATCH + `service-accounts/[id]` PUT/DELETE handlers use `req` (no `_req` rename needed for those).
- `extension/bridge-code` does not exist (dropped from C2 audit).
- `mobile/authorize` returns code via 302 Location redirect with inline no-store (not a JSON-body helper-adoption site).

## Recurring Issue Check
### Functionality expert
- R3: TWO gaps found and incorporated (service-accounts for step-up; mcp/token for no-store).
- R17: no shared no-store helper existed; C1 introduces `NO_STORE_HEADERS`, adopted across the secret-bearing class (all-or-nothing).
- R19: each C3 route test must add the recent-current-auth-method mock — captured in Testing strategy.
- Build/feasibility: clean — all fixes type-safe, `req` in scope, imports established in sibling files.

### Security expert
- R3: step-up applied inconsistently (mint POSTs yes, mutating siblings no) → C3 closes all 7.
- R31: C3 DELETE handlers are destructive → step-up required (confirmed appropriate). No destructive shell ops in this plan.
- R34: PRIMARY concern — fixing only mcp-clients would defer adjacent security bugs; user approved full enumerate-and-cover scope.
- RS (replay/timing): C4 reorder does not weaken S7 uniformity, no replay oracle — net positive.

### Testing expert
- RT: T1/T2 must-have `not.toHaveBeenCalled()` regression assertions captured.
- R5: live in C4 — mocked-DB retry test would pass vacuously; deferred to integration (VC1).
- R19: live in C3 — mock return shape must be `Response | undefined`; mirror sibling exactly.
