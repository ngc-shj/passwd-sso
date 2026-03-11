# Coding Deviation Log: feat-share-access-password
Created: 2026-03-11T14:00:00+09:00

## Deviations from Plan

### DEV-1: Added password toggle to share-dialog.tsx (entry share UI)
- **Plan description**: Plan focused on send-dialog.tsx for password toggle UI
- **Actual implementation**: Also added requirePassword toggle, password display, and copy functionality to share-dialog.tsx (entry share dialog)
- **Reason**: The API for share-links already supported requirePassword but the entry share dialog UI was missing the toggle. Consistency required adding it.
- **Impact scope**: src/components/share/share-dialog.tsx

### DEV-2: Download route now checks maxViews for all shares
- **Plan description**: Download route was separate from viewCount logic
- **Actual implementation**: Added maxViews/viewCount check to download route for all shares (not just password-protected ones), returning 410 when limit reached
- **Reason**: Pre-existing gap where downloads could bypass view limits. Fixed as part of this feature to ensure consistent enforcement.
- **Impact scope**: src/app/s/[token]/download/route.ts, src/__tests__/api/s/download.test.ts

---
