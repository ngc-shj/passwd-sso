# Code Review: v1-api-crypto-guards

Date: 2026-06-08
Review round: 1 (standalone branch review)
Branch: fix/v1-api-crypto-guards

## Scope

Working-tree diff (`git diff HEAD`) — 6 files. Hardens the v1 REST password API to
match the session API and tightens server-side share crypto:

1. v1 PUT: C7 guard — reject keyVersion/aadVersion change without re-encryption (409).
2. v1 DELETE: reject `?permanent=true` with 403 (soft-delete only).
3. v1 PUT: remove redundant inner `$transaction` (use withTenantRls's tx directly).
4. route-policy.ts: boundary-aware `pathMatchesPrefix` (parity with cors-gate).
5. crypto-server.ts: remove no-AAD decrypt fallback (operator confirmed no legacy rows).

## Functionality Findings

**F1 — Minor — `src/app/s/[token]/download/route.ts:159`** (pre-existing, unchanged file)
- Evidence: `decryptShareBinary(...)` is not wrapped in try/catch, unlike the sibling
  share callers (`[id]/content/route.ts`, `[token]/page.tsx`) which catch → 404.
- Problem: a decrypt failure surfaces as an unhandled 500 instead of a graceful 404.
- Impact: behavior-NEUTRAL under change #5 — a corrupt/transplanted binary threw in the
  OLD code too (both AAD and no-AAD paths failed → throw). Removing the fallback only
  changes the outcome for a *legitimate no-AAD legacy row*, which the operator has
  confirmed does not exist. No regression for any stored or attacker-supplied data.
- Disposition: see Resolution Status (deferred with Anti-Deferral justification).

## Security Findings

No findings. Verified:
- #5: encrypt side always binds `shareAad(tenantId)`; all share/send rows are AAD-bound.
  Tenant-transplant defense is now unconditional. All callers of decryptShare*/the
  low-level decryptServer* enumerated — no migration/rotation/recovery path decrypts
  share data without AAD. No availability regression for AAD-bound rows.
- #1: guard byte-identical to session API; no bypass via garbage blob (blob+metadata
  written together). keyVersion/aadVersion validated by updateE2EPasswordSchema (RS3).
- #2: 403 returned after rate-limit, before any state change/existence lookup — no audit
  spoofing, no existence oracle. Blast radius of a leaked `passwords:write` key reduced.
- #4: fail-safe preserved — all 21 SESSION_REQUIRED_PREFIXES enumerated against the real
  route table; no session-required route downgraded to API_DEFAULT. Only phantom siblings
  dropped.

## Testing Findings

**T1 — Low — `src/app/api/v1/passwords/[id]/route.test.ts`** — RESOLVED
- Evidence: `mockFolderFindFirst` / `mockTagCount` were wired but never asserted; the
  folder-ownership and tag-ownership validation branches (route.ts:142-159) had no PUT
  coverage (pre-existing gap).
- Fix: added two PUT tests asserting 400 VALIDATION_ERROR for an unowned folderId and for
  a tagIds set containing an unowned tag, each asserting mockEntryUpdate not called.

Verified clean: RT1 mock-reality fidelity (mockWithTenantRls passes the prisma mock as tx;
the route's `tx.*` calls resolve to the asserted spies); C7 409 tests non-vacuous (assert
code + no update); permanent-403 test asserts no side effect; route-policy sibling tests
fail under bare startsWith and pass under pathMatchesPrefix; removed tests left no stale
old-behavior assertions; orphan `mockTransaction` removed.

## Recurring Issue Check
- R1 shared-util: pathMatchesPrefix intentionally mirrors cors-gate (documented parity).
- R3 propagation: C7 guard ported from session API; AAD removal applied to BOTH
  decryptShareData and decryptShareBinary symmetrically.
- R5/R9 transaction boundaries: atomicity preserved (improved — history+update now in one
  tx vs session API's two).
- R36 suppression: none introduced.

## Resolution Status

### F1 Minor — download decrypt not try/caught — Deferred (Pre-existing in unchanged file)
- Anti-Deferral check: "pre-existing in unchanged file" → [Adjacent] routing provided.
- Justification: `src/app/s/[token]/download/route.ts` is NOT in this branch's diff. The
  change in this branch (#5) is behavior-neutral for it — corrupt/transplanted binaries
  threw before and after; only a nonexistent legacy no-AAD row would differ. Worst case:
  500 instead of 404 on a genuinely-corrupt file-send (no data exposure). Likelihood: low
  (requires a corrupt/transplanted row). Cost to fix: ~10 min (wrap decrypt → 404 to match
  siblings), but it touches an unrelated send-download route — out of scope for this
  API-guards branch.
- TODO(share-download-decrypt-graceful): wrap decryptShareBinary in download/route.ts in
  try/catch → 404, harmonizing with content/page callers. Separate follow-up.
- Orchestrator sign-off: pre-existing, unchanged-file, behavior-neutral; deferred.

### T1 Low — orphan mocks + untested ownership branches — Fixed
- Action: added folder/tag ownership validation tests.
- Modified file: src/app/api/v1/passwords/[id]/route.test.ts

## Verification
- Full suite: 11,089 passed | 1 skipped.
- Lint: 0 errors, 0 warnings in changed files.
- `next build`: succeeded (pre-T1 build; T1 is a test-only addition).
- pre-pr.sh: 31/31 passed (pre-T1; T1 test-only).

## Termination
Round 1 complete. Security: none. Functionality: F1 deferred with justification (unchanged
file, behavior-neutral). Testing: T1 fixed (test-only, tightening-only — no Round 2 needed).
No Critical/Major findings. Review complete.
