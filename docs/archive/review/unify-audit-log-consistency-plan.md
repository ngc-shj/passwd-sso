# Plan: Unify Audit Log UI Consistency

## Objective

Fix visual and functional inconsistencies across the three audit log views (personal, team, tenant). The previous `unify-audit-log-ui` refactoring extracted shared components/hooks, but left UI differences between the views that should be consistent.

## Requirements

### Functional
- Team audit log must have actor type filter (HUMAN/SERVICE_ACCOUNT/MCP_AGENT) — currently missing
- Tenant audit log must show action-specific icons — currently shows generic ScrollText for all rows
- ACTION_ICONS map must be shared — currently duplicated in personal and team pages

### Visual
- Team audit log filter section must use `rounded-xl border bg-card/80 p-4` wrapper — currently unstyled
- Team audit log badges must use `AuditActorTypeBadge` instead of Avatar — Avatar is for member lists, not audit logs
- Team audit log operator info remains in the detail section (not removed, just badge changes)

## Technical Approach

### 1. Extract shared ACTION_ICONS to `src/components/audit/audit-action-icons.tsx`

Create a new shared module exporting the icon map. Placed in `components/audit/` (not `lib/`) because it exports JSX, matching the convention that `lib/` is for pure utilities. Both personal and team pages currently define identical base icons. The shared module includes all icons (personal-only emergency icons included since they won't match non-personal actions anyway).

### 2. Fix team audit log page

- Import `AuditActorTypeBadge` instead of Avatar
- Import actor type filter from hook (already supported by `useAuditLogs`)
- Add actor type select (HUMAN/SERVICE_ACCOUNT/MCP_AGENT) matching tenant's pattern
- Wrap filter section in `div.rounded-xl.border.bg-card/80.p-4`
- Replace Avatar badge with `AuditActorTypeBadge`
- Import shared ACTION_ICONS, remove local definition

### 3. Fix tenant audit log card

- Import shared ACTION_ICONS
- Use `ACTION_ICONS[log.action] ?? <ScrollText />` instead of always `<ScrollText />`

### 4. Update personal audit log page

- Import shared ACTION_ICONS, remove local definition
- Add SERVICE_ACCOUNT to actor type filter (currently only HUMAN/MCP_AGENT, inconsistent with team/tenant)

## Implementation Steps

1. Create `src/components/audit/audit-action-icons.tsx` — shared ACTION_ICONS map
2. Update team page — add filter wrapper, actor type filter, replace Avatar with AuditActorTypeBadge, use shared icons
3. Update tenant card — use shared ACTION_ICONS for row icons
4. Update personal page — use shared ACTION_ICONS, add SERVICE_ACCOUNT to actor type filter
5. Run vitest and next build

## Files to Modify

### New files
- `src/components/audit/audit-action-icons.tsx`

### Modified files
- `src/app/[locale]/admin/teams/[teamId]/audit-logs/page.tsx`
- `src/components/settings/tenant-audit-log-card.tsx`
- `src/app/[locale]/dashboard/audit-logs/page.tsx`

## Testing Strategy

- `npx vitest run` — existing tests must pass
- `npx next build` — production build must succeed
- No new tests needed (no new logic, just UI alignment)

## Considerations & Constraints

- Personal page outer layout stays as-is (matches other dashboard pages)
- Team/tenant pages stay as Card + SectionCardHeader (matches admin console pattern)
- Team operator info (`operatedBy`) remains in detail section — only badge changes
- i18n keys already exist for actor type filter — no new translations needed
- `useAuditLogs` hook already supports `actorTypeFilter` — team page just needs to wire it up

## User Operation Scenarios

1. **Team audit log**: Admin views team audit logs. Now sees actor type filter dropdown (ALL/HUMAN/SERVICE_ACCOUNT/MCP_AGENT), filter area has border/background matching tenant, each row shows action-specific icon and AuditActorTypeBadge (not avatar). Operator name still shown in detail text.

2. **Tenant audit log**: Admin views tenant audit logs. Each row now shows action-specific icon (e.g., Plus for ENTRY_CREATE, Trash2 for ENTRY_DELETE) instead of generic ScrollText.

3. **Personal audit log**: Actor type filter now includes SERVICE_ACCOUNT option (HUMAN/SERVICE_ACCOUNT/MCP_AGENT), consistent with team/tenant. Icons imported from shared module.
