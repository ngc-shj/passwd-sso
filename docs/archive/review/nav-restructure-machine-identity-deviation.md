# Coding Deviation Log: nav-restructure-machine-identity
Created: 2026-04-01

## Deviations from Plan

### DEV-1: Route slug naming — "accounts" and "clients" (as planned)
- **Plan description**: `/admin/tenant/service-accounts/accounts` and `/admin/tenant/mcp/clients`
- **Actual implementation**: Implemented as planned
- **Reason**: N/A — no deviation
- **Impact scope**: N/A

No deviations from the plan. All implementation steps were executed as specified:
1. New route directories and layouts created (7 new files)
2. Old machine-identity route group deleted (5 files)
3. Admin sidebar updated with two separate NavItem groups
4. i18n keys added (navSaAccounts, navMcp, sectionServiceAccounts, sectionServiceAccountsDesc, sectionMcp, sectionMcpDesc) and removed (navMachineIdentity, sectionMachineIdentity, sectionMachineIdentityDesc, navDelegation)
5. Sidebar test updated with new hrefs, comment, and 2 new active-state tests
6. Redirect page tests created for both new redirect pages
