# Plan: webhook-card-shared-component

## Objective

Extract a shared `BaseWebhookCard` component from `TenantWebhookCard` (425 lines) and `TeamWebhookCard` (427 lines) to eliminate ~95% code duplication. Both components share identical UI structure, state management, form validation, and rendering logic. Only API endpoints, event group constants, group label maps, and i18n namespace differ.

## Requirements

### Functional
- Extract all shared logic (state, handlers, JSX) into `BaseWebhookCard`
- Reduce `TenantWebhookCard` and `TeamWebhookCard` to thin config wrappers (~20-30 lines each)
- Preserve all existing behavior: create, delete, URL validation, event toggle, secret display, inactive section, limit warning, auto-expand
- Keep external component props and API unchanged (`TenantWebhookCard` takes no props; `TeamWebhookCard` takes `{ teamId, locale }`)
- Keep i18n namespaces separate (`TenantWebhook` / `TeamWebhook`)

### Non-functional
- Reduce total code from ~850 lines to ~450 lines (base ~400 + 2 wrappers ~25 each)
- All existing tests must pass
- Production build must succeed

## Technical Approach

### BaseWebhookCard Config Interface

```typescript
interface WebhookCardConfig {
  listEndpoint: string;
  createEndpoint: string;
  deleteEndpoint: (webhookId: string) => string;
  eventGroups: Array<{ key: string; actions: string[] }>;
  groupLabelMap: Record<string, string>;  // maps group key -> i18n key
  i18nNamespace: string;
  locale: string;
  fetchDeps?: unknown[];  // extra useCallback deps (e.g., [teamId])
}
```

### Key Design Decisions

1. **Config object pattern** (not render-props or HOC): The differences are purely data/config, not behavior or UI structure. A config object is the simplest approach.

2. **Stale closure prevention**: `BaseWebhookCard` destructures `config` at the top level and uses individual primitive values (`listEndpoint`, `createEndpoint`, `locale`) directly in hook dependency arrays. The `deleteEndpoint` function is stored in a `useRef` and updated each render to avoid stale closures without triggering unnecessary re-renders. `fetchWebhooks` depends on `[listEndpoint, ...fetchDeps]` only.

3. **i18n namespace via `useTranslations(config.i18nNamespace)`**: Since both namespaces share identical keys (title, description, addWebhook, url, etc.), the base component can call `useTranslations()` with the namespace from config.

4. **groupLabelMap as `Record<string, string>`**: Maps `AUDIT_ACTION_GROUP.*` keys to i18n keys (`groupAdmin`, `groupScim`, etc.). The base component calls `tAudit(map[key] ?? key)`. Fallback to `key` is intentional for forward compatibility.

5. **Event group building stays in wrappers**: Each wrapper computes its own `eventGroups` array using its own constants and filtering logic (tenant filters by `TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS` set; team excludes `WEBHOOK` group). This keeps domain-specific filtering out of the base.

6. **`renderWebhookItem` stays as internal closure**: Defined inside `BaseWebhookCard` function body (not extracted as a separate component) to retain access to `t`, `tCommon`, `tAudit`, `handleDelete`, and `locale` without prop drilling.

7. **File location**: `src/components/settings/base-webhook-card.tsx` — co-located with tenant wrapper. Team wrapper remains in `src/components/team/`.

### Shared Test Factory

Create `src/components/__tests__/webhook-card-test-factory.tsx` that exports:
- Shared mock setup (all `vi.mock` calls for UI components)
- `WebhookItem` sample data factory
- `setupFetchWebhooks()` helper
- `createWebhookCardTests(renderComponent, options)` — generates all common test cases

Each test file becomes: import factory + add variant-specific tests (event group exclusion tests).

## Implementation Steps

1. **Create `src/components/settings/base-webhook-card.tsx`**
   - Define `WebhookCardConfig` interface and export `WebhookItem` interface
   - Move all shared state, handlers, `renderWebhookItem`, and JSX from `tenant-webhook-card.tsx`
   - Accept `config: WebhookCardConfig` as prop
   - Use `useTranslations(config.i18nNamespace)` for component-specific translations
   - Use `config.groupLabelMap` in `groupLabel()` function
   - Destructure config at top level; use individual values in hook deps
   - Store `deleteEndpoint` in `useRef` to avoid stale closures
   - `renderWebhookItem` as internal closure (not separate component)

2. **Rewrite `src/components/settings/tenant-webhook-card.tsx` as thin wrapper**
   - Import `BaseWebhookCard` and config constants
   - Call `useLocale()` to get locale (currently done in this file) and pass via config
   - Compute `EVENT_GROUPS` using existing tenant filtering logic (stays at module level)
   - Define `TENANT_GROUP_LABEL_MAP` constant
   - Pass endpoints via existing `apiPath.tenantWebhooks()` / `apiPath.tenantWebhookById()` helpers (no hardcoded URLs)
   - Render `<BaseWebhookCard config={...} />`

3. **Rewrite `src/components/team/team-webhook-card.tsx` as thin wrapper**
   - Import `BaseWebhookCard` and config constants
   - Receive `locale` from props (as currently done)
   - Compute `EVENT_GROUPS` using existing team filtering logic (stays at module level)
   - Define `TEAM_GROUP_LABEL_MAP` constant
   - Pass endpoints via existing `apiPath.teamWebhooks(teamId)` / `apiPath.teamWebhookById(teamId, id)` helpers
   - Render `<BaseWebhookCard config={...} />` with `fetchDeps: [teamId]`

4. **Create `src/components/__tests__/webhook-card-test-factory.tsx`**
   - Extract all shared mock setup and test helpers
   - Export `createWebhookCardTests(renderFn, opts)` function
   - `opts` type:
     ```typescript
     interface WebhookTestOpts {
       variantName: string;                    // "TenantWebhookCard" | "TeamWebhookCard"
       renderComponent: () => ReactElement;    // render function
       sampleWebhookUrls: { active: string; inactive: string }; // URLs for assertions
       sampleEvents: string[];                 // event names in sample data
       includeLocaleHook?: boolean;            // whether useLocale mock is needed
     }
     ```
   - `Collapsible` mock should respect `open` prop for auto-expand test reliability

5. **Rewrite `src/components/settings/tenant-webhook-card.test.tsx`**
   - Import and call `createWebhookCardTests` with tenant-specific render and options
   - Keep tenant-specific tests: `excludes group:tenantWebhook`, `excludes PERSONAL_LOG_ACCESS_VIEW/EXPIRE`, `includes only ADMIN/SCIM/DIRECTORY_SYNC/BREAKGLASS events`

6. **Rewrite `src/components/team/team-webhook-card.test.tsx`**
   - Import and call `createWebhookCardTests` with team-specific render and options
   - Keep team-specific test: `excludes group:webhook from event groups`
   - Add positive assertion test: `includes ENTRY/BULK/TEAM/etc. events in selector`

7. **Verify**: Run `npx vitest run` + `npx next build`

## Testing Strategy

- **Shared test factory** covers: render, empty state, limit reached, create/delete, secret display, URL validation (https, malformed, 400), error toasts, active/inactive toggle, auto-expand, no-events-disabled
- **Tenant-specific tests**: event group filtering (subscribable set, tenantWebhook exclusion, privacy-sensitive exclusion)
- **Team-specific tests**: webhook group exclusion + positive assertion for expected event groups (ENTRY, BULK, TEAM, etc.)
- All 16 tenant tests + 15 team tests must continue to pass (team gains 1 new positive assertion test)

## Considerations & Constraints

- `useTranslations()` with a dynamic namespace string works in next-intl 4 — verified by existing codebase pattern
- The `WebhookItem` interface is identical in both files — export from base and import in wrappers
- `useLocale()` is only called in `TenantWebhookCard` (team receives locale via props). The base component receives `locale` via config, so no `useLocale()` call needed in base
- Parent pages (`tenant/security/webhooks/page.tsx` and `teams/[teamId]/security/webhooks/page.tsx`) import from the same paths — no changes needed
- Module-level constants (`EVENT_GROUPS`, `subscribableSet`) stay in wrapper files since they depend on domain-specific audit constants

## User Operation Scenarios

1. **Tenant admin creates webhook**: Navigate to tenant settings > webhooks. Fill URL, select SCIM events, click create. Secret displayed. Dismiss with OK. Webhook appears in active list.
2. **Team admin creates webhook**: Navigate to team settings > webhooks. Fill URL, select ENTRY events, click create. Same flow.
3. **Delete inactive webhook**: Expand inactive section, click trash icon, confirm in dialog. Webhook removed.
4. **Limit reached**: 5 webhooks exist. "Limit reached" message shown instead of form. Inactive section auto-expanded.
5. **URL validation edge cases**: Empty URL, http:// URL, malformed URL — inline error shown, no API call.

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/components/settings/base-webhook-card.tsx` | **CREATE** — shared logic + UI (~400 lines) |
| `src/components/settings/tenant-webhook-card.tsx` | **REWRITE** — thin wrapper (~35 lines) |
| `src/components/team/team-webhook-card.tsx` | **REWRITE** — thin wrapper (~35 lines) |
| `src/components/__tests__/webhook-card-test-factory.tsx` | **CREATE** — shared test helpers |
| `src/components/settings/tenant-webhook-card.test.tsx` | **REWRITE** — use factory + tenant-specific tests |
| `src/components/team/team-webhook-card.test.tsx` | **REWRITE** — use factory + team-specific tests |
