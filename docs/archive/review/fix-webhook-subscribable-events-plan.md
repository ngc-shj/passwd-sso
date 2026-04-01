# Plan: fix-webhook-subscribable-events

## Objective

Fix incorrect webhook subscribable event definitions for both tenant and team webhooks. The current code conflates "audit log display groups" (`AUDIT_ACTION_GROUPS_TEAM/TENANT`) with "webhook subscribable events", causing two categories of bugs:

1. Events are dispatched but cannot be subscribed to (dead dispatch calls)
2. Events can be subscribed to but are never dispatched (phantom events in UI)

## Requirements

### Functional Requirements

1. **Tenant webhooks**: All events dispatched via `dispatchTenantWebhook()` must be subscribable
2. **Team webhooks**: Only events that are actually dispatched via `dispatchWebhook()` should be subscribable. Tenant-scoped events (SCIM, master key rotation, etc.) must NOT appear in team webhook subscriptions
3. **No self-referential subscriptions**: Webhook lifecycle events (create/delete/delivery_failed) must remain excluded from their own webhook type
4. **Privacy exclusions preserved**: `PERSONAL_LOG_ACCESS_VIEW` and `PERSONAL_LOG_ACCESS_EXPIRE` remain excluded from tenant webhook subscriptions (timing data privacy)

### Non-Functional Requirements

1. Audit log UI groups (`AUDIT_ACTION_GROUPS_TEAM/TENANT`) must NOT be modified — they serve a different purpose (audit log display)
2. Existing webhook subscriptions in the database must remain valid after this change (no breaking migration)
3. i18n labels must exist for all new webhook event groups
4. API validation (Zod schemas) must match the subscribable actions exactly
5. UI must display exactly what the API accepts

## Technical Approach

### Root Cause

`AUDIT_ACTION_GROUPS_TEAM` and `AUDIT_ACTION_GROUPS_TENANT` are designed for **audit log UI grouping** — they show all events visible in a given scope's audit log. `TEAM_WEBHOOK_SUBSCRIBABLE_ACTIONS` blindly flattens `AUDIT_ACTION_GROUPS_TEAM`, and `TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS` cherry-picks from `AUDIT_ACTION_GROUPS_TENANT` but was not updated when service account, MCP client, and delegation features were added.

### Solution

Introduce dedicated webhook event group constants that are independent of the audit log groups:

- `TENANT_WEBHOOK_EVENT_GROUPS`: Explicit groups for tenant webhook UI, containing only tenant-scoped events that are actually dispatched
- `TEAM_WEBHOOK_EVENT_GROUPS`: Explicit groups for team webhook UI, containing only team-scoped events that are actually dispatched

Derive `TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS` and `TEAM_WEBHOOK_SUBSCRIBABLE_ACTIONS` from these new groups (not from `AUDIT_ACTION_GROUPS_*`).

### Design Decision: Not adding missing dispatch calls

This plan focuses only on fixing the subscribable event definitions. Adding `dispatchWebhook()` calls to the ~44 team API endpoints that lack them is a separate, larger task. For team webhooks, we restrict the subscribable list to what is currently dispatched (entry CRUD only).

## Implementation Steps

### Step 1: Add `TENANT_WEBHOOK_EVENT_GROUPS` to `src/lib/constants/audit.ts`

Replace the flat `TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS` array with an explicit grouped constant:

```typescript
/**
 * Event groups subscribable via tenant webhooks.
 * Separate from AUDIT_ACTION_GROUPS_TENANT (which is for audit log UI).
 * Only includes events that have actual dispatchTenantWebhook() calls.
 *
 * Intentionally excluded:
 * - TENANT_WEBHOOK group (prevents self-referential loops)
 * - PERSONAL_LOG_ACCESS_VIEW/EXPIRE (privacy-sensitive timing data)
 * - MCP_CLIENT group (no dispatch calls yet)
 * - DELEGATION group (no dispatch calls yet)
 * - HISTORY_PURGE (no dispatch call yet — add here when implemented)
 */
export const TENANT_WEBHOOK_EVENT_GROUPS: Record<string, AuditAction[]> = {
  [AUDIT_ACTION_GROUP.ADMIN]: [
    AUDIT_ACTION.ADMIN_VAULT_RESET_INITIATE,
    AUDIT_ACTION.ADMIN_VAULT_RESET_EXECUTE,
    AUDIT_ACTION.ADMIN_VAULT_RESET_REVOKE,
    AUDIT_ACTION.TENANT_ROLE_UPDATE,
    // HISTORY_PURGE omitted — no dispatchTenantWebhook call exists yet
  ],
  [AUDIT_ACTION_GROUP.SCIM]: [
    AUDIT_ACTION.SCIM_TOKEN_CREATE,
    AUDIT_ACTION.SCIM_TOKEN_REVOKE,
    AUDIT_ACTION.SCIM_USER_CREATE,
    AUDIT_ACTION.SCIM_USER_UPDATE,
    AUDIT_ACTION.SCIM_USER_DEACTIVATE,
    AUDIT_ACTION.SCIM_USER_REACTIVATE,
    AUDIT_ACTION.SCIM_USER_DELETE,
    AUDIT_ACTION.SCIM_GROUP_UPDATE,
  ],
  [AUDIT_ACTION_GROUP.DIRECTORY_SYNC]: [
    AUDIT_ACTION.DIRECTORY_SYNC_CONFIG_CREATE,
    AUDIT_ACTION.DIRECTORY_SYNC_CONFIG_UPDATE,
    AUDIT_ACTION.DIRECTORY_SYNC_CONFIG_DELETE,
    AUDIT_ACTION.DIRECTORY_SYNC_RUN,
    AUDIT_ACTION.DIRECTORY_SYNC_STALE_RESET,
  ],
  [AUDIT_ACTION_GROUP.BREAKGLASS]: [
    AUDIT_ACTION.PERSONAL_LOG_ACCESS_REQUEST,
    AUDIT_ACTION.PERSONAL_LOG_ACCESS_REVOKE,
    // VIEW and EXPIRE excluded (privacy-sensitive timing data)
  ],
  [AUDIT_ACTION_GROUP.SERVICE_ACCOUNT]: [
    AUDIT_ACTION.SERVICE_ACCOUNT_CREATE,
    AUDIT_ACTION.SERVICE_ACCOUNT_UPDATE,
    AUDIT_ACTION.SERVICE_ACCOUNT_DELETE,
    AUDIT_ACTION.SERVICE_ACCOUNT_TOKEN_CREATE,
    AUDIT_ACTION.SERVICE_ACCOUNT_TOKEN_REVOKE,
    AUDIT_ACTION.ACCESS_REQUEST_CREATE,
    AUDIT_ACTION.ACCESS_REQUEST_APPROVE,
    AUDIT_ACTION.ACCESS_REQUEST_DENY,
  ],
};
```

Derive `TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS` from this:
```typescript
export const TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS = Object.values(
  TENANT_WEBHOOK_EVENT_GROUPS,
).flat() as unknown as readonly AuditAction[];
```

### Step 2: Add `TEAM_WEBHOOK_EVENT_GROUPS` to `src/lib/constants/audit.ts`

Create a minimal group for team webhooks matching what is currently dispatched:

```typescript
/**
 * Event groups subscribable via team webhooks.
 * Separate from AUDIT_ACTION_GROUPS_TEAM (which is for audit log UI).
 * Only includes events that have actual dispatchWebhook() calls.
 *
 * Currently dispatched: ENTRY_CREATE, ENTRY_UPDATE, ENTRY_DELETE
 * (from teams/[teamId]/passwords/ route handlers).
 *
 * Note: ENTRY_DELETE is the action dispatched by the DELETE handler.
 * This differs from the audit log groups which use ENTRY_TRASH and
 * ENTRY_PERMANENT_DELETE for the same operations.
 */
export const TEAM_WEBHOOK_EVENT_GROUPS: Record<string, AuditAction[]> = {
  [AUDIT_ACTION_GROUP.ENTRY]: [
    AUDIT_ACTION.ENTRY_CREATE,
    AUDIT_ACTION.ENTRY_UPDATE,
    AUDIT_ACTION.ENTRY_DELETE,
  ],
};
```

Update `TEAM_WEBHOOK_SUBSCRIBABLE_ACTIONS`:
```typescript
export const TEAM_WEBHOOK_SUBSCRIBABLE_ACTIONS = Object.values(
  TEAM_WEBHOOK_EVENT_GROUPS,
).flat() as unknown as readonly AuditAction[];
```

### Step 3: Update `src/components/settings/tenant-webhook-card.tsx`

- Import `TENANT_WEBHOOK_EVENT_GROUPS` instead of `AUDIT_ACTION_GROUPS_TENANT` + `TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS`
- Build `EVENT_GROUPS` directly from `TENANT_WEBHOOK_EVENT_GROUPS` (no filtering needed since exclusions are by construction)
- Complete `GROUP_LABEL_MAP` (full final state):

```typescript
const GROUP_LABEL_MAP: Record<string, string> = {
  [AUDIT_ACTION_GROUP.ADMIN]: "groupAdmin",
  [AUDIT_ACTION_GROUP.SCIM]: "groupScim",
  [AUDIT_ACTION_GROUP.DIRECTORY_SYNC]: "groupDirectorySync",
  [AUDIT_ACTION_GROUP.BREAKGLASS]: "groupBreakglass",
  [AUDIT_ACTION_GROUP.SERVICE_ACCOUNT]: "groupServiceAccount",
};
```

### Step 4: Update `src/components/team/team-webhook-card.tsx`

- Import `TEAM_WEBHOOK_EVENT_GROUPS` instead of `AUDIT_ACTION_GROUPS_TEAM`
- Build `EVENT_GROUPS` directly from `TEAM_WEBHOOK_EVENT_GROUPS` (no filtering needed)
- Simplify `GROUP_LABEL_MAP` to only include `groupEntry`:

```typescript
const GROUP_LABEL_MAP: Record<string, string> = {
  [AUDIT_ACTION_GROUP.ENTRY]: "groupEntry",
};
```

### Step 5: Add `justification`/`requestedScope` to `WEBHOOK_METADATA_BLOCKLIST`

In `src/lib/webhook-dispatcher.ts`, add defense-in-depth entries for SERVICE_ACCOUNT event payloads:

```typescript
export const WEBHOOK_METADATA_BLOCKLIST = new Set([
  ...METADATA_BLOCKLIST,
  "email",
  "targetUserEmail",
  "reason",
  "incidentRef",
  "displayName",
  "justification",     // access request free-text (may contain sensitive incident references)
  "requestedScope",    // access request scope (internal authorization detail)
]);
```

### Step 6: Update tests

#### `src/lib/constants/audit.test.ts`

Add concrete test cases:

```typescript
it("has TENANT_WEBHOOK_EVENT_GROUPS with expected group keys", () => {
  const keys = Object.keys(TENANT_WEBHOOK_EVENT_GROUPS);
  expect(keys).toEqual([
    AUDIT_ACTION_GROUP.ADMIN,
    AUDIT_ACTION_GROUP.SCIM,
    AUDIT_ACTION_GROUP.DIRECTORY_SYNC,
    AUDIT_ACTION_GROUP.BREAKGLASS,
    AUDIT_ACTION_GROUP.SERVICE_ACCOUNT,
  ]);
});

it("excludes TENANT_WEBHOOK/MCP_CLIENT/DELEGATION from tenant webhook event groups", () => {
  const keys = new Set(Object.keys(TENANT_WEBHOOK_EVENT_GROUPS));
  expect(keys.has(AUDIT_ACTION_GROUP.TENANT_WEBHOOK)).toBe(false);
  expect(keys.has(AUDIT_ACTION_GROUP.MCP_CLIENT)).toBe(false);
  expect(keys.has(AUDIT_ACTION_GROUP.DELEGATION)).toBe(false);
});

it("has TEAM_WEBHOOK_EVENT_GROUPS with only ENTRY group", () => {
  expect(Object.keys(TEAM_WEBHOOK_EVENT_GROUPS)).toEqual([
    AUDIT_ACTION_GROUP.ENTRY,
  ]);
  expect(TEAM_WEBHOOK_EVENT_GROUPS[AUDIT_ACTION_GROUP.ENTRY]).toEqual([
    AUDIT_ACTION.ENTRY_CREATE,
    AUDIT_ACTION.ENTRY_UPDATE,
    AUDIT_ACTION.ENTRY_DELETE,
  ]);
});

it("derives SUBSCRIBABLE_ACTIONS from EVENT_GROUPS", () => {
  expect([...TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS]).toEqual(
    Object.values(TENANT_WEBHOOK_EVENT_GROUPS).flat(),
  );
  expect([...TEAM_WEBHOOK_SUBSCRIBABLE_ACTIONS]).toEqual(
    Object.values(TEAM_WEBHOOK_EVENT_GROUPS).flat(),
  );
});
```

#### `src/components/settings/tenant-webhook-card.test.tsx`

- Update test name to include SERVICE_ACCOUNT: "includes ADMIN/SCIM/DIRECTORY_SYNC/BREAKGLASS/SERVICE_ACCOUNT events"
- Add assertions for `SERVICE_ACCOUNT_CREATE`, `SERVICE_ACCOUNT_TOKEN_CREATE`, `ACCESS_REQUEST_CREATE`, `ACCESS_REQUEST_APPROVE`
- Verify `HISTORY_PURGE` is NOT in the document (removed from subscribable list)

#### `src/components/team/team-webhook-card.test.tsx`

- Update expected events from `ENTRY_TRASH/PERMANENT_DELETE/RESTORE` to `ENTRY_CREATE/UPDATE/DELETE`
- Add negative assertions: `queryByText("ENTRY_TRASH")`, `queryByText("ENTRY_PERMANENT_DELETE")`, `queryByText("ENTRY_RESTORE")` should NOT be in the document
- Remove expectations for SCIM, Admin, and other non-dispatched groups
- Update test name from "excludes group:webhook" to "does not include group:webhook actions"

### Step 7: Verify existing database compatibility

Existing webhooks in the database may have events from the old (wider) subscribable list. The webhook dispatcher matches via `events: { has: event.type }` — webhooks with old events that are no longer subscribable will simply never match (harmless). No migration needed. The GET endpoint returns stored events as-is; the POST endpoint validates new subscriptions against the updated list.

## Testing Strategy

1. **Unit tests**: Verify `TENANT_WEBHOOK_EVENT_GROUPS` and `TEAM_WEBHOOK_EVENT_GROUPS` contain exactly the intended events, with explicit exclusion checks
2. **Derivation consistency**: Verify `*_SUBSCRIBABLE_ACTIONS` equals the flat of `*_EVENT_GROUPS`
3. **Component tests**: Verify UI renders correct event groups for both tenant and team webhook cards, including SERVICE_ACCOUNT group
4. **Build check**: `npx next build` must pass (catches type errors in non-test code)

## Considerations & Constraints

1. **HISTORY_PURGE**: Removed from `TENANT_WEBHOOK_EVENT_GROUPS` because no `dispatchTenantWebhook()` call exists in `/api/maintenance/purge-history`. Consistent with MCP_CLIENT/DELEGATION treatment. Add when dispatch is implemented.
2. **MCP_CLIENT and DELEGATION events**: No `dispatchTenantWebhook` calls exist for these groups. Excluded from subscribable list until dispatch calls are added.
3. **Team webhook sparse dispatch**: Only 3 events are dispatched (`ENTRY_CREATE/UPDATE/DELETE`). This plan restricts team subscriptions to match reality.
4. **Backward compatibility**: Old webhooks with now-unsubscribable events remain in the DB but are inert. They were never firing anyway (the dispatcher filters by `has: event.type`).
5. **ENTRY_DELETE vs ENTRY_TRASH**: The `dispatchWebhook()` in the team passwords DELETE handler uses `ENTRY_DELETE`, not `ENTRY_TRASH` or `ENTRY_PERMANENT_DELETE` (which are audit-log-only actions). The webhook event group uses the actually dispatched action name.

## User Operation Scenarios

### Scenario 1: Tenant admin creates a service account webhook
1. Admin navigates to Tenant Settings > Webhooks
2. Clicks "Add webhook", enters URL
3. **Before fix**: Service Account group not visible → cannot subscribe to SA events despite them being dispatched
4. **After fix**: Service Account group visible → admin can subscribe to `SERVICE_ACCOUNT_CREATE`, `SERVICE_ACCOUNT_TOKEN_CREATE`, etc.

### Scenario 2: Team admin sees only actionable events
1. Team admin navigates to Team Settings > Webhooks
2. Clicks "Add webhook"
3. **Before fix**: Sees SCIM, Admin (master key rotation), History, etc. — events that never fire for team webhooks
4. **After fix**: Sees only Entry group (create/update/delete) — all of which actually fire

### Scenario 3: Existing webhook with stale events
1. Team has a webhook subscribed to `SCIM_USER_CREATE` (previously allowed)
2. **After fix**: Webhook remains in DB, GET endpoint returns it with old events. Creating new webhooks no longer allows SCIM events. Old webhook never fires (was never firing anyway)

## Files to Modify

| File | Change |
|------|--------|
| `src/lib/constants/audit.ts` | Add `TENANT_WEBHOOK_EVENT_GROUPS`, `TEAM_WEBHOOK_EVENT_GROUPS`; rewrite `*_SUBSCRIBABLE_ACTIONS` |
| `src/components/settings/tenant-webhook-card.tsx` | Use `TENANT_WEBHOOK_EVENT_GROUPS`; update `GROUP_LABEL_MAP` |
| `src/components/team/team-webhook-card.tsx` | Use `TEAM_WEBHOOK_EVENT_GROUPS`; simplify `GROUP_LABEL_MAP` |
| `src/lib/webhook-dispatcher.ts` | Add `justification`/`requestedScope` to `WEBHOOK_METADATA_BLOCKLIST` |
| `src/lib/constants/audit.test.ts` | Add tests for new `*_WEBHOOK_EVENT_GROUPS` constants |
| `src/components/settings/tenant-webhook-card.test.tsx` | Update expected events (add SERVICE_ACCOUNT) |
| `src/components/team/team-webhook-card.test.tsx` | Update expected events (ENTRY_CREATE/UPDATE/DELETE only) |
