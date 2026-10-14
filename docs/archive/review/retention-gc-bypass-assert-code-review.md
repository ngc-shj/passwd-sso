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
| S-F1 | Sec | Minor (Adjacent) | `check-rls-read-context` accepts any callback parameter annotated as a transaction client, whatever call it is passed to. The trash callback now passes on that annotation (its runtime assert is real). | Fixed here, at the user's request. See "S-F1: fixed in this branch". |

Each new check was red-proved on a scratch copy:
- an assert behind an `if`;
- a drifted `set_config` in the helper (`is_local` false);
- an exported `assertSweepBypass`;
- `export default inSweepTx`;
- the error code removed.

## S-F1: fixed in this branch

The user asked for this to be fixed here rather than deferred.

- **Gate:** `check-rls-read-context.mjs` takes the annotation shortcut only for a function that is not itself passed as an argument to a call. A callback argument is judged by the call it is passed to: a context helper, or `$transaction` plus a GUC set on that binding. Its own annotation no longer counts.
- **Measured reach:** in the scan roots, only the retention-gc trash callback relied on the old shortcut (4 statements).
- **Production change:** that callback's body became the declaration `sweepTrashTenant(tx: Prisma.TransactionClient, …)`. The declaration asserts the bypass first and is now one of the source-checked members (seven). The callback only threads `tx` into it.
- **Gate tests:**
  - an annotated callback passed to a `$transaction` with no GUC fails;
  - an annotated callback passed to an unrecognised wrapper fails;
  - the same callback with `setBypassRlsGucs` passes;
  - an annotated callback that only threads its tx into a typed declaration passes.
- **Red-proof:** the two FAIL cases went red against the pre-change gate on a scratch copy.

## Termination
All findings are Minor and resolved, S-F1 included. The round's fixes are comments, an error code, and test-only checks, and none touches a security predicate. Tightening-only skip: no round 2.

## Recurring Issue Check
- **Functionality:** R29 F1/F2. Others OK or n/a.
- **Security:** R46 S-F1 (pre-existing). R47 S-F2. R42, R43, R48, R49 and R54 OK. RS n/a.
- **Testing:** RT1 T-1. RT11 T-2. RT2–RT8 OK.

## Environment Verification Report
VE1 is verified locally, with the compose workers stopped:
- retention-gc integration: 61/61;
- full integration: 770 passed, 1 skipped, 4 todo.

The workers were restarted afterwards. CI's `ci-integration` will re-run them.
