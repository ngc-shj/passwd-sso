# Plan: refine-extension-popup

## Context

The browser extension popup has three UX issues, plus a pre-existing security concern:
1. An unnecessary "Enable autofill for this site" button appears on every site. Since content scripts are auto-injected via manifest `content_scripts`, this button provides no real functionality for external sites.
2. The extension icon badge only shows connection status (×/!/empty), but doesn't indicate how many matching entries exist for the current page.
3. The "Other entries" section shows all non-matching entries including LOGIN entries from unrelated sites, which is confusing. Only non-LOGIN types (credit cards, identity) are useful in that section.
4. `isHostMatch()` uses asymmetric subdomain matching: entry `example.com` matches tab `evil.example.com`. This could leak overview data (title, username) to attacker-controlled subdomains via inline suggestions.

## Requirements

### Functional
- R1: Remove the "Enable autofill" button, `checkHostPermission`, `hasHostPermission`, and `injectFormDetector` from the popup
- R2: Show per-tab match count badge on the extension icon when vault is unlocked (e.g., "3" in blue)
- R3: Hide LOGIN-type entries from the unmatched section; only show CREDIT_CARD and IDENTITY entries there
- R4: Keep `ensureHostPermission()` in VaultUnlock.tsx and options page (needed for server URL)
- R5: Keep `optional_host_permissions` in manifest (needed for server URL permission flow)
- R6: Review `isHostMatch()` subdomain matching for security implications (see Considerations)

### Non-functional
- Existing test suite must pass
- Production build must succeed
- Badge updates must not cause visible performance degradation

## Technical Approach

### Task 1: Remove "Enable autofill" button (App.tsx + i18n)

**Files:** `extension/src/popup/App.tsx`, `extension/src/messages/{en,ja}.json`

Remove:
- `checkHostPermission()` function (lines 11-18)
- `injectFormDetector()` function (lines 20-29)
- `hasHostPermission` state (line 45)
- Permission check in useEffect (lines 68-78)
- Button JSX block (lines 165-193)
- i18n keys: `popup.enableAutofill`, `popup.autofillEnabled`

Keep:
- `ensureHostPermission()` in VaultUnlock.tsx (server URL)
- `optional_host_permissions` in manifest

### Task 2: Match count badge (background/index.ts)

**File:** `extension/src/background/index.ts`

Add `updateBadgeForTab(tabId, url)` after existing `updateBadge()` (line 208):
- If no token or no encryptionKey → early return (global badge takes priority)
- If url is non-HTTP, undefined, or own app → empty badge for tab
- Otherwise: count LOGIN entries matching tab host via `getCachedEntries()` + `isHostMatch()`
- `getCachedEntries()` returns both personal and team vault entries
- Count > 0 → `setBadgeText({ text: count.toString(), tabId })` + blue background (#3B82F6)
- Count = 0 → `setBadgeText({ text: "", tabId })`
- Count > 99 → show "99+"

Integration points:
- `tabs.onActivated` (line 433): call `updateBadgeForTab` after `updateContextMenuForTab`
- `tabs.onUpdated` status=loading: clear badge for tab (prevents stale count during navigation)
- `tabs.onUpdated` status=complete (line 440): call `updateBadgeForTab` after `updateContextMenuForTab`
- `updateBadge()` vault-unlocked branch: query active tab and call `updateBadgeForTab`

Badge cleanup on vault lock/disconnect:
- When `updateBadge()` sets global badge to "×" or "!", per-tab overrides still take precedence
- Add `clearAllTabBadges()` helper (fire-and-forget, no await needed) that queries all tabs and calls `setBadgeText({ text: "", tabId })` for each
- Call `clearAllTabBadges()` in the disconnected and locked branches of `updateBadge()`

Reuse existing: `getCachedEntries()`, `extractHost()`, `isHostMatch()`, `isOwnAppPage()`, `EXT_ENTRY_TYPE.LOGIN`

### Task 3: Filter unmatched entries (MatchList.tsx)

**File:** `extension/src/popup/components/MatchList.tsx`

Change at line 146:
```typescript
// Before
const unmatched = tabHost ? sorted.filter((e) => !matched.includes(e)) : sorted;

// After
const unmatchedAll = tabHost ? sorted.filter((e) => !matched.includes(e)) : sorted;
const unmatched = tabHost
  ? unmatchedAll.filter((e) => e.entryType !== EXT_ENTRY_TYPE.LOGIN)
  : unmatchedAll;
```

When `tabHost` is absent (chrome:// pages, new tab), show all entries as before.

### Task 4: isHostMatch() subdomain matching analysis (R6)

**File:** `extension/src/lib/url-matching.ts` — **No code change**

Current `isHostMatch(entryHost, tabHost)` uses `t.endsWith(`.${e}`)`: entry `example.com` matches tab `login.example.com` and also `evil.example.com`. This is an accepted design decision:
- `example.com` entry → `login.example.com` tab ✓ (desired, common use case)
- `example.com` entry → `evil.example.com` tab ✓ (risk accepted)
- `login.example.com` entry → `example.com` tab ✗ (child→parent is strict)

**Decision:** Keep as-is. Same approach used by 1Password, Bitwarden, etc. Tightening would break legitimate subdomain use cases. Documented as accepted risk in Considerations.

## Implementation Steps

1. Task 1: Remove autofill button from App.tsx
2. Task 1: Remove i18n keys from en.json and ja.json
3. Task 3: Filter LOGIN entries from unmatched section in MatchList.tsx
4. Task 2: Add `updateBadgeForTab()` function in background/index.ts
5. Task 2: Add `clearAllTabBadges()` helper
6. Task 2: Integrate badge update into `tabs.onActivated` and `tabs.onUpdated` (including loading clear)
7. Task 2: Update `updateBadge()` to call `clearAllTabBadges()` on lock/disconnect and `updateBadgeForTab()` on unlock
8. Add tests: App.test.tsx (button non-existence), background.test.ts (badge count), MatchList.test.tsx (LOGIN filter)
9. Run extension tests (`cd extension && npx vitest run`)
10. Run main tests (`npx vitest run`)
11. Run production build (`npx next build`)

## Testing Strategy

### Required automated tests
- **App.test.tsx**: Assert "Enable autofill" button does not exist in vault_unlocked state
- **background.test.ts**: Test `updateBadgeForTab` via tab event simulation:
  - Tab with matching entries → `setBadgeText({ text: "N", tabId })` with blue color
  - Tab with no matches → `setBadgeText({ text: "", tabId })`
  - Vault lock → all per-tab badges cleared
- **MatchList.test.tsx**: Test unmatched section filtering:
  - With `tabUrl` set: LOGIN entries excluded from unmatched section
  - Without `tabUrl`: all entries shown
- **url-matching.test.ts**: Existing tests must still pass (no changes to isHostMatch)

### Manual verification
- Load extension, check badge shows match count on sites with saved credentials
- Confirm "Enable autofill" button no longer appears in popup
- Confirm unmatched section only shows CC/Identity entries

## Considerations & Constraints

- `ensureHostPermission` in VaultUnlock.tsx must NOT be removed — it's for server URL, not external sites
- Per-tab badge (`{ tabId }`) overrides global badge for that tab; global badge is the default for new tabs
- `getCachedEntries()` may return empty if cache expired — badge will show 0 until next cache refresh
- Chrome limits badge text to ~4 characters; use "99+" for counts over 99
- Badge count showing credential count per site is standard behavior for password managers (1Password, Bitwarden, etc.)
- Must clear per-tab badges when vault locks or user disconnects, otherwise stale counts persist
- Clear badge on `tabs.onUpdated status=loading` to prevent stale count during navigation
- `clearAllTabBadges()` is fire-and-forget (no await needed)
- `isHostMatch()` subdomain matching (`example.com` → `login.example.com`) is an accepted design decision shared with other major password managers. Tightening would break legitimate subdomain use cases.
