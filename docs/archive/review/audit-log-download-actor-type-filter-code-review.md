# Code Review: audit-log-download-actor-type-filter
Date: 2026-05-03
Review round: 1

## Changes from Previous Round
Initial review.

## Functionality Findings

### F1 [Minor]: R34 deferred bug has no grep-able TODO marker in source code
- File: `src/app/api/audit-logs/download/route.ts` (around line 63-67, the `where` literal)
- Evidence: `grep -rn "audit-log-download-emergency"` returned no source matches. Project convention is `TODO(slug):` in source (confirmed at `src/lib/constants/app.ts:41` and `src/lib/audit/audit.ts:85`). The plan says the deferred bug is "Filed as `TODO(audit-log-download-emergency-access-or-clause)` for a future task" — but the marker exists only in the plan document.
- Problem: Without an in-source `TODO(audit-log-download-emergency-access-or-clause)` comment adjacent to the `where` literal, the deferred fix is invisible to future developers reading the file.
- Impact: Low operational risk; UX-only gap. But violates the R34 deferral contract requiring a grep-able marker.
- Fix: Add a one-line TODO comment immediately before the `where` literal in `src/app/api/audit-logs/download/route.ts`.

## Security Findings

No findings.

## Testing Findings

No findings. All 4 Ollama seed findings were rejected:
- 2 Major seeds (mock.calls[0][0] index fragility): rejected — does not reproduce. `vi.clearAllMocks()` resets calls before each test; only `auditLog.findMany` is the Prisma call (other ops are mocked at module boundary, no Prisma).
- 2 Minor seeds ("should …" naming convention): rejected — contradicts established convention in the same files. Existing tests use third-person declarative form; not a single existing test starts with "should". New tests follow the file convention exactly.

## Adjacent Findings

None.

## Quality Warnings

None (Ollama merge produced no VAGUE / NO-EVIDENCE / UNTESTED-CLAIM flags).

## Recurring Issue Check

### Functionality expert
- R1: Checked — no issue
- R2: N/A
- R3: Checked — all 6 audit-log routes use parseActorType
- R4: N/A
- R5-R6: N/A
- R7: Checked — indentation-only; no E2E selector breakage
- R8: Checked — pattern-consistency fix; matches reference (tenant/members/page.tsx)
- R9-R16: N/A
- R17: Checked — parseActorType reused; no inline equivalents
- R18: N/A
- R19: Checked — assertion form correct (objectContaining/not.toHaveProperty)
- R20-R33: N/A
- R34: Finding F1 (Minor — TODO marker missing from source); deferral itself is sound
- R35: N/A

### Security expert
- R1-R35: all Checked / N/A as appropriate; no findings
- R3: pattern propagation complete
- R7: no E2E selector breakage
- R22: no syntactically-different equivalent of parseActorType (verified via grep)
- R34: deferral cost-justified; under-disclosure only; no security regression
- R35: N/A
- RS1: N/A (no credential comparison)
- RS2: existing rate limiters unchanged
- RS3: parseActorType allowlist strict; no bypass via case mismatch / encoding / type coercion

### Testing expert
- R1-R35: all Checked / N/A; no findings
- R3: complete propagation across 6 routes
- R7: no E2E selector breakage
- R17: no helper reimplementation
- R19: real parseActorType used (not mocked) — tests integration of route + parser
- R34: deferral-related testing concerns out of scope
- RT1: mock-reality alignment confirmed
- RT2: lazy-stream consume-first applied throughout
- RT3: from searchParam present in all tenant tests; string literal usage acceptable per existing pattern

## Resolution Status

### F1 [Minor] R34 TODO marker missing from source — RESOLVED (round 1)
- **Anti-Deferral check**: not applicable (finding is being fixed, not deferred)
- Action: Added a 2-line `TODO(audit-log-download-emergency-access-or-clause)` comment immediately before the `where` literal in `src/app/api/audit-logs/download/route.ts`.
- Modified file: `src/app/api/audit-logs/download/route.ts:62`
