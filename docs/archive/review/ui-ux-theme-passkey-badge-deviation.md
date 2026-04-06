# Coding Deviation Log: ui-ux-theme-passkey-badge
Created: 2026-04-06

## Deviations from Plan

### D1: API_ERROR.INTERNAL → API_ERROR.INTERNAL_ERROR
- **Plan description**: Use `API_ERROR.INTERNAL` for catch block error response
- **Actual implementation**: Used `API_ERROR.INTERNAL_ERROR` — the correct key name in the codebase
- **Reason**: `API_ERROR.INTERNAL` does not exist; the actual enum key is `INTERNAL_ERROR`
- **Impact scope**: `src/app/api/user/auth-provider/route.ts` only

### D2: Theme translation key "themeSystem" (ja) changed
- **Plan description**: `"themeSystem": "システム"`
- **Actual implementation**: `"themeSystem": "システム設定に従う"`
- **Reason**: User requested alignment with browser extension terminology. Extension uses "システム設定に従う" for the system theme option.
- **Impact scope**: `messages/ja/Common.json` only
