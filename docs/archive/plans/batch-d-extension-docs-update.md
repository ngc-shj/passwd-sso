# Plan: Group A — Browser Extension Enhancements (Documentation Update)

## Context

Group A in Batch D of the feature-gap-analysis includes three browser extension features:
- **X-5**: New-login detect & save
- **X-3**: Context menu (right-click)
- **X-4**: Extension keyboard shortcuts

After thorough investigation, **all three features are already fully implemented** with production code, comprehensive tests, and full i18n (en/ja) support. The feature-gap-analysis.md document just hasn't been updated to reflect their completion.

### Evidence of Implementation

**X-5 New-login detect & save:**
- `extension/src/content/login-detector-lib.ts` — Form submit + click-based detection, registration form skipping
- `extension/src/background/login-save.ts` — LOGIN_DETECTED, SAVE_LOGIN, UPDATE_LOGIN handlers with encrypted blob management
- `extension/src/content/ui/save-banner.ts` — Shadow DOM banner UI (save/update/dismiss, 15s auto-dismiss)
- `extension/src/content/form-detector.ts` — Integrates `initLoginDetector()`
- `extension/src/background/index.ts` — Full message handling + pending save push/pull mechanism
- Security: sender.tab.url validation (message.url untrusted), cross-origin push guard (host match check), AAD-bound encryption, pending save TTL 30s + max 5 entries, vault-lock clears all pending saves
- Tests: `login-detector.test.ts` (39 tests), `background-login-save.test.ts` (20 tests), `save-banner.test.ts` (9 tests)
- i18n: `saveBanner.*` keys in en.json/ja.json
- Note: 当初 Proposal の fetch/XHR interception ではなく、form submit capture + click-based detection を採用

**X-3 Context menu (right-click):**
- `extension/src/background/context-menu.ts` — Full implementation (URL matching, entry display, autofill on click, debouncing, open popup, UUID validation on entryId)
- Wired up in `background/index.ts` via `initContextMenu`, `setupContextMenu`, `handleContextMenuClick`, `updateContextMenuForTab`, `invalidateContextMenu`
- `manifest.config.ts` — `contextMenus` permission included
- Tests: `context-menu.test.ts` (14 tests)
- i18n: `contextMenu.*` keys in en.json/ja.json

**X-4 Extension keyboard shortcuts:**
- `extension/manifest.config.ts` — 5 commands defined:
  - `_execute_action` → Cmd+Shift+A (open popup) — Chrome built-in, no custom code needed
  - `copy-password` → Cmd+Shift+P
  - `copy-username` → Cmd+Shift+U
  - `trigger-autofill` → Cmd+Shift+F
  - `lock-vault` → no default key
- `background/index.ts` — `chrome.commands.onCommand.addListener` handles all commands
- Tests: `background-commands.test.ts` (8 tests; `_execute_action` is Chrome-native, no test needed)
- i18n: `_locales/*/messages.json` for manifest, `commands.*` in messages/en.json and ja.json

### Follow-up task (out of scope)

- `trigger-autofill` コマンドのリトライロジック（初回送信失敗 → executeScript → 再送信）のユニットテストが欠如。別タスクとして追加推奨。

## Changes

### 1. Update `docs/architecture/feature-gap-analysis.md`

Mark X-5, X-3, X-4 as completed (strikethrough) in the following sections:

#### Section 2.4 (Browser Extension table)
- ~~X-3~~ Context menu — Implemented
- ~~X-4~~ Extension keyboard shortcuts — Implemented
- ~~X-5~~ New-login detect & save — Implemented

#### Replace existing X-5 note and add implementation notes (like existing X-1 note)

旧ノート「intercept submit / fetch / XMLHttpRequest」を削除し、以下に置換:

- **X-5**: Form submit capture (capture phase) + click-based detection for SPAs. Registration form skipping heuristics. Save/update banner in Shadow DOM (15s auto-dismiss). Pending save push/pull mechanism for post-navigation persistence. Security: sender.tab.url validation (untrusted message.url), cross-origin push guard, AAD-bound encryption, pending save TTL 30s / max 5
- **X-3**: Chrome `contextMenus` API, URL-matched entry listing (max 5), debounced updates on tab switch, autofill on click with UUID validation
- **X-4**: 5 Chrome `commands` (open popup [Chrome-native], copy password, copy username, trigger autofill, lock vault), clipboard auto-clear after 30s

#### Section 3 (Priority Matrix — P1 and P2)
- Move X-5 from "Not started" to completed in P1 table
- Move X-3 and X-4 from P2 to completed

#### Section 4 (Roadmap — Phase 2)
- Mark X-5 as completed, add X-3 and X-4 as completed items
- Update Phase 2 status: "Nearly complete" → "Fully complete"
- Update header: `Remaining: X-5 only` → `Completed: 2026-02-28`

#### Section 5 (Competitor Summary)
- Update "Extension gaps" line — remove "new-login detect/save prompt" and context menu/keyboard shortcuts references
- Remaining gaps: card/address autofill (X-2), TOTP QR capture (X-6)

#### Section 6 (Batch D — Group A)
- Mark all Group A items as completed, note that Group A is now done

### 2. Run extension tests to confirm everything passes

```bash
cd extension && npm test
```

## Verification

1. Run `cd extension && npm test` — all tests should pass (extension全体で約346テスト)
2. Check updated feature-gap-analysis.md against this checklist:
   - [ ] Section 2.4: X-3, X-4, X-5 に取り消し線が適用されている
   - [ ] Section 2.4: 旧 X-5 ノート（fetch/XHR interception）が削除・置換されている
   - [ ] Section 3: P1/P2 テーブルのステータスが completed
   - [ ] Section 4: Phase 2 が fully complete
   - [ ] Section 5: Extension gaps から new-login/context menu/keyboard shortcuts が除去されている
   - [ ] Section 6: Group A が completed と明記されている
3. Optionally `npm run build` in extension/ to confirm build succeeds
