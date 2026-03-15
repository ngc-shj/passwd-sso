# Coding Deviation Log: unify-settings-page
Created: 2026-03-15T00:00:00+09:00

## Deviations from Plan

### D1: Added `noActiveWebhooks` i18n key (not in plan)
- **Plan description**: Only `inactiveWebhooks` key was planned
- **Actual implementation**: Also added `noActiveWebhooks` and `registeredWebhooks` keys
- **Reason**: Needed for empty active list state and list section heading
- **Impact scope**: messages/{en,ja}/TenantWebhook.json, messages/{en,ja}/TeamWebhook.json

### D2: Webhook card uses `renderWebhookItem` helper
- **Plan description**: Plan said "extract it or duplicate it"
- **Actual implementation**: Extracted as helper function
- **Reason**: Avoids code duplication
- **Impact scope**: tenant-webhook-card.tsx, team-webhook-card.tsx

### D3: Webhook card split into two separate Cards (not in plan)
- **Plan description**: Plan described single Card with border-t sections
- **Actual implementation**: Form and list are separate Card components with distinct headings
- **Reason**: User feedback — hard to tell where form ends and list begins
- **Impact scope**: tenant-webhook-card.tsx, team-webhook-card.tsx

### D4: Team policy categorized into sections (not in plan)
- **Plan description**: Not in original plan
- **Actual implementation**: Added Password Requirements / Access Control / Advanced category headings with Separators
- **Reason**: User feedback — policy items were undifferentiated flat list
- **Impact scope**: team-policy-settings.tsx

### D5: Sub-tabs merged (not in plan)
- **Plan description**: Plan kept existing sub-tab structure
- **Actual implementation**: Merged "Add from Tenant" + "Invite Member" into single "Add Member" tab with two Card sections
- **Reason**: User feedback — distinction between the two was confusing
- **Impact scope**: teams/[teamId]/settings/page.tsx, Team.json (en/ja)

### D6: Transfer ownership search added (not in plan)
- **Plan description**: Not in plan
- **Actual implementation**: Added filterMembers search to transfer ownership list
- **Reason**: User feedback
- **Impact scope**: teams/[teamId]/settings/page.tsx

### D7: Passkey discoverable badge added (not in plan)
- **Plan description**: Not in plan
- **Actual implementation**: Added blue "Passkey sign-in" badge for discoverable credentials, reordered badges
- **Reason**: User feedback — non-discoverable had "Email sign-in only" but discoverable had no indicator
- **Impact scope**: passkey-credentials-card.tsx, WebAuthn.json (en/ja)

### D8: Delete team kept in General tab (plan tried outside tabs)
- **Plan description**: Plan placed it outside tabs
- **Actual implementation**: Kept in General tab
- **Reason**: Outside tabs caused it to show on all tabs, which was unintended
- **Impact scope**: teams/[teamId]/settings/page.tsx

### D9: Slug read-only styling + terminology fix (not in plan)
- **Plan description**: Not in plan
- **Actual implementation**: Styled slug input as muted/read-only, added "slugReadOnly" i18n key, fixed ボールト→保管庫
- **Reason**: User feedback
- **Impact scope**: teams/[teamId]/settings/page.tsx, Team.json, Sessions.json

---
