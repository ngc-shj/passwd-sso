# Coding Deviation Log: fix-webhook-subscribable-events
Created: 2026-04-01

## Deviations from Plan

### D1: index.ts barrel export kept (plan said to remove)
- **Plan description**: Plan removed Step 3 (barrel export) during review, stating components import from `audit.ts` directly
- **Actual implementation**: Added `TEAM_WEBHOOK_EVENT_GROUPS` and `TENANT_WEBHOOK_EVENT_GROUPS` to `src/lib/constants/index.ts` exports
- **Reason**: API route files (`src/app/api/tenant/webhooks/route.ts`, `src/app/api/teams/[teamId]/webhooks/route.ts`) import `*_SUBSCRIBABLE_ACTIONS` from the barrel `@/lib/constants`, not from `@/lib/constants/audit`. The barrel must re-export any new constants that downstream consumers may need. Additionally, `audit.test.ts` imports from `@/lib/constants`.
- **Impact scope**: `src/lib/constants/index.ts` only — two additional export names

---
