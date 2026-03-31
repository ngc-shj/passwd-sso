# Coding Deviation Log: card-structure-unification
Created: 2026-03-31

## Deviations from Plan

### D-1: tenant-audit-log-card uses tenantDescription instead of description
- **Plan description**: Use `t("description")` for logs variant CardDescription
- **Actual implementation**: Added new i18n key `tenantDescription` and used `t("tenantDescription")`
- **Reason**: The existing `description` key contains personal audit log text ("Review your personal security events..."), not appropriate for tenant admin context
- **Impact scope**: AuditLog i18n namespace (en + ja), tenant-audit-log-card.tsx

### D-2: CardAction not used for header action buttons
- **Plan description**: Reference pattern uses flex wrapper for action buttons in CardHeader
- **Actual implementation**: Used custom `flex items-start justify-between` wrapper instead of shadcn CardAction component
- **Reason**: Existing cards in the codebase (directory-sync-card, passkey-credentials-card) use the same flex pattern. Using CardAction would introduce inconsistency with existing cards.
- **Impact scope**: service-account-card, mcp-client-card

### D-3: subTabBreakglass i18n key not removed
- **Plan description**: Remove unused i18n keys (subTabTenantLogs, subTabBreakglass)
- **Actual implementation**: `subTabTenantLogs` is reused as CardTitle for logs variant. `subTabBreakglass` is unused but not removed from translation files.
- **Reason**: Dead key removal is low risk but adds noise to diff. Can be cleaned up separately.
- **Impact scope**: None (dead key)
