# Coding Deviation Log: verify-sentinel-audit-chain

## D1 — The anchor row-count red proof names `[own, own]`, not `[own, foreign]`

The plan's testing strategy said removing the anchor's at-most-one-row check turns the
`[own, foreign]` case red. It does not: the foreign-row check still finds the second row. Only an
`[own, own]` fixture depends on the row count alone, so that case was added and is the one the
red proof turns red.

## D2 — Sentinel integration cell: `anchorChecked` derived, and environment-dependent

`verifyChainRows` reports `anchorChecked` false for an anchor at seq 0, for a walk cut short by
the row cap, and for a walk stopped by a tamper, so the sentinel cell asserts
`anchorChecked === (anchor_seq >= 1 && walkable <= MAX_ROWS)` rather than `true`. Its
`totalVerified` equality assumes the sentinel's chain is intact: on a database whose sentinel had a
chain and then had chained rows purged by retention, the walk breaks at the first retained row and
the cell fails — a true finding about that database, not a test defect. On dev and CI the sentinel
has no chain.

## D3 — Red proofs (scratch copy, one mutation each)

| Mutation | What went red |
|----------|---------------|
| sentinel routed to the tenant path | unit routing/sentinel cases; integration sentinel and runTick cells |
| precondition removed | the four unit `BYPASS_CONTEXT_MISSING` cases |
| anchor row-count check removed | unit `[own, own]` case |
| walk row assertion removed | unit foreign-walked-row case |
| walk row assertion removed and the walk's `WHERE` dropped | integration tenant-A healthy and tampered cells |
| grant without `auditLog` | integration tenant-A healthy and tampered cells (report check) |
| timeout dropped on the bypass call | unit sentinel-budget case |
