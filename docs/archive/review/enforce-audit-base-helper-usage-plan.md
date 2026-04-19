# Plan: enforce-audit-base-helper-usage

## Project context

- **Type**: web app (Next.js 16 App Router) — TypeScript / Prisma / multi-tenant SaaS
- **Test infrastructure**: unit tests (Vitest, mocked + real-DB integration suites) + CI/CD (next build, lint, vitest, integration tests against real Postgres)
- **Scope of change**: refactor only — no new features, no schema change, no behavior change. Pure call-site migration to use existing `*AuditBase` helpers.

## Objective

Migrate every `logAudit*` call site that has `req: NextRequest` in scope to use one of the three `*AuditBase` helpers (`personalAuditBase` / `teamAuditBase` / `tenantAuditBase`) defined in [src/lib/audit.ts](src/lib/audit.ts).

The helpers exist precisely to prevent the recurring class of bug where call sites forget `extractRequestMeta(req)` (losing forensic ip/userAgent capture) or set the wrong `scope`. The recent commit `9f5b287c fix(mcp): switch mcp/token audit calls to tenantAuditBase (forensic ip/userAgent capture)` is a concrete instance of that bug. This refactor closes the remaining surface area.

## Requirements

### Functional
1. Every `logAudit{Async,InTx,BulkAsync}` call site in `src/app/api/**/route.ts` that has `req`/`request: NextRequest` in scope MUST use one of `personalAuditBase` / `teamAuditBase` / `tenantAuditBase`.
2. Behavior preservation: each migration MUST produce an identical `AuditOutboxPayload` to the pre-migration call. Specifically:
   - `scope` value identical (no scope drift)
   - `userId` identical
   - `teamId` / `tenantId` identical (including the conditional `teamId ? AUDIT_SCOPE.TEAM : AUDIT_SCOPE.PERSONAL` patterns)
   - `ip` identical (`extractClientIp` result; the helper calls `extractRequestMeta` which wraps `extractClientIp`)
   - `userAgent` identical (raw header; helper passes the raw string, which `buildOutboxPayload` then truncates to `USER_AGENT_MAX_LENGTH`)
   - `acceptLanguage` is captured by `extractRequestMeta` but is NOT included in `AuditOutboxPayload` — helper adds an extra discarded field, which is harmless. Confirm via reading `buildOutboxPayload`.

   **EXCEPTION — pre-existing forensic-field omissions are CORRECTED, not preserved**: at the following Bucket B sites, the current code omits `userAgent` (or `ip`). The helper migration intentionally adds the missing field — this is a forensic upgrade, not a regression. Do NOT add `userAgent: null` after the helper spread to "preserve behavior":
   - [src/app/api/admin/rotate-master-key/route.ts:113-124](src/app/api/admin/rotate-master-key/route.ts#L113-L124) — `MASTER_KEY_ROTATION` event currently omits `userAgent` (passes `ip` only).
   - [src/app/api/mcp/authorize/consent/route.ts:152-161](src/app/api/mcp/authorize/consent/route.ts#L152-L161) — `MCP_CLIENT_DCR_CLAIM` event currently omits `userAgent` (passes `ip: claimIp` only).
   The chain hash (verified via `/api/maintenance/audit-chain-verify`) hashes the persisted column shape; a populated `userAgent` post-migration is a hash-continuity event, NOT a chain break (each link references the prior event's hash, not its schema). See §Considerations/Risks for details.
3. Call sites in non-route contexts (NextAuth callbacks, library functions without `req`, background workers, MCP tools) are out of scope and remain as-is.

### Non-functional
4. No new helpers introduced unless an existing one cannot fit a real call site. Justify any helper addition in the deviation log.
5. All existing tests pass; no test changes required EXCEPT where a test's exact-shape assertion includes payload fields the helper happens to add (e.g., `acceptLanguage` is dropped by `buildOutboxPayload` so should not affect tests, but verify).
6. Lint, `npx vitest run`, integration tests, and `npx next build` all pass per CLAUDE.md mandatory checks.

## Technical approach

### Helper API (no change)

```ts
personalAuditBase(req, userId)        // → { scope: PERSONAL, userId, ip, userAgent, acceptLanguage }
teamAuditBase(req, userId, teamId)    // → { scope: TEAM, userId, teamId, ip, userAgent, acceptLanguage }
tenantAuditBase(req, userId, tenantId) // → { scope: TENANT, userId, tenantId, ip, userAgent, acceptLanguage }
```

### Migration patterns

**Pattern 1: simple (most cases)** — fixed scope, no conditional.

Before:
```ts
const { ip, userAgent } = extractRequestMeta(req);
await logAuditAsync({
  scope: AUDIT_SCOPE.TENANT,
  userId,
  tenantId,
  action,
  ip,
  userAgent,
});
```

After:
```ts
await logAuditAsync({
  ...tenantAuditBase(req, userId, tenantId),
  action,
});
```

**Pattern 2: spread `extractRequestMeta(req)`** — same as pattern 1, the spread call is replaced by the helper spread.

Before:
```ts
await logAuditAsync({
  scope: AUDIT_SCOPE.TENANT,
  userId: SYSTEM_ACTOR_ID,
  actorType: ACTOR_TYPE.SYSTEM,
  tenantId,
  action,
  ...extractRequestMeta(req),
});
```

After:
```ts
await logAuditAsync({
  ...tenantAuditBase(req, SYSTEM_ACTOR_ID, tenantId),
  actorType: ACTOR_TYPE.SYSTEM,
  action,
});
```

**Pattern 3: conditional team-vs-personal scope** — common in `audit-logs/export`, `audit-logs/import`, `watchtower/alert`, `share-links/[id]`.

Before:
```ts
await logAuditAsync({
  scope: teamId ? AUDIT_SCOPE.TEAM : AUDIT_SCOPE.PERSONAL,
  userId,
  teamId: teamId ?? undefined,
  ...extractRequestMeta(req),
  action,
});
```

After:
```ts
await logAuditAsync({
  ...(teamId ? teamAuditBase(req, userId, teamId) : personalAuditBase(req, userId)),
  action,
});
```

**Pattern 4: conditional team-vs-tenant scope** — `vault/admin-reset/route.ts` is the only known instance.

Before:
```ts
const auditScope = resetRecord.teamId ? AUDIT_SCOPE.TEAM : AUDIT_SCOPE.TENANT;
await logAuditAsync({
  scope: auditScope,
  userId,
  ...(resetRecord.teamId ? { teamId: resetRecord.teamId } : { tenantId }),
  ...extractRequestMeta(req),
  action,
});
```

After:
```ts
await logAuditAsync({
  ...(resetRecord.teamId
    ? teamAuditBase(req, userId, resetRecord.teamId)
    : tenantAuditBase(req, userId, tenantId)),
  action,
});
```

**Pattern 5: dual-scope emit** — `vault/delegation/route.ts:213-216` emits the SAME event under both PERSONAL and TENANT scopes via `Promise.all`. The helper applies cleanly by extracting the shared body.

Before:
```ts
const auditBase = { action, userId, tenantId, targetId, metadata, ip, userAgent };
await Promise.all([
  logAuditAsync({ ...auditBase, scope: AUDIT_SCOPE.PERSONAL }),
  logAuditAsync({ ...auditBase, scope: AUDIT_SCOPE.TENANT }),
]);
```

After:
```ts
const auditBody = { action, targetId, metadata };
await Promise.all([
  // tenantId MUST be preserved on the PERSONAL emit — see note below.
  logAuditAsync({ ...personalAuditBase(request, userId), tenantId, ...auditBody }),
  logAuditAsync({ ...tenantAuditBase(request, userId, tenantId), ...auditBody }),
]);
```

Note: `request` (not `req`) — preserve the variable name from the source.

**`tenantId` preservation on PERSONAL emit (mandatory)**: The `personalAuditBase` helper does NOT set `tenantId` (PERSONAL scope is per-user). However, the existing test `vault/delegation/route.test.ts:350-359` explicitly asserts `tenantId: TENANT_ID` on the PERSONAL emit, AND the structured JSON log line emitted by `auditLogger.info` reads `params.tenantId ?? null`. Pre-migration the field is set; post-migration it would become `null` if dropped. Both the test and the JSON log shape require `tenantId` to remain explicit. The `tenantId` placement AFTER the helper spread (correct override ordering) is mandatory.

**Pattern 6: in-transaction calls (`logAuditInTx`)** — the helper return type is the same shape, spreads cleanly into the params argument. The fact that `tenantId` may also be passed as the explicit second arg is harmless (the params-object `tenantId` is not used by `enqueueAuditInTx`).

Before:
```ts
const { ip, userAgent } = extractRequestMeta(req);
await prisma.$transaction(async (tx) => {
  // ...
  await logAuditInTx(tx, share.tenantId, {
    scope: teamPasswordEntryId ? AUDIT_SCOPE.TEAM : AUDIT_SCOPE.PERSONAL,
    userId,
    teamId,
    targetId,
    action,
    ip,
    userAgent,
  });
});
```

After:
```ts
// IMPORTANT: delete the pre-tx `const { ip, userAgent } = extractRequestMeta(req)` line
// when its only consumer was the migrated audit call. The helper handles extraction internally.
await prisma.$transaction(async (tx) => {
  // ...
  await logAuditInTx(tx, share.tenantId, {
    ...(teamPasswordEntryId ? teamAuditBase(req, userId, teamId) : personalAuditBase(req, userId)),
    targetId,
    action,
  });
});
```

**Pattern 7: direct `extractClientIp(req)` (without `extractRequestMeta`)** — two Bucket B sites use `extractClientIp(request)` directly: `vault/delegation/check/route.ts:98` and `vault/delegation/route.ts:210`. These are functionally equivalent to `extractRequestMeta(request).ip` (the latter wraps the former). The helper migration replaces both forms identically.

Before:
```ts
await logAuditAsync({
  scope: AUDIT_SCOPE.PERSONAL,
  userId,
  ip: extractClientIp(request),
  userAgent: request.headers.get("user-agent"),
  // ...
});
```

After:
```ts
await logAuditAsync({
  ...personalAuditBase(request, userId),
  // ...
});
```

### Import updates (mandatory per file)

Every migrated file MUST update its import from `@/lib/audit`:

- Add the helper(s) used: `personalAuditBase` and/or `teamAuditBase` and/or `tenantAuditBase`.
- Remove `extractRequestMeta` from the import IF and only IF no remaining call site in the file still calls `extractRequestMeta(req)` directly. Several files (e.g., `auth/passkey/verify/route.ts`) call `extractRequestMeta` for purposes other than audit (e.g., session metadata, lockout context) — leave those imports intact.
- `AUDIT_SCOPE` import from `@/lib/constants` may be removable IF no remaining usage of `AUDIT_SCOPE` exists in the file after migration. Several files use `AUDIT_SCOPE` in non-audit-emit contexts (notification scope, query filters) — leave imports intact in those cases.

Reviewer obligation: per-file, run `npx tsc --noEmit` mentally (or actually) by checking that no orphan imports remain. Lint will catch unused imports as warnings; CI is configured for zero warnings (per CLAUDE.md mandatory checks), so this is enforced.

### Variable name preservation

Source files use either `req` or `request` for the `NextRequest` parameter. Migrations MUST preserve the source variable name — do NOT rename to a global convention. Examples:
- `src/app/api/internal/audit-emit/route.ts` uses `request`
- `src/app/api/vault/delegation/route.ts` uses `request`
- Most others use `req`

### Equivalence verification

For each migration, confirm the helper's return shape matches the manually-built object. The helper drops the manual setup of:
- `scope` (helper supplies)
- `userId` (helper supplies)
- `teamId` / `tenantId` (helper supplies for team/tenant variants)
- `ip` (helper supplies via `extractRequestMeta`)
- `userAgent` (helper supplies via `extractRequestMeta`)

The helper adds `acceptLanguage`, which `buildOutboxPayload` does NOT include in the outbox payload — confirmed by reading [src/lib/audit.ts](src/lib/audit.ts) lines 101-118. So no behavior change in the persisted audit record or downstream JSON log.

## Inventory completeness

The Bucket B target list is the result of a full enumeration over `src/` (excluding `__tests__/`, `*.test.ts`, and `src/lib/audit.ts` itself). Total `logAudit{Async,InTx,BulkAsync}` call sites in production code: **315 across 132 files**. Breakdown:

- Bucket A (already uses helpers): 220 sites
- Bucket B (this plan migrates): 56 sites across 24 files
- Bucket C (out of scope, see "Considerations"): 39 sites across 13 files

Every file in `src/app/api/**/route.ts` that emits audit events is accounted for in exactly one bucket. Common false alarms to verify against:
- `src/app/api/vault/reset/**` — Bucket A (already uses helpers, verified by grep `AuditBase(req`)
- `src/app/api/vault/setup/**` — Bucket A
- `src/app/api/teams/[teamId]/**/route.ts` — Bucket A across all subroutes
- `src/app/api/passwords/**/route.ts` — Bucket A across all subroutes

If during implementation a new Bucket B site is found that is not listed in any batch, STOP and add it to the inventory + appropriate batch + record in the deviation log.

**`logAuditBulkAsync` coverage**: Verified by grep — every `logAuditBulkAsync` call site in `src/app/api/**/route.ts` already imports and uses `personalAuditBase` or `teamAuditBase`. No Bucket B site uses the bulk variant, so no separate migration pattern is needed for it. The `logAuditBulkAsync` accepts an array of `AuditLogParams`; each element is built using a helper spread the same way as `logAuditAsync`.

## Implementation steps

Step batches are designed to be independently reviewable; any failing batch can be reverted without affecting others.

1. **Batch 1 — Maintenance & admin endpoints (system-emitted, TENANT scope)** — 6 files:
   - [src/app/api/admin/rotate-master-key/route.ts](src/app/api/admin/rotate-master-key/route.ts)
   - [src/app/api/maintenance/audit-chain-verify/route.ts](src/app/api/maintenance/audit-chain-verify/route.ts)
   - [src/app/api/maintenance/audit-outbox-metrics/route.ts](src/app/api/maintenance/audit-outbox-metrics/route.ts)
   - [src/app/api/maintenance/audit-outbox-purge-failed/route.ts](src/app/api/maintenance/audit-outbox-purge-failed/route.ts)
   - [src/app/api/maintenance/dcr-cleanup/route.ts](src/app/api/maintenance/dcr-cleanup/route.ts)
   - [src/app/api/maintenance/purge-audit-logs/route.ts](src/app/api/maintenance/purge-audit-logs/route.ts)
   - [src/app/api/maintenance/purge-history/route.ts](src/app/api/maintenance/purge-history/route.ts)

2. **Batch 2 — Internal & MCP & extension endpoints** — 3 files / multiple call sites:
   - ~~[src/app/api/internal/audit-emit/route.ts](src/app/api/internal/audit-emit/route.ts)~~ — **MOVED to Bucket C** (no `tenantId` available without an extra DB lookup; see Considerations).
   - [src/app/api/mcp/authorize/consent/route.ts](src/app/api/mcp/authorize/consent/route.ts) (3 calls)
   - [src/app/api/mcp/register/route.ts](src/app/api/mcp/register/route.ts)
   - [src/app/api/extension/token/exchange/route.ts](src/app/api/extension/token/exchange/route.ts) (2 calls)

3. **Batch 3 — Audit-log meta endpoints (conditional team/personal)** — 3 files:
   - [src/app/api/audit-logs/export/route.ts](src/app/api/audit-logs/export/route.ts)
   - [src/app/api/audit-logs/import/route.ts](src/app/api/audit-logs/import/route.ts)
   - [src/app/api/watchtower/alert/route.ts](src/app/api/watchtower/alert/route.ts)

4. **Batch 4 — Vault & share-link endpoints (mixed including tx)** — 5 files:
   - [src/app/api/vault/admin-reset/route.ts](src/app/api/vault/admin-reset/route.ts) (conditional team/tenant)
   - [src/app/api/vault/delegation/route.ts](src/app/api/vault/delegation/route.ts) (dual emit personal+tenant)
   - [src/app/api/vault/delegation/check/route.ts](src/app/api/vault/delegation/check/route.ts)
   - [src/app/api/share-links/route.ts](src/app/api/share-links/route.ts) (logAuditInTx)
   - [src/app/api/share-links/[id]/route.ts](src/app/api/share-links/[id]/route.ts) (logAuditInTx, conditional)
   - [src/app/api/share-links/verify-access/route.ts](src/app/api/share-links/verify-access/route.ts) (2 calls)

5. **Batch 5 — SCIM & access-requests endpoints (TENANT scope)** — 4 files:
   - SCIM endpoints authenticate via SCIM token bound to a tenant admin user; that user's id is the audit actor (preserved from pre-migration behavior).
   - [src/app/api/scim/v2/Users/route.ts](src/app/api/scim/v2/Users/route.ts)
   - [src/app/api/scim/v2/Users/[id]/route.ts](src/app/api/scim/v2/Users/[id]/route.ts) (3 calls)
   - [src/app/api/scim/v2/Groups/[id]/route.ts](src/app/api/scim/v2/Groups/[id]/route.ts) (2 calls)
   - [src/app/api/tenant/access-requests/route.ts](src/app/api/tenant/access-requests/route.ts)

6. **Batch 6 — Documentation update** (must run AFTER Batches 1-5 land) — extend [src/lib/audit.ts](src/lib/audit.ts) module-doc to:
   - Mandate helper usage in route-handler context
   - Document Bucket C exceptions (auth callbacks, lib/, workers, mcp tools, `internal/audit-emit` due to no-tenantId-without-DB-lookup)
   - This batch references the migration completed in Batches 1-5; do NOT execute it ahead of order.

7. **Batch 7 — Verification**:
   - Run `npx vitest run`
   - Run `npm run test:integration` against local Postgres
   - Run `npx eslint .` (zero warnings)
   - Run `npx next build`
   - Run `scripts/pre-pr.sh` if available

## Testing strategy

### Existing test coverage

No new tests are required. The migration is behavior-preserving. Existing tests cover the call sites — they will catch any drift.

**Existing `extractRequestMeta` mocks transparently apply to helper-using sites — no mock updates required.** Many test files (e.g., `vault/reset/route.test.ts`, `auth/passkey/verify/route.test.ts`, `tenant/policy/route.test.ts`) mock `extractRequestMeta` at the module boundary. Helpers internally call `extractRequestMeta`, so the mocks apply transparently after migration.

**Audit payload assertion patterns** (verified by grep): Bucket B test files use `expect.objectContaining(...)` (partial match) for `logAuditAsync` arg assertions, NOT `toEqual`/`toStrictEqual` (exact shape). Helper additions like `acceptLanguage` therefore do not break existing tests. **Exception**: `vault/delegation/route.test.ts:350-359` explicitly asserts `tenantId: TENANT_ID` on the PERSONAL emit — Pattern 5 migration MUST preserve `tenantId` after the helper spread (see Pattern 5 mandatory note).

**Priority integration tests**: when running `npm run test:integration`, prioritize:
- `src/__tests__/integration/audit-and-isolation.test.ts` — queries `audit_logs` directly; catches column-shape regressions
- `src/__tests__/db-integration/audit-logaudit-non-atomic.integration.test.ts` — exercises non-tx audit write path

Specifically:
- `src/app/api/mcp/token/route.test.ts` — covers tenantAuditBase migration done in `9f5b287c`.
- `src/app/api/audit-logs/{export,import}/route.test.ts` — exists and exercises the conditional scope branch.
- `src/app/api/vault/delegation/route.test.ts` — covers the dual-emit pattern.
- `src/app/api/share-links/{route,[id]/route,verify-access/route}.test.ts` — covers tx variant.
- Most other Bucket B files have a corresponding `.test.ts`.

### Test red flags to watch (R19 / RT1)

Search every file under change for exact-shape assertions on the audit log payload. Specifically grep test files for:
- `expect(...).toEqual({` followed by an `audit:` or `scope:` field — exact-shape assertion that may need updating if helper's `acceptLanguage` reaches the assertion (it shouldn't, since `buildOutboxPayload` discards it before persistence/log emit, but verify).
- Mock `enqueueAudit` / `enqueueAuditInTx` / `enqueueAuditBulk` setups — confirm they don't assume a specific param-key order.

If any test fails after migration, do not "fix" the test by accommodating the new shape — investigate whether the helper produces a different effective payload. If yes, the helper is the bug, not the test.

### Manual verification

For one representative call per pattern (Patterns 1, 3, 5, 6), add a Vitest inline snapshot of the payload passed to `logAuditAsync` / `logAuditInTx`. Use `expect(mockLogAudit.mock.calls[0][0]).toMatchInlineSnapshot()`. The snapshot lives in the PR diff, persists across PRs, and breaks loudly on any future shape drift. Estimated cost: 4 snapshot blocks, ~20 LOC total.

Do NOT use `console.log` + revert: that pattern reliably leaks debug prints into production code.

## Considerations & constraints

### Out of scope

The following call sites are explicitly Bucket C and remain unchanged:

| File | Reason |
|------|--------|
| `src/auth.ts` (3 calls) | NextAuth event/jwt callbacks — no `NextRequest` in scope, uses `sessionMetaStorage.getStore()` |
| `src/lib/auth-adapter.ts` | NextAuth adapter — no `NextRequest` in scope |
| `src/lib/access-restriction.ts` | Library function called from multiple contexts including non-HTTP |
| `src/lib/account-lockout.ts` | Library function with optional `request?: NextRequest` — already conditionally uses `extractRequestMeta` when available |
| `src/lib/delegation.ts` | Library function called after HTTP response (post-revoke cleanup) |
| `src/lib/directory-sync/engine.ts` | Background sync engine (cron / polling) |
| `src/lib/extension-token.ts` | Library function for token validation |
| `src/lib/mcp/tools.ts` | MCP tool execution context — no NextRequest |
| `src/lib/notification.ts` | Notification emission library |
| `src/lib/team-policy.ts` | Policy library |
| `src/lib/webhook-dispatcher.ts` | Webhook delivery callback (async loop) |
| `src/lib/constants/audit.ts` | Constants file (one validation event) |
| `src/workers/audit-outbox-worker.ts` | Background worker process |
| `src/app/api/internal/audit-emit/route.ts` | TENANT-scope route where `tenantId` is not available at the call site without an extra DB lookup. `checkAuth` returns `userId` only; current code relies on `resolveTenantId()` for tenant resolution. Adding a User.findUnique purely for the helper would introduce an unreviewed extra DB roundtrip per call. Bucket C until a `tenantAuditBaseLazy(req, userId)` variant (which lets `resolveTenantId` continue to work) is introduced as a separate plan. |

The Bucket C list is FROZEN by this plan. Any addition to it during implementation must be recorded in the deviation log with a concrete reason that maps to one of the categories above (or explains why a new category is justified).

### Risks

- **Risk 1 (low)**: Variable name mismatch — source uses `request` but migration uses `req`. Mitigation: each file's migration must preserve the source variable name. Reviewer must spot-check.
- **Risk 2 (low)**: Helper accidentally drops `acceptLanguage` from a downstream consumer that reads it. Mitigation: confirmed via reading `buildOutboxPayload` that `acceptLanguage` is not part of `AuditOutboxPayload` — this risk is theoretical.
- **Risk 3 (very low)**: A test asserts the param-key order or includes `acceptLanguage`. Mitigation: existing test runs catch this immediately; revert the helper migration for the affected file if needed.
- **Risk 4 (medium)**: A Bucket B file actually has subtly different params that the helper doesn't capture (e.g., a custom `actorType: SYSTEM` overlay). Mitigation: keep the override fields explicit AFTER the helper spread (`...tenantAuditBase(req, ...), actorType: ACTOR_TYPE.SYSTEM`). Order matters — overrides go last.
- **Risk 5 (low — informational)**: At the migration boundary, `audit_logs.userAgent` for `MASTER_KEY_ROTATION` and `MCP_CLIENT_DCR_CLAIM` events transitions from null to populated (per Functional 2 EXCEPTION). The audit hash chain (verified via `/api/maintenance/audit-chain-verify`) links each event to the previous event's hash, NOT to its schema — so this is a hash-continuity event for the very first post-migration event of each action, NOT a chain break. Older events remain valid; newer events hash correctly going forward. No code mitigation required; documented for incident-response clarity.
- **Risk 6 (low — informational)**: User-Agent strings persisted by the helper-driven audit events are the same strings already captured for HUMAN-actor events across the system. They are not PII per se but may include browser version, OS version, and extension fingerprints. No new threat surface is introduced — the strings flow into `audit_logs.userAgent`, which is already tenant-scoped via RLS and not exposed outside the audit log read endpoints (which are tenant-admin gated). No mitigation required; documented for completeness.

### Per-call-site override checklist (Batches 2 and 5)

To prevent override-field omission, the per-call-site override fields are pre-listed below. Implementer copy-pastes the post-spread block.

**Batch 2:**
- `mcp/authorize/consent/route.ts:67` — overrides: `action`, `targetType`, `targetId`, `metadata`. NO `actorType` override (helper default HUMAN is correct).
- `mcp/authorize/consent/route.ts:152` — overrides: `action`, `targetType`, `targetId`, `metadata`. Per Functional 2 EXCEPTION, `userAgent` is added by helper (deliberate).
- `mcp/authorize/consent/route.ts:192` — overrides: `action`, `targetType`, `targetId`, `metadata`.
- `mcp/register/route.ts:174` — overrides: `action`, `targetType`, `targetId`, `metadata`.
- `extension/token/exchange/route.ts:154` (failure) — overrides: `action`, `tenantId` (already passed, helper covers via tenantAuditBase third arg), `metadata`.
- `extension/token/exchange/route.ts:176` (success) — overrides: `action`, `tenantId` (helper covers).

**Batch 5:**
- `scim/v2/Users/route.ts:220` — overrides: `action`, `targetType`, `targetId`, `metadata`.
- `scim/v2/Users/[id]/route.ts:103/182/241` — overrides: `action`, `targetType`, `targetId`, `metadata` per call.
- `scim/v2/Groups/[id]/route.ts:85/153` — overrides: `action`, `targetType`, `targetId`, `metadata` per call.
- `tenant/access-requests/route.ts:200` — overrides: `action`, `targetType`, `targetId`, `metadata`. Verify if any `actorType` override is needed (current code may set HUMAN explicitly — preserve as-is).

For all other batches, follow the same pattern: enumerate overrides per call site BEFORE writing the helper-spread call.

### Override ordering invariant

The helper spread MUST come FIRST; any explicit overrides come AFTER:

```ts
// CORRECT: helper sets defaults, explicit override wins
{ ...tenantAuditBase(req, userId, tenantId), actorType: ACTOR_TYPE.SYSTEM, action, targetId }

// WRONG: helper would overwrite the actorType override
{ actorType: ACTOR_TYPE.SYSTEM, ...tenantAuditBase(req, userId, tenantId), action, targetId }
```

Reviewer (and implementer) MUST verify this order on every migration.

### Anti-patterns to flag during implementation

If during implementation a helper needs to be modified or extended (new helper variant, new field), STOP and:
1. Add an entry to the deviation log explaining why.
2. Surface to the user before continuing.
This refactor is intended to use the helpers AS-IS. Any helper change is a scope expansion that requires explicit approval.

## User operation scenarios

These scenarios cover the affected endpoints and are used to mentally validate behavior preservation. They are NOT new test additions — they are existing user flows that must keep working.

1. **Tenant admin rotates master key** (`POST /api/admin/rotate-master-key`):
   - Audit event: `MASTER_KEY_ROTATE` with `actorType: SYSTEM`, `userId: SYSTEM_ACTOR_ID`, scope `TENANT`, `tenantId` set, `ip` from caller.
   - Migration target: Pattern 2 with explicit `actorType: SYSTEM` override.

2. **User exports their personal audit log** (`POST /api/audit-logs/export`):
   - Audit event: `AUDIT_LOG_EXPORT` with scope `PERSONAL`, `userId`, no `teamId`, `ip` + `userAgent` captured.
   - Migration target: Pattern 3 (conditional team-vs-personal) with `teamId === undefined`.

3. **Team admin exports team audit log** (`POST /api/audit-logs/export?teamId=…`):
   - Same as #2 but scope `TEAM`, `teamId` set.

4. **MCP client OAuth consent grant** (`POST /api/mcp/authorize/consent`):
   - Three sequential events: `MCP_AUTHORIZE_INIT` (PERSONAL on first call?), `MCP_CONSENT_GRANT` / `MCP_CONSENT_DENY` (PERSONAL), and a TENANT-scope summary event. Verify each call's scope post-migration matches pre-migration.

5. **Vault admin reset for tenant member** (`POST /api/vault/admin-reset`):
   - When the user belongs to a team: event scope `TEAM` with `teamId`. When tenant-only: scope `TENANT` with `tenantId`. Pattern 4.

6. **Delegation create** (`POST /api/vault/delegation`):
   - Two events emitted in `Promise.all`: `DELEGATION_CREATE` PERSONAL + `DELEGATION_CREATE` TENANT. Both with same `targetId` (the delegation session id). Pattern 5.

7. **Share link create** (`POST /api/share-links`) and **revoke** (`DELETE /api/share-links/[id]`):
   - Inside Prisma transaction: event scope conditional on whether the share is for a team password entry. Pattern 6.

8. **SCIM user provisioning** (`POST /api/scim/v2/Users`, `PATCH /api/scim/v2/Users/[id]`, `DELETE /api/scim/v2/Users/[id]`):
   - All events scope `TENANT`. The `userId` field is the SCIM-token-bound user, which already exists at the call site.

9. **Maintenance: purge audit logs** (`POST /api/maintenance/purge-audit-logs`):
   - Event with `actorType: SYSTEM`, `userId: SYSTEM_ACTOR_ID`, scope `TENANT`. Pattern 2.

10. **Internal audit emit** (`POST /api/internal/audit-emit`):
    - Internal helper endpoint. **MOVED to Bucket C** during plan review — `tenantId` is not available without an extra DB lookup; `resolveTenantId()` performs the lookup transparently. No migration applies.

## Implementation Checklist

Generated during Phase 2 Step 2-1 (impact analysis).

### Files to modify (23 source files)

**Batch 1 — Maintenance & admin (7 files)**
- [ ] `src/app/api/admin/rotate-master-key/route.ts` — Pattern 2 (system actor), userAgent ADDED per Functional 2 EXCEPTION
- [ ] `src/app/api/maintenance/audit-chain-verify/route.ts` — Pattern 2
- [ ] `src/app/api/maintenance/audit-outbox-metrics/route.ts` — Pattern 2
- [ ] `src/app/api/maintenance/audit-outbox-purge-failed/route.ts` — Pattern 2
- [ ] `src/app/api/maintenance/dcr-cleanup/route.ts` — Pattern 2
- [ ] `src/app/api/maintenance/purge-audit-logs/route.ts` — Pattern 2
- [ ] `src/app/api/maintenance/purge-history/route.ts` — Pattern 2

**Batch 2 — MCP & extension (3 files; `internal/audit-emit/route.ts` excluded → Bucket C)**
- [ ] `src/app/api/mcp/authorize/consent/route.ts` — Pattern 2 (3 calls; line 152 userAgent ADDED per EXCEPTION)
- [ ] `src/app/api/mcp/register/route.ts` — Pattern 2
- [ ] `src/app/api/extension/token/exchange/route.ts` — Pattern 1 (2 calls)

**Batch 3 — Audit-log meta + watchtower (3 files)**
- [ ] `src/app/api/audit-logs/export/route.ts` — Pattern 3 (conditional team/personal)
- [ ] `src/app/api/audit-logs/import/route.ts` — Pattern 3
- [ ] `src/app/api/watchtower/alert/route.ts` — Pattern 3

**Batch 4 — Vault + share-links (6 files)**
- [ ] `src/app/api/vault/admin-reset/route.ts` — Pattern 4 (conditional team/tenant)
- [ ] `src/app/api/vault/delegation/route.ts` — Pattern 5 (dual-emit; `tenantId` MUST be preserved on PERSONAL emit)
- [ ] `src/app/api/vault/delegation/check/route.ts` — Pattern 7 (extractClientIp direct)
- [ ] `src/app/api/share-links/route.ts` — Pattern 6 (logAuditInTx; delete pre-tx extractRequestMeta)
- [ ] `src/app/api/share-links/[id]/route.ts` — Pattern 6 + Pattern 3 (logAuditInTx + conditional team/personal)
- [ ] `src/app/api/share-links/verify-access/route.ts` — Pattern 1 (2 calls)

**Batch 5 — SCIM + access-requests (4 files)**
- [ ] `src/app/api/scim/v2/Users/route.ts` — Pattern 1
- [ ] `src/app/api/scim/v2/Users/[id]/route.ts` — Pattern 1 (3 calls)
- [ ] `src/app/api/scim/v2/Groups/[id]/route.ts` — Pattern 1 (2 calls)
- [ ] `src/app/api/tenant/access-requests/route.ts` — Pattern 1

**Batch 6 — Documentation update (after Batches 1-5)**
- [ ] `src/lib/audit.ts` module-doc — mandate helper usage; document Bucket C exceptions

### Shared utilities to reuse (NEVER reimplement)

- `personalAuditBase(req, userId)` from `@/lib/audit` — PERSONAL scope helper
- `teamAuditBase(req, userId, teamId)` from `@/lib/audit` — TEAM scope helper
- `tenantAuditBase(req, userId, tenantId)` from `@/lib/audit` — TENANT scope helper

### Imports to remove per file (if no remaining usage)

After migration of each file, remove the following imports IF and only IF no other code in the file uses them:
- `extractRequestMeta` from `@/lib/audit`
- `extractClientIp` from `@/lib/ip-access`
- `AUDIT_SCOPE` from `@/lib/constants`

CI's zero-warning lint will catch unused imports automatically.

### Verification gate (after every batch)

1. `npx eslint .` — zero warnings
2. `npx vitest run` — all tests pass
3. `npx next build` — production build succeeds
4. `npm run test:integration` — priority tests: `audit-and-isolation.test.ts`, `audit-logaudit-non-atomic.integration.test.ts`
