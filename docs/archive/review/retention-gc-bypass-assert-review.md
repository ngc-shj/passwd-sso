# Plan Review: retention-gc-bypass-assert
Date: 2026-10-14
Review round: 2

## Round 1

| ID | Expert | Severity | Finding | Resolution |
|----|--------|----------|---------|------------|
| F1 / T5 | Func, Test | Major | The migration targeted the superuser callers (which already set the GUC); the 9 worker-role direct calls were the ones that break. | The 9 sites are enumerated; superuser sites stay. |
| F2 / S2 / T9 | Func, Sec, Test | Major | The unconditional wrapper/assert dropped the `globalDelete` conditional. | Decided the security way: `globalDelete` stays the runtime switch; `inSweepTx(…, bypass, …)` and `assertSweepBypass(tx, expected)` honour it, and `expected=false` also denies a caller's `on`. |
| F3 / T1 | Func, Test | Major | 15 existing unit tests break (fakes without `$queryRaw`, order-dependent mocks, tests pinning the old contract). | Migration step added; text-dispatched `$queryRaw`. |
| S1 | Sec | Major | An exported generic bypass wrapper no gate covers. | `inSweepTx` is module-private; integration uses a `helpers.ts` test helper. |
| T2 / T3 / T4 / T6 / T7 | Test | Major | Deny checks miss non-`$executeRaw` writers; rows-present is rollback-blind; the guard must run as superuser; the dispatcher test as written is unimplementable; red-proof too thin. | Strict recorder, in-tx catch-and-commit with a positive control, superuser guard, stateful fake through `sweepOnce`, 10-mutation red-proof. |
| F4 / F5 / F6, S3 / S4 / S5, T8 / T10 | all | Minor | `sweepTrashEntry` skip reason; name-anchored AST check; stale prose; purpose-GUC reasoning. | `sweepTrashEntry` moves onto the wrapper; derived member set plus a single-setter count; prose listed; SC1 restated. |

## Round 2

| ID | Expert | Severity | Finding | Resolution |
|----|--------|----------|---------|------------|
| test R2-1 | Test | Major | The new worker-role `sweepOnce` test could pass vacuously. | Specified: an RLS `globalDelete` table plus `verification_tokens`, precondition, no `-1`, pre-clean, heartbeat cleanup. |
| sec R2-1 / func R2-F1 / test R2-2 | all | Minor | An "exported test-only seam" would bring S1 back. | Tested only through `sweepOnce`; T8 asserts not exported. |
| func R2-F2 / sec R2-2 | Func, Sec | Minor | The member rule is ambiguous (inferred types, unnamed exemptions). | Written annotation; named exemptions. |
| func R2-F3, test R2-3 / R2-4 | Func, Test | Minor | Prose contradicting C1; missing row with `expected=false`; "first tx call" misses tx-as-argument; fake state; a red-proof gap. | All folded in. |
| sec R2-3 | Sec | Minor (Adjacent) | No gate forbids production imports of `__tests__` helpers. | Pre-existing; out of scope (follow-up candidate). |

## Saturation call

- **Rounds:** two rounds have completed.
- **Round 2's one Major:** a test specification, resolved in the plan.
- **No design-level finding is open.**
- **The remaining items** are Minor prose items or are reachable only by building. Proceed to Phase 2.
