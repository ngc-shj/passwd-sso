# Coding Deviation Log: fail-closed-tranche2

## D1 — Gate dangling-check used api-only ROUTE_LIST, wrongly flagged lib members (Batch A/F integration)
Batch A built the whole-src `ENUM_LIST` (C5) AFTER the DANGLING_ENTRY check,
which validated legacy/debt entries against the `src/app/api`-only `ROUTE_LIST`.
The 3 tranche-2 lib members (auth.config.ts, scim/rate-limit.ts,
rate-limiters.ts) registered in the legacy manifest (C8d) are outside
src/app/api, so DANGLING_ENTRY fired on all three even though they legitimately
opt in. Fix: moved the `ENUM_LIST` construction before the dangling check and
repointed `check_dangling` to validate against `ENUM_LIST` (the whole-src
class-defining set). Removed the now-duplicate later ENUM_LIST build. Gate green;
self-test 41/41.

## D2 — Interim real-repo self-test flipped to final-state (Batch A → Batch F)
Batch A added a self-test case pinning the EXPECTED pre-burndown failure state
(status 1, debt 31, legacy 13, 15 stubs). After Batch F's burndown the gate
passes cleanly, so that scaffold case was replaced with the final-state
assertion ("passes cleanly with the tranche-2 burndown applied", status 0, no
findings). This was anticipated by Batch A's own comment.

## D3 — mobile/autofill-token un-stub surfaced prisma import coupling (Batch D)
Plan risk note anticipated this. Un-stubbing rate-limit-audit pulled
@/lib/prisma into the module graph (via tenant-context); the file did not
already mock prisma (plan assumed it did, as for #14). Added a defensive
`vi.mock("@/lib/prisma")`. No production change.

## D4 — Read-only / proxy-route spies use nearest DB primitive (Batches C/E)
Rows 8 (emergency-access/accept: `transition` is not an importable mock seam →
used emergencyAccessGrant.updateMany), 11 (mcp/authorize: `validateOAuthRequest`
is a local fn → used mcpClient.findFirst), 18 (teams/invitations/accept:
tx-internal writes → used [mockTransaction, teamInvitation.updateMany]) — the
plan's read/side-effect-nearest-primitive rule applied where the named spy had
no separately-mockable module boundary. Documented in-file.

## D5 — bridge-code multi-limiter chain must live in vi.hoisted (Batch C)
The `mockReturnValueOnce` limiter-order chain (row 9) had to be inside
`vi.hoisted(...)`, not a bare statement between vi.mock and the route import —
ESM hoists imports above later statements, so the route's module-scope
createRateLimiter() calls run first. Followed the mcp/token precedent.

## D6 — C8b custom-envelope form for the SCIM 503 (Batch B)
Batch B implemented C8b's contract test as an `assertRedisFailClosed` custom
envelope (503, SCIM error body, `retryAfter:"forbidden"` — SCIM sets no
Retry-After) PLUS the separate `vi.waitFor(logAuditAsync ... objectContaining
{action: RATE_LIMIT_FAIL_CLOSED, targetId:"scim"})` emission assertion. This is
a superset of the plan's C8b step (4) prose and matches the real payload; the
custom-envelope path additionally proves the 503 body shape.

## D7 — C10 verify-access no-mutation spy is defense-in-depth only (Batch F)
verify-access never writes shareAccessLog on any path (that table is written
from src/auth.ts, read by the access-logs GET route). The
count-before/count-after on shareAccessLog is a harmless invariant check, not a
route-discriminating no-mutation proof; documented inline in the test header.
The mcp/register family carries the strong real-DB no-mutation proof (mcpClient
count, a table that route DOES write on success). C10's primary proof for
verify-access is the 503-status short-circuit before token issuance.

## D8 — Phase 2-5 self-R-check folded into Phase 3 Round 1 (orchestrator, D5 tranche-1 precedent)
pre-pr (43/43), full vitest (12728 pass, 1 skip), next build, and the mutation-
residue / suppression / timing-safe / hardcoded-reuse mechanical hooks all
clean. Per tranche-1 D5, the separate 3-agent self-R-check pass is folded into
Phase 3 Round 1 (whose experts run the full R1–R44/RS/RT checklist over the same
diff) to avoid a duplicate pass over an unchanged diff.

## D9 — External-review Major: non-route member test-coverage gap (post-push fix, 2026-07-19)
Two external reviews (post-push) converged on a Major: the gate's coverage loop
enumerates ONLY src/app/api, so the 3 non-route members (auth.config.ts,
scim/rate-limit.ts, rate-limiters.ts) had their opt-in flag pinned by the
whole-src manifest but their fail-closed TESTS were never classified. Deleting
or stubbing a member's test left the gate green (test-drift false-green) — the
whole-src manifest widened the CLASS scope without widening the COVERAGE scope
to match. Root cause: my Round-1 D1 fix extended ENUM_LIST (manifest/dangling)
to whole-src but left the coverage loop api-only.
Fix: added a "Non-route member coverage" block that iterates ENUM_LIST members
outside src/app/api, maps each to its contract-test path via a hardcoded
NON_ROUTE_TEST_MAP (SCIM's contract is non-adjacent — with-scim-auth.test.ts —
so pure adjacent derivation was insufficient), and classifies that test through
the same helper/legacy/debt modes. New tokens: NON_ROUTE_COVERAGE_UNMAPPED (a
new non-route opt-in must declare its test). 5 red-proven self-test fixtures
added (redisErrored removed → LEGACY_TEST_MISSING; test deleted →
LEGACY_TEST_MISSING; helper+mapping-stub → MAPPING_MOCKED_CONTRACT_TEST;
unmapped opt-in → NON_ROUTE_COVERAGE_UNMAPPED; good member passes). Gate
self-test 41→46; real-repo gate + meta-gate green. This closes the last
test-drift path opened by burning debt to 0.
