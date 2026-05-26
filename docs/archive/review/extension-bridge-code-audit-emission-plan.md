# Plan: extension-bridge-code-audit-emission (C14 follow-up of PR #492)

Date: 2026-05-27
Branch: `feat/extension-bridge-code-audit-emission`

## Project context

- Type: **web app** (Next.js 16 + Prisma 7 + Postgres 16)
- Test infrastructure: **unit + integration + CI** (vitest, pg-backed integration, GitHub Actions)
- This plan does NOT add a new product feature; it adds **forensic audit emission** to an existing route's failure paths.

## Objective

Emit `EXTENSION_BRIDGE_CODE_ISSUE_FAILURE` audit events for every failure path of
`POST /api/extension/bridge-code`. Today only the success path emits
`EXTENSION_BRIDGE_CODE_ISSUE`; failures leave a `pino` structured log only, which
is not visible in the audit log surface (tenant admin, SIEM forwarder, audit
delivery target).

Motivation (from PR #492 §C14): forensic visibility for XSS-driven attempts to
issue bridge codes through the legitimate route. The SW-initiated trust path
neutralises *token* theft; the route can still be invoked by an authenticated
victim under XSS until it hits its per-user rate limit. Audit visibility is the
detection surface for that residual risk.

## Requirements

### Functional

- Every `return X` path in `bridge-code/route.ts` that is reached on a failure
  must emit exactly one `EXTENSION_BRIDGE_CODE_ISSUE_FAILURE` audit event before
  returning.
- The success path is unchanged (`EXTENSION_BRIDGE_CODE_ISSUE` continues to fire).
- The emitted audit event distinguishes the failure cause via
  `metadata.reason` (single audit action, taxonomy in C2).
- Failures **before** session resolution (Steps 1–3 below) emit with
  `userId = SYSTEM_ACTOR_ID` and `actorType = SYSTEM`, matching the
  `emitAuthLoginFailure` pre-auth pattern.
- Failures **after** session resolution emit with the real `userId` and
  `tenantId` from `auth()` + `prisma.user.findUnique`.

### Non-functional

- No change to the response contract for any path (status codes, bodies, headers).
- No change to ordering of gates (audit emit happens *before* `return`, never *replaces* the return value).
- Audit emission is fire-and-forget at the call sites that already use `logAuditAsync` (success path); failure paths follow the same shape. `logAuditAsync` itself never throws (MF2 — see `src/lib/audit/audit.ts:228`).

## Technical approach

### Failure path inventory (`src/app/api/extension/bridge-code/route.ts`)

| Step | Code site | Pre-/post-auth | Existing audit? | New emit |
|------|-----------|----------------|-----------------|----------|
| 1a | IP rate-limit 429 (`ipBlocked` 429 branch) | pre-auth | none | yes — `reason: "ip_rate_limit"` |
| 1b | IP rate-limit 503 (Redis fail) | pre-auth | `RATE_LIMIT_FAIL_CLOSED` (operational telemetry) | yes — `reason: "ip_rate_limit_redis_fail"`. Co-emit; the two events serve different consumers (RLFC = Redis outage detection, EBCIF = bridge-code forensic). |
| 2 | Origin allowlist miss / `EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS` unset | pre-auth | none | yes — `reason: "origin_disallowed"` |
| 3 | Body schema reject | pre-auth | none | yes — `reason: "body_schema_invalid"` |
| 4 | `auth()` returns no user | pre-auth (no resolved userId) | none | yes — `reason: "unauthenticated"` |
| 4-deleted | `userRecord === null` (stale session) | post-auth (userId from session) | none | yes — `reason: "user_not_found"` |
| 4a | Tenant IP restriction deny | post-auth | `ACCESS_DENIED` (emitted by `checkAccessRestrictionWithAudit`) | yes — `reason: "tenant_access_restricted"`. Supplementary — generic `ACCESS_DENIED` does not identify the bridge-code route in SIEM queries that filter by `EXTENSION_BRIDGE_CODE_*`. |
| 5 | Step-up required | post-auth | none | yes — `reason: "step_up_required"` |
| 6a | Per-user rate-limit 429 | post-auth | none | yes — `reason: "rate_limit"` |
| 6b | Per-user rate-limit 503 (Redis fail) | post-auth | `RATE_LIMIT_FAIL_CLOSED` | yes — `reason: "rate_limit_redis_fail"`. Same rationale as 1b. |
| 7 | DPoP verify fails | post-auth | none | yes — `reason: "dpop_invalid"`, plus `dpopError: result.error` |
| 8 | DB write throws | post-auth | none | yes — `reason: "db_error"`. Wraps the existing un-caught `withBypassRls` in `try { ... } catch { emit + return INTERNAL_ERROR }`, mirroring the pattern at `extension/token/exchange/route.ts:220-237`. |

### Schema / constants / i18n changes

- `prisma/schema.prisma` — add `EXTENSION_BRIDGE_CODE_ISSUE_FAILURE` to the
  `AuditAction` enum.
- `prisma/migrations/<timestamp>_add_extension_bridge_code_issue_failure_audit_action/migration.sql`:
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXTENSION_BRIDGE_CODE_ISSUE_FAILURE';`
  (matches the established pattern from migration `20260524030428_add_extension_token_legacy_issuance_blocked_audit_action`).
- `src/lib/constants/audit/audit.ts`:
  - Add `EXTENSION_BRIDGE_CODE_ISSUE_FAILURE: "EXTENSION_BRIDGE_CODE_ISSUE_FAILURE"` to `AUDIT_ACTION`.
  - Add `AUDIT_ACTION.EXTENSION_BRIDGE_CODE_ISSUE_FAILURE` to `AUDIT_ACTION_VALUES`.
  - Add to `AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.AUTH]` (the existing extension-related actions live in `AUTH` — see line 436-440).
- `messages/en/AuditLog.json`: `"EXTENSION_BRIDGE_CODE_ISSUE_FAILURE": "Extension bridge code issuance failed"`
- `messages/ja/AuditLog.json`: `"EXTENSION_BRIDGE_CODE_ISSUE_FAILURE": "拡張機能ブリッジコード発行に失敗"`

No changes required to:
- `audit-action-icons.tsx` — uses `Partial<Record>` with a default icon fallback; explicit mapping is optional.
- `AUDIT_ACTION_GROUPS_TEAM` / `AUDIT_ACTION_GROUPS_TENANT` — bridge-code is per-user; existing `EXTENSION_BRIDGE_CODE_ISSUE` is `PERSONAL`-only.

### Emission helper (new file)

`src/lib/audit/bridge-code-failure.ts`:

```ts
// Signature contract — no body for review
import type { DpopVerifyError } from "@/lib/auth/dpop/verify";

export type BridgeCodeFailureReason =
  | "ip_rate_limit"
  | "ip_rate_limit_redis_fail"
  | "origin_disallowed"
  | "body_schema_invalid"
  | "unauthenticated"
  | "user_not_found"
  | "tenant_access_restricted"
  | "step_up_required"
  | "rate_limit"
  | "rate_limit_redis_fail"
  | "dpop_invalid"
  | "db_error";

// Discriminated union — only `dpop_invalid` carries extra metadata, and that
// extra is typed as the verifier's enum (no free-form strings).
export type BridgeCodeFailureArgs =
  | { req: NextRequest; userId: string | null; tenantId: string | null;
      reason: Exclude<BridgeCodeFailureReason, "dpop_invalid"> }
  | { req: NextRequest; userId: string | null; tenantId: string | null;
      reason: "dpop_invalid"; dpopError: DpopVerifyError };

export function emitBridgeCodeIssueFailure(
  args: BridgeCodeFailureArgs,
): Promise<void>;
```

Why a helper:
- DRYs the 12 call sites.
- Encapsulates the `userId === null → SYSTEM_ACTOR_ID + actorType: SYSTEM` rule
  so call sites at Steps 1–3 cannot accidentally emit with a phantom userId.
- The discriminated union prevents future callers from leaking user-controlled
  strings into `metadata`.

**Test mocking layer**: the existing `bridge-code/route.test.ts` mocks
`@/lib/audit/audit` (`mockLogAudit`). The new helper is NOT mocked at the
route-test layer — route tests assert on the audit row shape that
`emitBridgeCodeIssueFailure` produces via `logAuditAsync`. The helper's own
unit tests live in `src/lib/audit/bridge-code-failure.test.ts` and mock
`@/lib/audit/audit` directly. This matches the established pattern at
`extension/token/exchange/route.test.ts:289-319`.

## Contracts

### C1 — Schema: new enum value (locked)

- `prisma/schema.prisma` adds `EXTENSION_BRIDGE_CODE_ISSUE_FAILURE` to `AuditAction`.
- Migration `<timestamp>_add_extension_bridge_code_issue_failure_audit_action/migration.sql`
  consists of exactly one statement:
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXTENSION_BRIDGE_CODE_ISSUE_FAILURE';`
- **Invariant**: migration timestamp is later than the latest existing migration
  (`20260524060000_extension_dpop_sender_constrained`).
- **Acceptance**: `npx prisma migrate dev` on the dev DB succeeds without drift;
  `npx prisma generate` produces a `AuditAction` enum that contains the new value.
- **Forbidden patterns**:
  - `ALTER TYPE "AuditAction" .* (?:DROP|RENAME).*EXTENSION_BRIDGE_CODE_ISSUE_FAILURE` — reason: enum drops require a destructive migration; out of scope.

### C2 — Failure reason taxonomy (locked)

- Type alias `BridgeCodeFailureReason` (string literal union) is exported from
  `src/lib/audit/bridge-code-failure.ts` with exactly the 12 reasons listed in the helper signature above.
- **Invariant**: every call site that emits `EXTENSION_BRIDGE_CODE_ISSUE_FAILURE`
  passes a `reason` from this union (type-checked).
- **Acceptance**: TypeScript build refuses any string outside the union as a
  `reason`. The reason is preserved verbatim in `metadata.reason` on the
  emitted audit row.
- **Forbidden patterns**:
  - `metadata:\s*\{[^}]*reason:\s*['"][^'"]+['"]` outside `bridge-code/route.ts` and the helper that does not source `reason` from the union — reason: prevents drift to free-form strings.

### C3 — Emission helper signature (locked)

- File: `src/lib/audit/bridge-code-failure.ts`.
- Named export `emitBridgeCodeIssueFailure` with signature above, narrowed by a
  **discriminated union** on `reason` for the `extra` shape:
  ```ts
  type BridgeCodeFailureArgs =
    | { req: NextRequest; userId: string | null; tenantId: string | null; reason: Exclude<BridgeCodeFailureReason, "dpop_invalid"> }
    | { req: NextRequest; userId: string | null; tenantId: string | null; reason: "dpop_invalid"; dpopError: DpopVerifyError };
  ```
  `DpopVerifyError` is the typed enum imported from `@/lib/auth/dpop/verify`.
  No free-form `extra: Record<string, unknown>` exists; reasons other than
  `dpop_invalid` carry no extra metadata. This forecloses the class of bug
  where a future caller passes through a user-controlled string.
- **Invariants**:
  - When `userId === null`, the function passes `userId: SYSTEM_ACTOR_ID` and `actorType: ACTOR_TYPE.SYSTEM` to `logAuditAsync` (this is the contract that pre-auth call sites rely on).
  - When `userId !== null`, omits `actorType` (defaults to HUMAN via `buildOutboxPayload`).
  - Final `metadata` is built as `{ reason, ...(reason === "dpop_invalid" && { dpopError }) }`. No spread-precedence trap: `reason` is the only top-level key for non-DPoP cases, and `dpopError` cannot overwrite it.
  - Function returns the `Promise<void>` from `logAuditAsync` — never throws (MF2 propagates).
- **Acceptance**: a unit test verifies each invariant with `vi.mock("@/lib/audit/audit", ...)`.

### C4 — Route emission sites (locked)

- `src/app/api/extension/bridge-code/route.ts` calls `emitBridgeCodeIssueFailure`
  immediately before every `return X` on a failure path. The current success
  path's `logAuditAsync({ ..., action: EXTENSION_BRIDGE_CODE_ISSUE })` is unchanged.
- **Site mapping** (line numbers will shift; binding is by step comment):
  | Step | Trigger | userId | tenantId | reason |
  |------|---------|--------|----------|--------|
  | 1 | `if (ipBlocked) return ipBlocked` — branch by 429 vs 503 (`ipRl.redisErrored`) | null | null | `ip_rate_limit` / `ip_rate_limit_redis_fail` |
  | 2 | `if (!isBridgeCodeOriginAllowed(origin)) return forbidden()` | null | null | `origin_disallowed` |
  | 3 | `if (!bodyResult.ok) return bodyResult.response` | null | null | `body_schema_invalid` |
  | 4 | `if (!session?.user?.id) return unauthorized()` | null | null | `unauthenticated` |
  | 4-deleted | `if (!userRecord) return unauthorized()` | userId | null | `user_not_found` |
  | 4a | `if (!access.allowed) return errorResponse(ACCESS_DENIED)` | userId | tenantId | `tenant_access_restricted` |
  | 5 | `if (stepUpError) return stepUpError` | userId | tenantId | `step_up_required` |
  | 6 | `if (blocked) return blocked` — branch by 429 vs 503 | userId | tenantId | `rate_limit` / `rate_limit_redis_fail` |
  | 7 | `if (!dpopResult.ok) return unauthorized()` | userId | tenantId | `dpop_invalid` + `extra: { dpopError: dpopResult.error }` |
  | 8 | `await withBypassRls(...)` throws | userId | tenantId | `db_error` |

- **Step 1 / 6 branching**: today, `checkRateLimitOrFail` returns the same
  `NextResponse` for 429 and 503; the caller cannot tell them apart from the
  response. To distinguish reasons, the route inspects the upstream
  `RateLimitResult` (`ipRl` already available at Step 1; the per-user call
  must be refactored to use the pre-computed-result form of `checkRateLimitOrFail`
  — `{ result: rl }` — so the route observes `rl.redisErrored`). The reshape is
  mechanical and changes no behavior. Acceptance preserves the existing 429/503
  status codes and bodies.

  **Emit gating** (must be explicit at the call site):
  ```ts
  // Step 1 (IP limiter)
  const ipRl = await checkIpRateLimit({ ... });
  const ipBlocked = await checkRateLimitOrFail({ result: ipRl, ... });
  if (ipBlocked) {
    await emitBridgeCodeIssueFailure({
      req, userId: null, tenantId: null,
      reason: ipRl.redisErrored ? "ip_rate_limit_redis_fail" : "ip_rate_limit",
    });
    return ipBlocked;
  }

  // Step 6 (per-user limiter)
  const rl = await bridgeCodeLimiter.check(`rl:ext_bridge:${userId}`);
  const blocked = await checkRateLimitOrFail({ result: rl, req, scope: "extension.bridge_code", userId });
  if (blocked) {
    await emitBridgeCodeIssueFailure({
      req, userId, tenantId: userRecord.tenantId,
      reason: rl.redisErrored ? "rate_limit_redis_fail" : "rate_limit",
    });
    return blocked;
  }
  ```
  The emit fires ONLY inside the `if (blocked)` branch — never on the success
  path. The success path (when `rl.allowed === true`) emits nothing here and
  reaches the existing success-emit at Step 8's tail.

- **Step 1b / 6b emit ordering**: post-refactor, `EXTENSION_BRIDGE_CODE_ISSUE_FAILURE`
  is enqueued AFTER `RATE_LIMIT_FAIL_CLOSED` for the Redis-fail path. The
  wrapper internally calls `emitRateLimitFailClosed` before returning, then we
  emit our own action. The two rows arrive in `audit_outbox` in that order.
  Operators correlating on `createdAt` see RLFC first, then EBCIF. This is a
  consistent ordering across both IP (Step 1) and per-user (Step 6) gates.

- **Step 8 wrap**: the existing `await withBypassRls(...)` becomes:
  ```ts
  try {
    await withBypassRls(prisma, async (tx) => { /* unchanged */ }, BYPASS_PURPOSE.TOKEN_LIFECYCLE);
  } catch (err) {
    await emitBridgeCodeIssueFailure({ req, userId, tenantId: userRecord.tenantId, reason: "db_error" });
    getLogger().error({ event: "extension_bridge_code_issue_failure", reason: "db_error", err }, "bridge-code issue failed: DB write threw");
    return errorResponse(API_ERROR.INTERNAL_ERROR);
  }
  ```
  Pattern lifted verbatim from `extension/token/exchange/route.ts:213-237` for the analogous `issueExtensionToken` throw.

- **Invariant — single-emit**: each route invocation that reaches a failure path
  emits exactly one `EXTENSION_BRIDGE_CODE_ISSUE_FAILURE` event. Multiple emits
  per request indicate a bug. (`ACCESS_DENIED` from `checkAccessRestrictionWithAudit`
  and `RATE_LIMIT_FAIL_CLOSED` from `checkRateLimitOrFail` are *different* audit
  actions and are not counted as "duplicate emits"; co-emission is intentional.)

- **Forbidden patterns** (grep, applied to the route file only):
  - `action:\s*AUDIT_ACTION\.EXTENSION_BRIDGE_CODE_ISSUE_FAILURE` — reason: emit MUST go through the helper, not direct `logAuditAsync` calls in the route.

- **Single-emit invariant enforcement**: enforced at the **test layer** via the
  reason-by-test map in C6 + `expect(mockLogAudit).toHaveBeenCalledTimes(1)` on
  every failure-path test. Static greps for "emit precedes return" cannot
  reliably express the invariant with line-anchored regex (variable line
  count between emit and return), so we rely on test coverage instead.

### C5 — i18n + grouping (locked)

- `messages/en/AuditLog.json` and `messages/ja/AuditLog.json` each add a single
  entry keyed `EXTENSION_BRIDGE_CODE_ISSUE_FAILURE`.
- `AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.AUTH]` gains
  `AUDIT_ACTION.EXTENSION_BRIDGE_CODE_ISSUE_FAILURE`.
- **Acceptance**: `audit-action-group-coverage.test.ts` and
  `audit-i18n-coverage.test.ts` pass without modification.

### C6 — Test coverage (locked)

**Mock layer**: route tests mock `@/lib/audit/audit` (`mockLogAudit`), NOT the
helper. Assertions read the audit row shape produced by the helper through
`logAuditAsync`. This matches `extension/token/exchange/route.test.ts:289-319`.

**Reason × test matrix** (every `reason` in C2 has at least one test asserting
`mockLogAudit.toHaveBeenCalledWith({ action: EXTENSION_BRIDGE_CODE_ISSUE_FAILURE, metadata: expect.objectContaining({ reason: <value> }), userId: <expected>, ... })`):

| Reason | Test case | New / extends existing |
|--------|-----------|------------------------|
| `ip_rate_limit` | "emits failure audit with `ip_rate_limit` when IP rate-limit returns 429" | new |
| `ip_rate_limit_redis_fail` | "emits failure audit with `ip_rate_limit_redis_fail` when IP limiter Redis-fails" | new |
| `origin_disallowed` | "emits failure audit with `origin_disallowed` when Origin header is not in allowlist" | new |
| `body_schema_invalid` | "emits failure audit with `body_schema_invalid` when body contains unknown keys" | new |
| `unauthenticated` | "returns 401 when not authenticated" (extend) | extends existing |
| `user_not_found` | "returns 401 when the user record cannot be resolved (deleted user)" (extend) | extends existing |
| `tenant_access_restricted` | "returns 403 when tenant IP access restriction denies" (extend) | extends existing |
| `step_up_required` | "returns 403 when session step-up is required" (extend) | extends existing |
| `rate_limit` | "returns 429 when per-user rate limited" (extend) | extends existing |
| `rate_limit_redis_fail` | "emits failure audit with `rate_limit_redis_fail` when per-user limiter Redis-fails" | new |
| `dpop_invalid` | "emits failure audit with `dpop_invalid` + dpopError when DPoP verify fails" | new |
| `db_error` | "emits failure audit with `db_error` when bridge-code create throws" | new |

**Count assertions** (closes single-emit / cross-contamination loopholes):
- Every failure-path test asserts `expect(mockLogAudit).toHaveBeenCalledTimes(1)`.
- The success-path test additionally asserts
  `expect(mockLogAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "EXTENSION_BRIDGE_CODE_ISSUE_FAILURE" }))`.
- The success-path test asserts `toHaveBeenCalledTimes(1)` (the success action).

**Step 8 (`db_error`) test mock pattern**:
`mockBridgeCodeCreate.mockRejectedValueOnce(new Error("simulated DB write failure"))`
(use `mockRejectedValueOnce`, not `mockRejectedValue`, to avoid leaking the
rejection to subsequent tests in the file). Mirrors
`extension/token/exchange/route.test.ts:298`.

**`src/lib/audit/bridge-code-failure.test.ts`** (new file) — minimum tests for
C3 invariants:
1. `it("uses SYSTEM_ACTOR_ID and actorType=SYSTEM when userId is null")` —
   call with `userId: null`, assert `mockLogAudit` payload carries `userId: SYSTEM_ACTOR_ID, actorType: ACTOR_TYPE.SYSTEM`.
2. `it("does not set actorType when userId is provided")` — call with a real
   userId, assert `actorType` is `undefined` (or absent) on the payload (HUMAN
   default applied downstream by `buildOutboxPayload`).
3. `it("merges dpopError only for reason='dpop_invalid'")` — call with `reason: "dpop_invalid", dpopError: ...`, assert `metadata.dpopError` is set.
   Counter-test: call with `reason: "origin_disallowed"`, assert `metadata` has only `{ reason }`.
4. `it("never throws when logAuditAsync rejects")` — mock `logAuditAsync` to
   reject, await the helper, assert no throw bubbles up (MF2 contract).

**Cross-cutting coverage** (no modification needed, but runs as part of
`scripts/pre-pr.sh`):
- `audit-action-group-coverage.test.ts`
- `audit-i18n-coverage.test.ts`

**No new integration test** in this PR — emission semantics are fully captured
by `logAuditAsync` unit tests; this PR only adds new call sites, not new
outbox/delivery behavior.

### C7 — Consumer-flow walkthrough (locked)

`EXTENSION_BRIDGE_CODE_ISSUE_FAILURE` events are consumed by:

- **Consumer A** (path: `src/app/[locale]/dashboard/audit-logs/page.tsx` + the
  generic audit log list view): reads `{ action, metadata, ip, userAgent,
  occurredAt, userId, tenantId }` and renders the i18n label for `action` plus a
  generic metadata pretty-print. No code-path branches on `action ===
  EXTENSION_BRIDGE_CODE_ISSUE_FAILURE`; the i18n label string alone carries the
  semantics. Required fields are all present in the emitted shape via
  `logAuditAsync` + `extractRequestMeta` + the audit_logs DB row.
- **Consumer B** (path: `src/lib/audit/delivery/*`, audit outbox -> external
  SIEM forwarder): reads the entire audit row and forwards it as JSON. No
  field-level dependency beyond what `buildOutboxPayload` already constructs.
- **Consumer C** (path: `src/__tests__/audit-action-group-coverage.test.ts`):
  reads the action name, checks for group membership. Required: action value
  registered in `AUDIT_ACTION_VALUES` and at least one group — both covered by C5.
- **Consumer D** (path: `src/__tests__/audit-i18n-coverage.test.ts`): reads the
  action name + en/ja label sets. Required: both label files key the action — covered by C5.

No consumer requires a field that is not in the locked emission shape.

## Testing strategy

- **Unit tests**:
  - `bridge-code-failure.test.ts` — helper invariants.
  - `bridge-code/route.test.ts` — every failure path emits with the expected `reason`.
- **Coverage tests** (already in repo, no modification):
  - `audit-action-group-coverage.test.ts`
  - `audit-i18n-coverage.test.ts`
- **Manual DB migration check** (memory `feedback_run_migration_on_dev_db.md`):
  run `npm run db:migrate` against the dev DB before opening the PR. The
  migration is additive (`ALTER TYPE ... ADD VALUE IF NOT EXISTS`) and is
  idempotent on re-run.
- **No browser/E2E test**. This change has no UI surface.

## Considerations & constraints

- **Pre-auth audit emission and `resolveTenantId`**: `logAuditAsync` resolves
  `tenantId` from a UUID userId when `tenantId` is not passed. The
  `SYSTEM_ACTOR_ID` value is a sentinel UUID that has no `User` row, so
  `resolveTenantId` returns `null` and the entry goes to dead-letter
  (`tenant_not_found`). For the pre-auth steps (1/2/3/4), we are intentionally
  emitting without a tenantId — these events are *structured-log-only* in
  practice today, since the audit row write needs a tenant. **Decision**: keep
  pre-auth emits as `userId: SYSTEM_ACTOR_ID, tenantId: null` and accept the
  dead-letter behaviour. The structured JSON log (auditLogger.info) at
  `audit.ts:233-251` fires unconditionally and is the operational surface for
  pre-auth events; this matches `emitAuthLoginFailure`'s behaviour for
  unknown-email failures. Documented in the contract; not a regression.

- **Pre-auth emit volume**: Step 1's IP rate-limit (60/min/IP, fail-closed)
  is the upper bound on attacker-driven pre-auth emit rate. Steps 2/3/4 only
  fire when Step 1 has admitted the request, so all pre-auth audit emits are
  collectively capped at the IP rate-limit's budget. No additional throttle is
  added at the helper layer — symmetric with `emitAuthLoginFailure`, which
  also relies on its upstream IP rate-limit. (Multi-source botnet traffic can
  still flood the dead-letter / pino channels at scale, but that property is
  pre-existing across every pre-auth route.)

- **`user_not_found` row also dead-letters**: §C4 row "4-deleted" emits with
  `userId: session.user.id, tenantId: null`. If the userId references a
  deleted-user row, `resolveTenantId` cannot resolve a tenant and the entry
  dead-letters — same surface as the pre-auth cases. Documented; not a
  regression of existing behaviour.

- **`db_error` reason: cascading DB outage**: when the original write failure
  is caused by the DB being down, the audit-emit for `reason: "db_error"`
  also hits the same DB. `logAuditAsync` swallows that internally
  (`audit.ts:268-273`), so the only observable record lives in the pino
  structured-log stream (`auditLogger.info` at `audit.ts:233`). SIEM consumers
  that query the `audit_logs` table will not see `db_error` rows during a DB
  outage; consumers that ingest the `_logType: "audit"` log stream will. This
  is the same property `EXTENSION_TOKEN_EXCHANGE_FAILURE` has today —
  consistent, documented.

- **Co-emission timing with `ACCESS_DENIED` / `RATE_LIMIT_FAIL_CLOSED`**: at
  Step 4a, both `ACCESS_DENIED` (via `checkAccessRestrictionWithAudit`) and
  `EXTENSION_BRIDGE_CODE_ISSUE_FAILURE` fire from the same request. At Step
  1b/6b, both `RATE_LIMIT_FAIL_CLOSED` (via `emitRateLimitFailClosed` inside
  the wrapper) and our action fire. Both pairs share `extractRequestMeta(req)`
  (same IP, UA, ~timestamp). SIEM authors should dedupe on
  `(scope, action, userId, ip, request_id)` rather than `(userId, ip, ts±1s)`
  to avoid double-counting. Operational only — not exploitable.

- **`EXTENSION_BRIDGE_CODE_*` is PERSONAL-only**: consistent with the existing
  `EXTENSION_BRIDGE_CODE_ISSUE`. No `AUDIT_ACTION_GROUPS_TEAM` or
  `AUDIT_ACTION_GROUPS_TENANT` entry; no tenant webhook fan-out. Tenant
  operators consume via audit-log delivery (SIEM forwarder), not webhooks.

- **Step 1/6 redis-fail vs 429 disambiguation**: the route already has
  `ipRl: RateLimitResult` in scope at Step 1 and can branch on `redisErrored`
  before/after the `checkRateLimitOrFail` call. For Step 6, the route currently
  passes `{ limiter, key }` to `checkRateLimitOrFail`; the refactor is to call
  `limiter.check(key)` once, branch the audit emit on `rl.redisErrored`, then
  call `checkRateLimitOrFail({ result: rl, ... })`. This double-resolution is
  the pattern the wrapper supports (see `rate-limit-audit.ts:225-230`).

- **Anti-deferral**: this plan does NOT defer "test all 12 reasons" to a future
  PR. All test cases are part of this PR's acceptance.

- **Pre-PR developer reminder**: after editing `audit.ts` /
  `messages/{en,ja}/AuditLog.json`, run
  `npx vitest run src/__tests__/audit-action-group-coverage.test.ts src/__tests__/audit-i18n-coverage.test.ts`
  locally before push. The cross-cutting tests are part of `scripts/pre-pr.sh`,
  but a developer running only the route-scoped vitest may miss them. See
  memory `feedback_run_pre_pr_before_push.md`.

- **Out of scope**:
  - C15 (userActivation gating) — separate PR per the C14/C15 split decision.
  - Adding `EXTENSION_BRIDGE_CODE_ISSUE_FAILURE` to `audit-action-icons.tsx` —
    the map already has a fallback icon.
  - Webhook/SIEM forwarder side-changes — `buildOutboxPayload` is action-agnostic.
  - Throttling pre-auth audit emit beyond what Step 1's IP rate-limit provides.

## User operation scenarios

This change is server-only; user-facing surface is the audit log page.

- **Tenant admin SIEM query**: filter audit logs by `action LIKE
  'EXTENSION_BRIDGE_CODE_%'`. Before this PR, only success rows appear; after,
  the same query returns failures with `metadata.reason` for triage.
- **Personal audit log view** (`/dashboard/audit-logs`): an authenticated user
  who triggers a failed bridge-code issuance (e.g., step-up required) sees a row
  reading "Extension bridge code issuance failed" with the `reason` visible in
  the metadata pretty-print.
- **Anonymous attacker** (XSS-driven, pre-auth steps 1–3): no row in
  `audit_logs` (tenant cannot be resolved); operator-visible only through the
  application log stream. Documented as acceptable in "Considerations".

## Go/No-Go Gate

| ID  | Subject                                     | Status |
|-----|---------------------------------------------|--------|
| C1  | Schema: new enum value + migration          | locked |
| C2  | Failure reason taxonomy (12 reasons)        | locked |
| C3  | Emission helper signature & invariants      | locked |
| C4  | Route emission sites & Step 8 try/catch     | locked |
| C5  | i18n + AUDIT_ACTION_GROUPS_PERSONAL[AUTH]   | locked |
| C6  | Test coverage (route + helper)              | locked |
| C7  | Consumer-flow walkthrough                   | locked |
