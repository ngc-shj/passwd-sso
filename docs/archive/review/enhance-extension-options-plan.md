# Plan: enhance-extension-options

## Objective

Enhance the browser extension settings page (`extension/src/options/App.tsx`) to reach competitive parity with major password managers (Bitwarden, 1Password, Dashlane, Proton Pass). The current page has only 2 settings (Server URL, Auto-lock); competitors average 15-25.

## Context

The current options page exposes only `serverUrl` and `autoLockMinutes` via `StorageSchema`. However, many behaviors are already implemented but hardcoded:
- Clipboard clear delay: 30s (`CLIPBOARD_CLEAR_DELAY_MS`)
- Save/update login prompts: always on
- Inline suggestion dropdown: always on
- Badge counter: always on

By making these configurable, we give users control without implementing new core features.

**Note**: F5 (Auto-copy TOTP after autofill) is a **new feature**, not an existing hardcoded behavior. It requires new logic in `performAutofillForEntry()`.

## Requirements

### Functional Requirements

**Section 1: General**
- F1: Theme selector (Light / Dark / System) — applies to options page and popup
- F2: Show badge counter toggle (on/off, default: on) — controls **per-tab match count only**; global status badges (`×` for disconnected, `!` for locked) remain visible regardless

**Section 2: Autofill**
- F3: Enable inline suggestions toggle (on/off, default: on) — show/hide suggestion dropdown on form focus
- F4: Enable context menu autofill toggle (on/off, default: on) — show/hide right-click autofill entries
- F5: Auto-copy TOTP after autofill toggle (on/off, default: on) — **NEW FEATURE**: copy TOTP code to clipboard when autofilling a login entry that has TOTP configured

**Section 3: Notifications**
- F6: Show save login prompt toggle (on/off, default: on) — controls login detection banner. Must be checked both at detection time AND at delivery time (pending prompts in `pendingSavePrompts` map)
- F7: Show update password prompt toggle (on/off, default: on) — controls password update banner. Same dual-check as F6

**Section 4: Security**
- F8: Server URL (existing)
- F9: Auto-lock timeout (existing)
- F10: Clipboard clear delay selector (10s / 20s / 30s / 1m / 2m / 5m, default: 30s)
- F11: Vault timeout action selector (Lock / Log out, default: Lock)

**Section 5: Keyboard Shortcuts**
- F12: Display current keyboard shortcuts (read-only) with link to browser shortcut settings

**Section 6: About**
- F13: Extension version display
- F14: Link to web app (server URL)

### Non-Functional Requirements
- NF1: Settings must persist across browser restarts (chrome.storage.local)
- NF2: Settings changes must take effect immediately without extension reload
- NF3: Options page must support dark mode via Tailwind CSS `dark:` variant
- NF4: All new UI text must be i18n-ready (en.json + ja.json)
- NF5: Existing tests must continue to pass; new settings must have unit tests
- NF6: Defense-in-depth validation — background must whitelist-validate all enum/numeric settings from storage before use (never trust raw storage values)

## Technical Approach

### 1. Extend `StorageSchema` (`extension/src/lib/storage.ts`)

Add new fields with defaults. **Critical**: Update both `StorageSchema` interface AND `DEFAULTS` constant simultaneously.

```typescript
export interface StorageSchema {
  serverUrl: string;
  autoLockMinutes: number;
  // New settings
  theme: "light" | "dark" | "system";
  showBadgeCount: boolean;
  enableInlineSuggestions: boolean;
  enableContextMenu: boolean;
  autoCopyTotp: boolean;
  showSavePrompt: boolean;
  showUpdatePrompt: boolean;
  clipboardClearSeconds: number;
  vaultTimeoutAction: "lock" | "logout";
}

const DEFAULTS: StorageSchema = {
  serverUrl: "https://localhost:3000",
  autoLockMinutes: 15,
  theme: "system",
  showBadgeCount: true,
  enableInlineSuggestions: true,
  enableContextMenu: true,
  autoCopyTotp: true,
  showSavePrompt: true,
  showUpdatePrompt: true,
  clipboardClearSeconds: 30,
  vaultTimeoutAction: "lock",
};
```

### 2. Add Settings Validation (`extension/src/lib/storage.ts`)

Add a `validateSettings()` function for defense-in-depth:

```typescript
const VALID_THEMES = ["light", "dark", "system"] as const;
const VALID_CLIPBOARD_SECONDS = [10, 20, 30, 60, 120, 300] as const;
const VALID_TIMEOUT_ACTIONS = ["lock", "logout"] as const;

function ensureBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function ensureFiniteNonNeg(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

export function validateSettings(raw: StorageSchema): StorageSchema {
  return {
    ...raw,
    serverUrl: typeof raw.serverUrl === "string" && raw.serverUrl.length > 0
      ? raw.serverUrl : DEFAULTS.serverUrl,
    autoLockMinutes: ensureFiniteNonNeg(raw.autoLockMinutes, DEFAULTS.autoLockMinutes),
    theme: VALID_THEMES.includes(raw.theme as any) ? raw.theme : DEFAULTS.theme,
    showBadgeCount: ensureBool(raw.showBadgeCount, DEFAULTS.showBadgeCount),
    enableInlineSuggestions: ensureBool(raw.enableInlineSuggestions, DEFAULTS.enableInlineSuggestions),
    enableContextMenu: ensureBool(raw.enableContextMenu, DEFAULTS.enableContextMenu),
    autoCopyTotp: ensureBool(raw.autoCopyTotp, DEFAULTS.autoCopyTotp),
    showSavePrompt: ensureBool(raw.showSavePrompt, DEFAULTS.showSavePrompt),
    showUpdatePrompt: ensureBool(raw.showUpdatePrompt, DEFAULTS.showUpdatePrompt),
    clipboardClearSeconds: VALID_CLIPBOARD_SECONDS.includes(raw.clipboardClearSeconds as any)
      ? raw.clipboardClearSeconds : DEFAULTS.clipboardClearSeconds,
    vaultTimeoutAction: VALID_TIMEOUT_ACTIONS.includes(raw.vaultTimeoutAction as any)
      ? raw.vaultTimeoutAction : DEFAULTS.vaultTimeoutAction,
  };
}
```

Background must call `validateSettings(await getSettings())` before using any enum/numeric value.

### 3. Restructure Options Page (`extension/src/options/App.tsx`)

Replace flat layout with sectioned card layout:
- General / Autofill / Notifications / Security / Keyboard Shortcuts / About
- Each section is a collapsible or always-visible card
- Toggle switches for boolean settings, dropdowns for enums

### 4. Wire Settings to Background Service Worker

Each setting needs a consumer in `extension/src/background/index.ts`:

| Setting | Consumer location | How |
|---------|------------------|-----|
| `showBadgeCount` | `updateBadgeForTab()` | Skip per-tab count if false; keep global `×`/`!` status |
| `enableInlineSuggestions` | `GET_MATCHES_FOR_URL` handler | Return empty if false |
| `enableContextMenu` | `setupContextMenu()` + `chrome.storage.onChanged` | If false: `chrome.contextMenus.removeAll()`; if true: `setupContextMenu()` **then** `updateContextMenuForTab(activeTabId, activeTabUrl)` to rebuild child items. React to changes via onChanged listener |
| `autoCopyTotp` | `performAutofillForEntry()` | **New logic (LOGIN entries only)**: after autofill success, if `entryType === EXT_ENTRY_TYPE.LOGIN` AND `blob.totp` is configured, **reuse the already-computed `totpCode` variable** (~line 1297). Then: `await chrome.alarms.clear(ALARM_CLEAR_CLIPBOARD)` → `copyToClipboard(totpCode)` → update `lastClipboardCopyTime` → schedule clear alarm (same pattern as manual copy at ~line 746). Use same `clipboardClearSeconds` as manual copy |
| `showSavePrompt` | `LOGIN_DETECTED` handler + `tabs.onUpdated` delivery (~line 556) | Check at both detection AND delivery time |
| `showUpdatePrompt` | `LOGIN_DETECTED` handler + `tabs.onUpdated` delivery (~line 556) | Check at both detection AND delivery time |
| `clipboardClearSeconds` | clipboard copy handlers (CMD_COPY_PASSWORD, CMD_COPY_USERNAME, autoCopyTotp) + `ALARM_CLEAR_CLIPBOARD` fallback | Read `getSettings()` at each copy operation; use dynamic value for setTimeout AND for alarm fallback condition (replace hardcoded `CLIPBOARD_CLEAR_DELAY_MS` in alarm handler at ~line 596). All copy paths (manual + autoCopyTotp) must use the same `clipboardClearSeconds` value |
| `vaultTimeoutAction` | `ALARM_VAULT_LOCK` handler | If "lock": `clearVault()` (current behavior). If "logout": use async IIFE pattern: `await revokeCurrentTokenOnServer()` → `clearToken()` (which internally calls `clearVault()`). Note: do NOT call `clearVault()` separately — `clearToken()` already includes it |
| `theme` | Options page + popup | Apply `dark` class to `<html>` |

**Settings change propagation (`chrome.storage.onChanged`)**: The existing listener (~line 602) has an early return `if (!changes.autoLockMinutes) return;` — this must be refactored to handle multiple fields. Extend to handle:
- `enableContextMenu`: toggle context menu immediately (if true→false: `removeAll()`; if false→true: `setupContextMenu()` + `updateContextMenuForTab()`)
- `clipboardClearSeconds`: reschedule active clipboard clear timer if applicable
- `showBadgeCount`: refresh badge on active tab

### 5. Theme Implementation

- Use `prefers-color-scheme` media query for "system" mode
- Add `dark:` Tailwind classes to options page and popup
- Store preference in `chrome.storage.local`, apply on page load before render (flash prevention)
- Create shared `applyTheme()` utility in `extension/src/lib/theme.ts`
- **Validation**: Whitelist-check theme value before DOM manipulation. Use `classList.add/remove("dark")`, never direct `className` assignment

### 6. Keyboard Shortcuts Display

- Read `chrome.commands.getAll()` to get current shortcut bindings
- Display in a read-only list
- Link: Use `chrome.tabs.create({ url: "chrome://extensions/shortcuts" })` for Chrome/Edge. For Firefox, use `browser.runtime.openOptionsPage()` or display text "Configure in browser settings" without link

## Implementation Steps

1. **Extend StorageSchema + update tests** — Add new fields, defaults, and `validateSettings()` to `extension/src/lib/storage.ts`. **Simultaneously** update `extension/src/__tests__/lib/storage.test.ts` to include all new field defaults in assertions
2. **Create theme utility** — `extension/src/lib/theme.ts` with `applyTheme()` + `useTheme()` hook
3. **Redesign options page** — Sectioned layout in `extension/src/options/App.tsx` with all new settings
4. **Add i18n keys** — Update `extension/src/messages/en.json` and `ja.json` with all new option labels
5. **Wire background consumers** — Update `extension/src/background/index.ts`:
   - Read settings via `validateSettings(await getSettings())` at each decision point
   - Add `autoCopyTotp` logic in `performAutofillForEntry()` — **LOGIN entries only** (`entryType === EXT_ENTRY_TYPE.LOGIN` guard)
   - Add `vaultTimeoutAction` branch in `ALARM_VAULT_LOCK` handler — use **async IIFE pattern** `(async () => { ... })().catch(() => {})` since alarm callbacks don't natively await promises. Logout path: `await revokeCurrentTokenOnServer()` → `clearToken()` (do NOT separately call `clearVault()`). Note: `revokeCurrentTokenOnServer()` has internal try/catch that swallows network errors, so `clearToken()` is guaranteed to execute even on network failure
   - Replace hardcoded `CLIPBOARD_CLEAR_DELAY_MS` constant: read `clipboardClearSeconds` dynamically from settings at each copy operation AND in `ALARM_CLEAR_CLIPBOARD` fallback condition
   - Refactor `chrome.storage.onChanged` listener: remove early return for `autoLockMinutes` only; extend to handle `enableContextMenu`, `clipboardClearSeconds`, `showBadgeCount`
   - Check `showSavePrompt`/`showUpdatePrompt` at both detection and delivery time
6. **Wire content script consumers** — Update form detector to check `enableInlineSuggestions`
7. **Update popup theme** — Apply theme to `extension/src/popup/App.tsx`
8. **Update test infrastructure** —
   - Update `background.test.ts` `installChromeMock()` storage mock to return all default fields (including new ones)
   - **Also update** `team-entries.test.ts` `installChromeMock()` and `background-commands.test.ts` storage mocks with all default fields
   - Update `background-commands.test.ts` clipboard alarm test: set mock `clipboardClearSeconds: 30` explicitly and update assertion to `delayInMinutes: 0.5` (matching 30s default)
   - Add `chrome.commands.getAll` mock to options test setup
   - Add `@vitest-environment jsdom` to theme test; mock `window.matchMedia` (including `addEventListener('change', ...)` for system theme changes)
   - Test theme cases: light, dark, system+dark, system+light, **system + OS theme change event**
   - Test background setting-conditional branches (badge toggle, context menu toggle, vaultTimeoutAction variants incl. `revokeCurrentTokenOnServer()` call verification for logout, prompt toggles)
   - Add fetch mock for token revocation endpoint used by `revokeCurrentTokenOnServer()` in logout tests
   - **Update existing** `App.test.tsx` "saves settings when valid" assertion (~line 77) to include all new fields in expected `setSettings()` argument
   - Add `offscreen.hasDocument: vi.fn().mockResolvedValue(false)` to `background-commands.test.ts` offscreen mock
   - Test Options page: render with all fields → Save → verify `setSettings` receives complete object
9. **Build verification** — Run lint, tests, and extension production build (`cd extension && npm run build`)

## Testing Strategy

- **Unit tests**:
  - StorageSchema: defaults for all 11 fields, `validateSettings()` with valid/invalid/tampered values
  - Theme utility: 4 cases (light, dark, system+dark-os, system+light-os) with jsdom + matchMedia mock
  - Options page: render with full settings, save button passes all fields to `setSettings()`
  - Background: badge toggle (on/off), context menu toggle, `vaultTimeoutAction` alarm handler (lock/logout), `showSavePrompt`/`showUpdatePrompt` at detection + delivery, `clipboardClearSeconds` dynamic value, `autoCopyTotp` in autofill path
- **Manual testing**:
  - Toggle each setting and verify behavior changes immediately
  - Theme: verify light/dark/system modes in options page and popup
  - Clipboard clear: verify timing with different settings
  - Badge: verify per-tab count suppressed but `×`/`!` remains
  - Save prompt: verify banner shows/hides on login detection (including pending prompts)
  - Keyboard shortcuts: verify display matches actual bindings
  - Vault timeout logout: verify server-side token revocation + full disconnect
- **Build**: Extension build via `cd extension && npm run build`

## Considerations & Constraints

- **Tenant policy override**: Auto-lock and potentially other security settings can be overridden by tenant admin policy. The UI should indicate this (already done for auto-lock). `clipboardClearSeconds` does NOT have tenant policy override in this PR (documented as future enhancement).
- **chrome.commands.getAll()** is only available in extension contexts. The options page runs as an extension page, so this is fine.
- **Keyboard shortcut link**: `chrome://extensions/shortcuts` works for Chrome and Chromium-based browsers. For Firefox, the URL differs. Detect browser and adapt link or show generic text.
- **Theme flash prevention**: Apply theme class synchronously in `<script>` before React hydration to avoid light→dark flash.
- **No breaking changes**: All new settings have defaults matching current behavior. Existing users see no change until they modify settings.
- **F5 is a new feature**: `autoCopyTotp` requires new logic in `performAutofillForEntry()` — TOTP detection → clipboard copy → timer scheduling. This is NOT toggling an existing behavior.

## Implementation Checklist

### Files to modify
- [ ] `extension/src/lib/storage.ts` — extend StorageSchema, DEFAULTS, add validateSettings()
- [ ] `extension/src/lib/theme.ts` — **new file** for applyTheme() + useTheme() hook
- [ ] `extension/src/options/App.tsx` — redesign with 6 sections
- [ ] `extension/src/options/main.tsx` — apply theme init before render
- [ ] `extension/src/messages/en.json` — add all new options.* keys
- [ ] `extension/src/messages/ja.json` — add all new options.* keys
- [ ] `extension/src/background/index.ts` — wire all setting consumers (lines 92, 245, 538, 584, 602, 753, 1294, 2061)
- [ ] `extension/src/popup/App.tsx` — apply theme
- [ ] `extension/src/popup/main.tsx` — apply theme init before render

### Shared utilities to reuse
- `extension/src/lib/storage.ts:14` — `getSettings()` / `setSettings()` (extend, don't replace)
- `extension/src/lib/i18n.ts` — `t()` function (existing i18n, NOT chrome.i18n)
- `extension/src/background/context-menu.ts:37` — `setupContextMenu()` (call for re-enable)
- `extension/src/background/context-menu.ts:51` — `updateContextMenuForTab()` (call after re-enable)
- `extension/src/background/index.ts:435` — `revokeCurrentTokenOnServer()` (call for logout path)
- `extension/src/background/index.ts:196` — `clearToken()` (includes clearVault())
- `extension/src/background/index.ts:1294` — existing `totpCode` variable (reuse for autoCopyTotp)
- `extension/src/lib/constants.ts` — `ALARM_CLEAR_CLIPBOARD`, `ALARM_VAULT_LOCK`, `EXT_ENTRY_TYPE`

### Test files to update
- [ ] `extension/src/__tests__/lib/storage.test.ts` — update defaults assertions for all 11 fields + validateSettings tests
- [ ] `extension/src/__tests__/options/App.test.tsx` — add chrome.commands.getAll mock, update mockGetSettings, update save assertion
- [ ] `extension/src/__tests__/background.test.ts` — update installChromeMock storage mock
- [ ] `extension/src/__tests__/background-commands.test.ts` — update storage mock, fix alarm assertion, add offscreen.hasDocument mock
- [ ] `extension/src/__tests__/background/team-entries.test.ts` — update installChromeMock storage mock
- [ ] `extension/src/__tests__/background/totp-handlers.test.ts` — update installChromeMock storage mock
- [ ] `extension/src/__tests__/lib/theme.test.ts` — **new file** with jsdom env, matchMedia mock, 5 cases
- [ ] `extension/src/__tests__/popup/VaultUnlock.test.tsx` — update mockGetSettings

### Patterns to follow consistently
- All setting reads: `validateSettings(await getSettings())` (never raw `getSettings()`)
- Boolean toggles: read setting → early return if disabled
- clipboardClearSeconds: read dynamically at each copy operation, not from module-scope constant
- Theme: `classList.add/remove("dark")`, never direct className assignment

## User Operation Scenarios

### Scenario 1: User wants to disable autofill suggestions on banking sites
1. Open extension settings
2. Navigate to "Autofill" section
3. Toggle off "Show inline suggestions"
4. Save → settings take effect immediately
5. Visit banking site → no suggestion dropdown appears on login fields

### Scenario 2: User prefers dark mode
1. Open extension settings
2. In "General" section, select "Dark" from theme dropdown
3. Options page immediately switches to dark theme
4. Open popup → popup also uses dark theme

### Scenario 3: Security-conscious user wants shorter clipboard clear time
1. Open extension settings
2. Navigate to "Security" section
3. Change clipboard clear from 30s to 10s
4. Copy a password → clipboard auto-clears after 10 seconds

### Scenario 4: User doesn't want save login prompts
1. Open extension settings
2. Navigate to "Notifications" section
3. Toggle off "Show save login prompt"
4. Login to any site → no save banner appears
5. Even pending prompts from before the toggle are suppressed (checked at delivery time)

### Scenario 5: User wants to log out instead of lock on timeout
1. Open extension settings
2. Navigate to "Security" section
3. Change vault timeout action from "Lock" to "Log out"
4. After inactivity timeout → extension revokes server token, clears local session, fully disconnects (requires re-authentication)

### Scenario 6: User checks keyboard shortcuts
1. Open extension settings
2. Scroll to "Keyboard Shortcuts" section
3. See list: Ctrl+Shift+A (open popup), Ctrl+Shift+P (copy password), etc.
4. Click "Customize in browser settings" → browser opens shortcut configuration page
