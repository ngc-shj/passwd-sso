# Coding Deviation Log: mcp-connections-page
Created: 2026-04-01

## Deviations from Plan

### DEV-1: i18n namespace for nav label
- **Plan description**: Add `subTabConnections` to `Settings` namespace
- **Actual implementation**: Added `subTabMcpConnections` to `Sessions` namespace
- **Reason**: Settings layout uses `useTranslations("Sessions")`, not "Settings". The key was renamed to `subTabMcpConnections` for clarity.
- **Impact scope**: `messages/{en,ja}/Sessions.json`, settings layout

### DEV-2: Route path naming
- **Plan description**: `/dashboard/settings/developer/connections`
- **Actual implementation**: `/dashboard/settings/developer/mcp-connections`
- **Reason**: More specific naming to avoid ambiguity with other potential "connections" features
- **Impact scope**: Page file path, nav item href

### DEV-3: Additional i18n files required
- **Plan description**: Plan did not explicitly list AuditLog.json updates
- **Actual implementation**: Added `MCP_CONNECTION_REVOKE` key to `messages/{en,ja}/AuditLog.json`
- **Reason**: Exhaustive i18n test (`audit-log-keys.test.ts`) requires every AuditAction to have an i18n entry
- **Impact scope**: `messages/{en,ja}/AuditLog.json`

### DEV-4: AUDIT_ACTION_VALUES and personal group arrays
- **Plan description**: Plan mentioned adding to enum and constants only
- **Actual implementation**: Also added to `AUDIT_ACTION_VALUES` array and `AUDIT_ACTION_GROUPS_PERSONAL.DELEGATION` group
- **Reason**: `audit.test.ts` validates VALUES array alignment; personal group ensures the action appears in personal audit log filters
- **Impact scope**: `src/lib/constants/audit.ts`

### DEV-5: formatDateTime requires locale parameter
- **Plan description**: Component uses `formatDateTime(date)`
- **Actual implementation**: Uses `formatDateTime(date, locale)` with `useLocale()` from next-intl
- **Reason**: `formatDateTime` signature requires locale parameter (existing codebase pattern)
- **Impact scope**: Component implementation only
