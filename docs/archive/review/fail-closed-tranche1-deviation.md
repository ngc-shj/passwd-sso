# Coding Deviation Log: fail-closed-tranche1

## D1 — C5 filename (2026-07-18, Batch 1)
Plan named `src/__tests__/db-integration/rate-limit-fail-closed.integration.test.ts`;
that path already exists on main (PR #473, AC5.4a — audit_outbox emission
coverage) and must not be overwritten. C5 implemented as
`rate-limit-fail-closed-chain.integration.test.ts` (header comment explains).
Pre-existing file untouched and still green (3/3). No gate references the
literal C5 filename (checked: check-fail-closed-routes-have-test.sh iterates
route files, not integration-test filenames).

## D2 — C5 teardown settle delay (2026-07-18, Batch 1)
`checkRateLimitOrFail` fires `void emitRateLimitFailClosed(...)`; the
integration test drains 200ms BEFORE `deleteTestData` to avoid an FK race
against the just-deleted tenant. Inherent to the production fire-and-forget
design (documented in rate-limit-audit.ts), not a product bug.

## D3 — C6 case count (2026-07-18, Batch 1)
Plan's C6 case (7) implemented as two cases (Retry-After absent / non-numeric);
8 vitest cases total for the 7 plan cases. Superset of the contract.

## D4 — Comment-literal gate interaction (2026-07-18, orchestrator)
Batch B's explanatory comment in extension/token/route.test.ts contained the
literal option text, inflating the gate's instantiation count to 70 (expected
69). Reworded the comment; gate green. Class note: the gate counts the literal
across all files under src/app/api — test-file comments must avoid it.

## D5 — Phase 2-5 self-R-check folded into Phase 3 (2026-07-18, orchestrator)
The three implementation batches each ran R19/R21/C4 checks and full per-file
verification; the separate Phase 2-5 mini R-check pass is folded into Phase 3
Round 1 (whose experts run the full R1–R44/RS/RT checklist over the same diff).
Cost-justification: avoids a duplicate 3-agent pass over an unchanged diff.

## D6 — Batch C attribution pattern unified post-hoc (2026-07-18, orchestrator)
Batch C hand-rolled capture+replay before snapshotFactory landed (parallel
batches); refactored the 5 files to the shared utility (cross-batch dedup),
identical pass counts (64/64).

## D7 — C1 API extended post-lock by Phase 3 P3-F1 (2026-07-18)
`failure` fixture param added as REQUIRED to assertRedisFailClosed (gate
literal must be code, not comment). Plan C1/C2/C6 text updated in place;
contract re-verified by Phase 3 Round 2 (No findings). C6 case 6 rebuilt per
P3-F2 with scratch-copy discrimination proof.

## D8 — Gate rework per PR #680 external review (2026-07-18)
External review found a Major false-green in check-fail-closed-routes-have-test.sh:
the bare `grep -q "redisErrored"` pass criterion was satisfiable by comments,
describe labels, and mapping-stubbed tests (extension/bridge-code was already
misclassified as tested; deleting its debt entry kept the gate green).
Reworked to a three-mode model: helper contract (assertRedisFailClosed import
+ call, mapping stubs rejected via MAPPING_MOCKED_CONTRACT_TEST) /
fail-closed-legacy-direct.txt (new manifest, 20 pre-helper direct-test routes)
/ debt. Anti-drift failures added: STALE_DEBT_ENTRY, STALE_LEGACY_ENTRY,
LEGACY_DEBT_CONFLICT, LEGACY_TEST_MISSING, DANGLING_ENTRY. Self-test rewritten:
the former "comment satisfies the gate" green fixture is inverted to red, and
the bridge-code shape is pinned as a regression fixture (20 cases).
Also applied the review's minor items: Retry-After must be > 0 (delay-seconds
"0" rejected; stampede guard) and the custom envelope now carries an explicit
retryAfter: required|forbidden|ignore policy (self-tested).

## D9 — AST-first classification (2026-07-18, user directive)
The D8 gate fix was still text-based (tightened greps). Per the user's
standing point that code-classifying gates must be AST from the start,
classification moved to scripts/checks/classify-fail-closed-test.mjs
(ts-morph, in-memory FS; classifier failure fails the gate closed — no text
fallback). Immediate payoff: 7 legacy-direct entries (rotate-master-key×4,
mcp/authorize, mobile/authorize, mobile/autofill-token) had redisErrored ONLY
in describe labels/comments — moved to debt (24→31; honest count the old
text gate had been hiding). Grep remains only for fail-LOUD uses (route
enumeration, AC4.4/AC4.5 literal counts). Also fixed a load-dependent
SIGPIPE(141) race in the gate's `printf | grep -q` membership helpers
(herestrings now; surfaced by pre-pr's parallel vitest). Classifier has its
own 10-case self-test (meta-gate demanded it); gate self-test grew to 22
cases incl. AST-only red fixtures (comment-wrapped import+call, label-only
redisErrored). Rule persisted as feedback memory
(feedback_ast_first_for_code_classification_gates).
