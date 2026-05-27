# Plan Review: extension-bridge-code-audit-emission

Date: 2026-05-27
Review round: 1

## Changes from Previous Round

Initial review. Three expert sub-agents (Functionality, Security, Testing) ran in parallel against the locked plan.

## Resolution Summary

| Finding | Severity | Disposition |
|---------|----------|-------------|
| Func M1: broken forbidden-pattern regex | Major | **Accepted** — regex dropped; single-emit invariant enforced via test-layer (C6 `toHaveBeenCalledTimes(1)` + reason×test matrix). |
| Func M2: Step 6 emit-ordering reversal vs RATE_LIMIT_FAIL_CLOSED | Major | **Accepted** — documented in Considerations and §C4 Step 6 (RLFC enqueues first, EBCIF after, consistent across Step 1b/6b). |
| Func M3: Step 6 emit gate under-specified | Major | **Accepted** — §C4 now contains explicit code snippet: emit ONLY inside `if (blocked)` branch, gated on `rl.redisErrored` for reason selection. |
| Func Minor: extra-merge precedence wording | Minor | **Accepted** — wording replaced; §C3 now builds `metadata` as `{ reason, ...(reason==="dpop_invalid" && {dpopError}) }`. No spread-precedence trap. |
| Func Minor: Step 8 scope note | Minor | **Skipped** — current scope (`userRecord`, `userId` reachable at catch site) is correct; the suggested defensive comment would be over-engineering for a 2-line catch block. |
| Func Minor: tenant webhook acknowledgement | Minor | **Accepted** — added "EXTENSION_BRIDGE_CODE_* is PERSONAL-only" to Considerations. |
| Sec F1/F9: pre-auth audit-emit storm DoS amplification | Major | **Skipped with rationale** — Step 1's 60/min/IP IP rate-limit is the upper bound on attacker-driven emit rate; Steps 2/3/4 only fire after Step 1 admits. Adding a helper-level throttle would diverge from `emitAuthLoginFailure`, which has the same property today. Documented in Considerations. |
| Sec F2: co-emit SIEM correlation false-positive | Minor | **Accepted** — added co-emission timing note to Considerations (RLFC + EBCIF, ACCESS_DENIED + EBCIF). |
| Sec F3: `extra` type not narrowed | Minor | **Accepted** — §C3 narrowed to discriminated union; `dpop_invalid` carries `dpopError: DpopVerifyError` only. No free-form `Record<string, unknown>`. |
| Sec F4: SIEM injection via raw IP/UA | Minor | **Skipped** — pino JSON escapes correctly; DB JSONB column escapes correctly; speculative future risk per memory `feedback_subagent_findings_essence_filter.md`. |
| Sec F5: userRecord=null tenantId dead-letter | Minor | **Skipped** — symmetric with the four pre-auth dead-letter cases, all of which are documented; fetching `tenantId` from Auth.js session row is a feasible alternative but adds a query and falls outside C14's scope. Documented as known behavior. |
| Sec F6: DB-error cascading audit failure | Minor | **Accepted** — added explicit note to Considerations: `db_error` rows surface only via the pino structured-log stream during a DB outage. Same property as `EXTENSION_TOKEN_EXCHANGE_FAILURE`. |
| Sec F7: differential pre-auth emission oracle | None | **No action** — confirmed by reviewer to be safe (response unchanged; emit is fire-and-forget). |
| Sec F8: SYSTEM_ACTOR_ID conflates attacker traffic | Minor | **Skipped** — `audit_logs.ip` column already carries the IP value via `extractRequestMeta(req)`; SIEM consumers can group by IP without an additional hash. Adds complexity without forensic gain. |
| Test C1: reason×test 1-to-1 map missing | Critical | **Accepted** — §C6 now contains an explicit 12-row matrix; every `reason` from C2 maps to a named test. |
| Test M1: mock placement layer | Major | **Accepted** — §C6 explicitly says route tests mock `@/lib/audit/audit` (not the helper); helper has its own test file mocking the same module. |
| Test M2: single-emit count assertion | Major | **Accepted** — §C6 mandates `toHaveBeenCalledTimes(1)` on every failure-path test + `not.toHaveBeenCalledWith(...FAILURE...)` on the success-path test. |
| Test M3: Step 8 mock pattern | Major | **Accepted** — §C6 specifies `mockBridgeCodeCreate.mockRejectedValueOnce(...)`. |
| Test M4: helper-test minimum invariants | Major | **Accepted** — §C6 enumerates the 4 specific tests for `bridge-code-failure.test.ts`. |
| Test M5: local-dev coverage gap | Major | **Accepted** — added pre-PR developer reminder to Considerations referencing `feedback_run_pre_pr_before_push.md`. |
| Test m1: manual DB migration check CI-enforceability | Minor | **Accepted** — clarified as pre-PR developer checklist; CI uses a fresh DB. |
| Test m2: integration-test omission rationale | Minor | **Accepted** — rationale added to §C6 tail. |
| Test m3: snapshot/regression risk | Minor | **No action** — verified `audit-action-icons.tsx` is `Partial<Record>` with fallback; no snapshot test enumerates the action set. |
| Test m4: success-path negative assertion | Minor | **Accepted** — folded into C6 mandate. |
| Test m5: pre-auth structured-log testability | Minor | **No action** — the underlying `auditLogger.info` emit is covered by `audit.test.ts`; not re-tested per-call-site to avoid duplicating coverage. |

## Adjacent Findings

- [Adjacent] Func → Test: two-layer mock strategy in §C6 (mocking the helper at one layer + `mockLogAudit` at another) — resolved by §C6 explicitly choosing the `@/lib/audit/audit` layer for both route and helper tests.
- [Adjacent] Sec → Test: single-emit invariant cannot be statically enforced — resolved by Test M2 acceptance.
- [Adjacent] Sec → Func: Step 1/6 refactor changes key-composition centralization — accepted as functional drift, no security impact.

## Recurring Issue Check

### Functionality expert
- R9 (async-in-tx): Pass — Step 8 catch fires after tx rollback.
- R10 (circular import): Pass — helper imports only `@/lib/audit/audit` + constants, mirroring `auth-failure.ts`.
- R12 (audit action coverage): Pass — Prisma enum + AUDIT_ACTION + AUDIT_ACTION_VALUES + group + en + ja all addressed.
- Others: N/A.

### Security expert
- R12 (CSRF baseline): Pass.
- R23 (no secrets in logs): Pass — `dpopResult.error` is enum, no secret leakage.
- R25 (METADATA_BLOCKLIST coverage): Pass — typed `extra` forecloses untrusted strings.
- R31 (no destructive DB ops): Pass — `ADD VALUE IF NOT EXISTS`.
- Others: N/A or pass.

### Testing expert
- Test framework detection: vitest, confirmed via existing test files.
- Mock layer alignment: §C6 mocks `@/lib/audit/audit`, consistent with existing `extension/token/exchange/route.test.ts`.
- Count assertion: enforced.
- Integration-test omission rationale: documented.

## Conclusion

All Critical and Major findings are addressed in the plan revision. Minor findings either accepted (incorporated into plan) or explicitly skipped with rationale. No remaining open findings block transition to Phase 2.

The plan's Go/No-Go Gate remains:

| ID  | Subject                                     | Status |
|-----|---------------------------------------------|--------|
| C1  | Schema: new enum value + migration          | locked |
| C2  | Failure reason taxonomy (12 reasons)        | locked |
| C3  | Emission helper signature & invariants      | locked |
| C4  | Route emission sites & Step 8 try/catch     | locked |
| C5  | i18n + AUDIT_ACTION_GROUPS_PERSONAL[AUTH]   | locked |
| C6  | Test coverage (route + helper)              | locked |
| C7  | Consumer-flow walkthrough                   | locked |

Transitioning to Phase 2 (implementation).
