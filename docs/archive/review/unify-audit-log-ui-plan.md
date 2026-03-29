# Plan: Unify Audit Log UI

## Context

The audit log UI has three independent implementations (personal: 767 lines, team: 691 lines, tenant: 580 lines) with ~60-70% code duplication. Filter logic, action selection, download handling, pagination, and UI layout are nearly identical across all three. This makes maintenance error-prone — changes must be applied in three places. This refactoring extracts shared logic into hooks and components, reducing each page to ~100 lines of configuration.

## Objective

Extract shared audit log logic and UI into reusable hooks and components. Each page becomes a thin wrapper providing only its unique configuration (API endpoints, encryption, action groups, per-item rendering).

## Architecture: Three Layers

### Layer 1: Shared Hook — `src/hooks/use-audit-logs.ts`

A single custom hook encapsulating all common state and logic:
- State: logs, loading, loadingMore, nextCursor, entryNames, downloading, selectedActions, actionSearch, dateFrom, dateTo, filterOpen, actorTypeFilter
- Fetch logic: `fetchLogs(cursor?)` with URLSearchParams from common filters + caller's extra params
- Pagination: `handleLoadMore()`
- Download: `handleDownload(format)` using `downloadBlob`
- Filter helpers: `actionLabel`, `filteredActions`, `toggleAction`, `setGroupSelection`, `clearActions`, `actionSummary`

Configuration via props:
```typescript
interface UseAuditLogsConfig {
  fetchEndpoint: string;
  downloadEndpoint: string;
  downloadFilename: "audit-logs" | "team-audit-logs" | "tenant-audit-logs";
  actionGroups: ActionGroupDef[];
  buildExtraParams?: () => URLSearchParams;
  resolveEntryNames?: (data: any) => Promise<Map<string, string>>;
  // Called on BOTH initial fetch AND handleLoadMore (for accumulating relatedUsers etc.)
  onDataReceived?: (data: any) => void;
}
```

### Layer 2: Shared UI Components — `src/components/audit/`

| Component | Purpose | ~Lines |
|-----------|---------|--------|
| `audit-action-filter.tsx` | Collapsible action checkbox tree with search | ~70 |
| `audit-date-filter.tsx` | Date from/to inputs | ~30 |
| `audit-download-button.tsx` | Download dropdown (CSV/JSONL) with optional disabled tooltip | ~50 |
| `audit-log-list.tsx` | Loading/empty states + card wrapper + load-more | ~50 |
| `audit-log-item-row.tsx` | Shared row layout (icon, content, timestamp, IP slots) | ~30 |
| `audit-actor-type-badge.tsx` | Actor type badge (hidden for HUMAN) | ~15 |

### Layer 3: Page-Specific Glue (~100 lines each)

Each page provides:
- Hook configuration (endpoints, action groups, encryption callbacks)
- `renderItem` function composing `AuditLogItemRow` with page-specific content
- Page-specific state (e.g., team's `exportAllowed`, tenant's scope/team filters)

## Shared Utility Extractions

### `src/lib/audit-action-label.ts` (new)
Extract `getActionLabel()` as a function accepting `t: (key: string) => string` and `action: string`. Returns translated label. Used by personal + team. NOT a React hook — takes `t` as parameter so it can be called from any context.

### `src/lib/audit-target-label.ts` (new)
Extract common `getTargetLabel()` cases shared by personal and team:
- Bulk trash/empty/archive/unarchive/restore metadata
- Import/export metadata
- Entry name resolution (with targetType parameter: `PASSWORD_ENTRY` vs `TEAM_PASSWORD_ENTRY`)
- Attachment filename
- Role change

Each page adds its own cases on top (personal: auth provider, vault lockout, delegation, session revoke, vault reset, emergency; team: member invite/remove email).

## Implementation Steps

### Phase 1: Extract pure utilities (no UI changes)
1. Create `src/lib/audit-action-label.ts` — extract `getActionLabel()`
2. Create `src/lib/audit-target-label.ts` — extract shared `getCommonTargetLabel()`

### Phase 2: Extract the hook
3. Create `src/hooks/use-audit-logs.ts` — the core shared hook

### Phase 3: Extract UI components
4. Create `src/components/audit/audit-action-filter.tsx`
5. Create `src/components/audit/audit-date-filter.tsx`
6. Create `src/components/audit/audit-download-button.tsx`
7. Create `src/components/audit/audit-log-list.tsx`
8. Create `src/components/audit/audit-log-item-row.tsx`
9. Create `src/components/audit/audit-actor-type-badge.tsx`

### Phase 4: Migrate pages (one at a time, verify each)
10. Migrate personal audit log page — verify no visual/behavioral changes
11. Migrate team audit log page — verify including export policy and avatar
12. Migrate tenant audit log card — verify including scope filter, team filter, Break-Glass tab
    - **Important**: Scope change handler must call `clearActions()` to reset selected actions (mirrors current behavior at lines 299-303)

### Phase 5: Update existing tests
13. Rewrite `src/__tests__/ui/audit-log-target-labels.test.ts` — currently reads page source with `readFileSync`; must be updated to test `getCommonTargetLabel()` directly or check the new file locations
14. Rewrite `src/__tests__/ui/audit-log-action-groups.test.ts` — update file paths and assertions for new shared code locations
15. Add `data-testid` attributes to shared components (`audit-log-list`, `audit-log-row`) and update E2E page objects (`e2e/page-objects/audit-logs.page.ts`) to use them instead of Tailwind class selectors

### Phase 6: Add new tests and verify
16. Create `src/hooks/use-audit-logs.test.ts` — test URL param building, cursor management, filter state reset, `onDataReceived` called on both initial and loadMore
17. Remove dead code from original files
18. Run `npx vitest run` and `npx next build`

## Key Design Decisions

- **ACTION_ICONS stay page-local**: They are static JSX maps, not logic. Extracting them adds import overhead without reducing complexity.
- **Tenant download uses `downloadBlob`**: Currently manually creates anchor element. Unify to use the shared utility.
- **Entry names normalized to `Map<string, string>`**: Personal already uses Map. Team's Record is converted in the `resolveEntryNames` callback.
- **Team's `exportAllowed` stays page-local**: It's an independent async check, not part of the audit log fetching lifecycle.
- **Tenant's Break-Glass tab stays in the tenant component**: It's unrelated to audit log shared logic.
- **`groupLabelResolver` prop on `AuditActionFilter`**: Tenant uses `GROUP_LABEL_MAP` for dynamic group labels, personal/team use static `group.label` keys. The filter component accepts an optional resolver function.

## Testing Strategy

- **Existing tests to update**: `audit-log-target-labels.test.ts` and `audit-log-action-groups.test.ts` read source files with `readFileSync` and will break after refactoring — must be rewritten to test new file locations or import functions directly
- **E2E selectors**: Add `data-testid` to shared components; update `e2e/page-objects/audit-logs.page.ts` selectors from Tailwind classes to `data-testid`
- **New hook test**: `src/hooks/use-audit-logs.test.ts` — test param building, pagination, filter reset, and that `onDataReceived` is called on both initial fetch and loadMore
- Verify by running `npx vitest run` and `npx next build`
- Manual verification: all three views should render identically before and after

## Expected Impact

| File | Before | After |
|------|--------|-------|
| Personal page | 767 | ~90 |
| Team page | 691 | ~100 |
| Tenant card | 580 | ~110 |
| New shared code | 0 | ~525 |
| **Total** | **2,038** | **~825** |

~60% code reduction, with each page dropping from 600-767 lines to ~100 lines of configuration.

## Files to Modify

### New files
- `src/hooks/use-audit-logs.ts`
- `src/lib/audit-action-label.ts`
- `src/lib/audit-target-label.ts`
- `src/components/audit/audit-action-filter.tsx`
- `src/components/audit/audit-date-filter.tsx`
- `src/components/audit/audit-download-button.tsx`
- `src/components/audit/audit-log-list.tsx`
- `src/components/audit/audit-log-item-row.tsx`
- `src/components/audit/audit-actor-type-badge.tsx`

### New test files
- `src/hooks/use-audit-logs.test.ts`

### Modified files
- `src/app/[locale]/dashboard/audit-logs/page.tsx` (rewrite to use shared components)
- `src/app/[locale]/dashboard/teams/[teamId]/audit-logs/page.tsx` (rewrite to use shared components)
- `src/components/settings/tenant-audit-log-card.tsx` (rewrite to use shared components)
- `src/__tests__/ui/audit-log-target-labels.test.ts` (rewrite for new file locations)
- `src/__tests__/ui/audit-log-action-groups.test.ts` (rewrite for new file locations)
- `e2e/page-objects/audit-logs.page.ts` (update selectors to data-testid)

### Existing shared code to reuse
- `src/components/audit/delegation-audit-detail.tsx` — kept as-is
- `src/lib/download-blob.ts` — used by hook's `handleDownload`
- `src/lib/format-user.ts` — used by personal page
- `src/lib/audit-action-key.ts` — used by hook's `actionLabel`
- `src/lib/format-datetime.ts` — used by row component
- `src/lib/constants/audit.ts` — action groups, action values

## Considerations & Constraints

- No behavioral or visual changes to any of the three views
- Tenant component must remain embeddable (Card, not full page)
- Encryption logic must not leak into shared code — kept in page-level callbacks
- i18n keys unchanged (same "AuditLog" and "AuditDownload" namespaces)

## User Operation Scenarios

1. **Personal audit log**: User navigates to /dashboard/audit-logs, sees their logs with action icons, can filter by actor type (HUMAN/MCP_AGENT), date range, and action groups. Can download CSV/JSONL. Emergency access entries show detailed metadata. Delegated decryption entries show tool-specific detail.

2. **Team audit log**: User navigates to /dashboard/teams/{id}/audit-logs, sees team logs with user avatars and "Operated by" lines. Action groups include ADMIN but exclude AUTH/EMERGENCY/DELEGATION. Download may be disabled by team policy. Entry names are decrypted via team key.

3. **Tenant audit log**: Admin views tenant settings, sees audit logs in a tabbed card (Logs + Break-Glass). Can filter by scope (TENANT/TEAM/ALL), specific team, actor type (includes SERVICE_ACCOUNT), date range, and dynamic action groups. Scope and actor type badges shown per row.
