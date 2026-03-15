# Coding Deviation Log: unify-settings-page
Created: 2026-03-15T00:00:00+09:00

## Deviations from Plan

### D1: Added `noActiveWebhooks` i18n key (not in plan)
- **Plan description**: Only `inactiveWebhooks` key was planned for TenantWebhook.json and TeamWebhook.json
- **Actual implementation**: Also added `noActiveWebhooks` key to both en/ja webhook JSON files
- **Reason**: When all webhooks are inactive, a message is needed to indicate no active webhooks exist (distinct from "no webhooks configured")
- **Impact scope**: messages/{en,ja}/TenantWebhook.json, messages/{en,ja}/TeamWebhook.json

### D2: Webhook card uses `renderWebhookItem` helper instead of duplicated JSX
- **Plan description**: Plan said "extract it or duplicate it in both sections"
- **Actual implementation**: Extracted a `renderWebhookItem` helper function within each webhook card component
- **Reason**: Avoids code duplication between active and inactive rendering sections
- **Impact scope**: tenant-webhook-card.tsx, team-webhook-card.tsx (internal refactor only)

---
