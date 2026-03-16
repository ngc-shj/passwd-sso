# Plan Review: perf-audit-codebase
Date: 2026-03-16T14:00:00+09:00
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Major] Item 4 restore routes cannot be parallelized
Restore needs full entry object for history snapshot transaction
- Status: RESOLVED (removed restore from parallelization targets)

### F2 [Major] Item 2+3 implementation order dependency
createMany depends on tenantId being available at call site
- Status: RESOLVED (reordered: Item 2→3 became Item 3→2, added dependency note)

### F3 [Major] Item 20 withBypassRls short-circuit scope unclear
Effective scope hard to define; fire-and-forget logAudit runs outside caller's ALS context
- Status: RESOLVED (removed Item 20 entirely — low ROI, high risk)

### F4 [Major] Item 4 PATCH handler has additional validation constraints
PATCH needs both entry and history for keyVersion comparison but can still parallelize
- Status: RESOLVED (documented PATCH-specific notes in plan)

## Security Findings

### S1 [Major] createMany must not be in main data transaction
Audit logs in main tx would be rolled back on failure, losing security evidence
- Status: RESOLVED (plan updated: "inside a separate withBypassRls call, NOT inside main data transaction")

### S2 [Major] Webhook parallel delivery needs concurrency limit
Unbounded Promise.allSettled can exhaust resources
- Status: RESOLVED (added "max 5 concurrency" to plan)

### S3 [Major] Redis pipeline fallback behavior
Multi-process in-memory fallback relaxes rate limits — pre-existing issue
- Status: ACCEPTED (not introduced by this plan)

## Testing Findings
Not reviewed at plan level (no test design changes)

## Adjacent Findings
None
