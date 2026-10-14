# Code Review: retention-gc-bypass-assert
Date: 2026-10-14
Review round: 1

## Changes from Previous Round
Initial review of `c0cd49ebd`. Three fresh experts reviewed it. The functionality and security experts read the code and ran unit tests and gates. The testing expert also ran 13 mutations on a scratch copy, and all of them went red.

No Critical or Major findings.

## Findings and resolution

| ID | Expert | Severity | Finding | Resolution |
|----|--------|----------|---------|------------|
| F1 | Func | Minor | The `sweepPerTenantAge` docstring still said `workerPrisma.$transaction`. | Says `inSweepTx`. |
| F2 | Func | Minor | The `sweep.ts` header was stale ("Three exported functions") and did not state the setter/assert rule. | Header rewritten. |
| F3 | Func | Minor | An assert deny logged `entry_failed` with `code: "unknown"`. | The error carries `code: "RETENTION_GC_BYPASS_STATE"`. A dispatch test pins it through an inherited-bypass scenario on `verification_tokens`. |
| T-1 | Test | Minor | `inRetentionSweepTx` copies the wrapper's `set_config` with nothing keeping them in step. | A source test compares the two literals. |
| T-2 | Test | Minor | The AST check accepted a conditional assert. | It now requires the assert to be an expression statement directly in the function body. |
| S-F2 | Sec | Minor | The source invariants were spelling-bound: an exact annotation text, and only some export forms. | The annotation is matched with `check-rls-read-context`'s `TX_TYPE_RE`. Exports are read through `getExportedDeclarations()`, plus exported aliases. |
| S-F1 | Sec | Minor (Adjacent) | `check-rls-read-context` accepts any callback parameter annotated as a transaction client, whatever call it is passed to. The trash callback now passes on that annotation (its runtime assert is real). | Pre-existing gate behaviour, not changed here (see Anti-Deferral). |

Each new check was red-proved on a scratch copy:
- an assert behind an `if`;
- a drifted `set_config` in the helper (`is_local` false);
- an exported `assertSweepBypass`;
- `export default inSweepTx`;
- the error code removed.

## Anti-Deferral: S-F1

- **Finding:** `check-rls-read-context.mjs` takes the annotation shortcut (`TX_TYPE_RE`) before looking at the call the callback is passed to. So `prisma.$transaction(async (tx: Prisma.TransactionClient) => …)` with no GUC would pass.
- **Why not here:** the shortcut predates this branch, and other worker code depends on it. Changing it means re-judging every annotated callback in the scan roots, which is a gate change with its own review. In this branch the one affected callback asserts the bypass at runtime, before any row is read.
- **Worst case:** a future callback typed as a transaction client, passed to a raw `$transaction` with no GUC, passes the gate. It then reads zero rows or raises 22P02. That is an availability failure, not a widening.
- **Likelihood:** low.
- **Cost to fix:** moderate (a gate change plus fixtures). This is a follow-up issue candidate.

## Termination
All findings are Minor and resolved, apart from S-F1, which is deferred above. The round's fixes are comments, an error code, and test-only checks, and none touches a security predicate. Tightening-only skip: no round 2.

## Recurring Issue Check
- **Functionality:** R29 F1/F2. Others OK or n/a.
- **Security:** R46 S-F1 (pre-existing). R47 S-F2. R42, R43, R48, R49 and R54 OK. RS n/a.
- **Testing:** RT1 T-1. RT11 T-2. RT2–RT8 OK.

## Environment Verification Report
VE1 is verified locally, with the compose workers stopped:
- retention-gc integration: 61/61;
- full integration: 770 passed, 1 skipped, 4 todo.

The workers were restarted afterwards. CI's `ci-integration` will re-run them.
