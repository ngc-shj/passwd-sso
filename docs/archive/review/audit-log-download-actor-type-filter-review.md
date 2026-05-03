# Plan Review: audit-log-download-actor-type-filter
Date: 2026-05-03
Review rounds: 3 (1 full + 2 incremental)

## Round-by-round summary

- **Round 1**: Functionality flagged F1 (insertion-point divergence) + F3 (R34 cursor-OR concern misplaced). Security: no findings. Testing flagged T1 (Major — lazy stream consumption gap) + T2 (tenant equivalent) + T3 (assertion-form weakness). Plan amended.
- **Round 2**: Functionality observed F1 fix overshot (canonical position is BEFORE date validation, not after) + raised F4 (plan internal inconsistency). Security: no new findings. Testing confirmed T1/T2/T3 resolved + raised T4 (stale `not.objectContaining` text on line 134) + T5 (tenant snippet absent). Plan amended.
- **Round 3**: Targeted verification — F1, F4, T4, T5 all confirmed resolved. No new findings. Loop terminates clean.

## Round 1 Findings

### F1 [Minor]: Plan steps 2/3 prescribed parseActorType insertion point — RESOLVED IN ROUND 2 (after a Round 1 over-correction)
- File: docs/archive/review/audit-log-download-actor-type-filter-plan.md (steps 2 & 3)
- Round 1 fix attempt: moved prescription from "after `to` extraction" to "after date validation block" — this overshot.
- Round 2 correction: reverted to "after `to` extraction, and BEFORE date validation block" — matching canonical `teams/[teamId]/audit-logs/download/route.ts:66`.

### F3 [Minor]: R34 deferral note unnecessarily raised cursor-OR concern — RESOLVED IN ROUND 1
- Amended note explicitly scopes the cursor-OR concern to the deferred OR-clause fix only; does not apply to the actorType filter being added in this plan.

### S1-Sn: No findings (Round 1 and Round 2)

The plan adds actorType query-parameter support to two download endpoints via the existing `parseActorType` helper. No new trust boundaries, no schema changes, no new dependencies. RLS isolation, authorization gating, input validation (strict allowlist with identity comparison; Prisma parameterizes), and information disclosure surfaces all checked across both rounds — no security regression. Deferred OR-clause is under-disclosure (not over-disclosure); RLS continues to enforce tenant isolation; actorType filter cannot bypass the missing OR or reach unauthorized records.

### T1 [Major]: Personal download tests must consume the response stream before asserting on `findMany.mock.calls` — RESOLVED IN ROUND 1
- The personal route returns a lazy `ReadableStream`; `findMany` is invoked from inside the stream's pull callback. Plan now requires `await parseStreamResponse(res)` before assertions in step 5 with three sample snippets demonstrating the pattern, plus the Testing strategy section reinforcing the requirement.

### T2 [Minor]: Tenant download — same lazy-stream consumption requirement — RESOLVED IN ROUND 1
- Step 6 now mandates `await streamToString(res)` before assertions.

### T3 [Minor]: Use `not.toHaveProperty("actorType")` instead of `not.objectContaining` for absent/invalid cases — RESOLVED IN ROUND 1
- Step 5 snippets and Testing strategy section now use the stronger form. The weaker form remains in explanatory contrast notes (intentional — explains why the stronger form is preferred).

## Round 2 Findings

### F4 [Minor] (new in Round 2): Plan internal inconsistency between pattern-reference snippet and step instructions — RESOLVED IN ROUND 2
- The pattern-reference snippet (Technical approach section) showed parseActorType in its canonical position; the Round 1 step-2/3 over-correction created a contradiction. The Round 2 F1 revert resolved both.

### T4 [Minor] (new in Round 2): Testing strategy bullet still contained stale `expect.not.objectContaining({ actorType: ... })` — RESOLVED IN ROUND 2
- Replaced with `not.toHaveProperty("actorType") for absent/invalid cases`. Explanatory contrast mention preserved as the "why" note.

### T5 [Minor] (new in Round 2): Step 6 lacked tenant test snippet; from/to requirement in prose only — RESOLVED IN ROUND 2
- Added explicit tenant snippet showing `from`/`to` searchParams + `await streamToString(res)` consume + both `expect.objectContaining` and `not.toHaveProperty` assertion forms with a bolded "EQUALLY MANDATORY" note.

## Adjacent Findings

None.

## Quality Warnings

None across all three rounds (Ollama merge produced no VAGUE / NO-EVIDENCE / UNTESTED-CLAIM flags in Round 1; Round 2 and Round 3 were focused incremental reviews).

## Recurring Issue Check (final state after Round 3)

### Functionality expert
- R1: Checked — no issue
- R2: N/A
- R3: Checked — no issue (all 6 audit-log routes enumerated; 4 already use parseActorType, 2 are this plan's targets)
- R4: N/A
- R5: N/A (read-only)
- R6: N/A
- R7: Checked — no issue (indentation-only; no ARIA/role/data-testid changes)
- R8: N/A (this is the R3-F2 fix itself; reference pattern in `tenant/members/page.tsx` confirmed)
- R9: N/A
- R10: N/A
- R11: N/A
- R12: N/A
- R13: N/A
- R14: N/A
- R15: N/A
- R16: N/A
- R17: Checked — no issue
- R18: N/A
- R19: Checked — no issue
- R20: N/A
- R21: Checked
- R22: Checked
- R23: N/A
- R24: N/A
- R25: N/A
- R26: N/A
- R27: N/A
- R28: N/A
- R29: N/A
- R30: N/A
- R31: N/A
- R32: N/A
- R33: N/A
- R34: Checked — deferral cost-justified per Anti-Deferral Rules; cursor-OR concern correctly scoped to deferred fix
- R35: N/A (no deployment-artifact files in diff)

### Security expert
- All R1-R35 + RS1-RS3: same as Round 1 (no changes)
- R34: Deferral remains acceptable (under-disclosure not over-disclosure; RLS preserved)

### Testing expert
- R1-R35 + RT1-RT3: all checked; T1/T2/T3/T4/T5 resolved.
- RT2 in particular: lazy-stream consume-first requirement now explicit at step + strategy levels
- RT3: tenant-route early-return guard now explicit in step 6 with concrete snippet
