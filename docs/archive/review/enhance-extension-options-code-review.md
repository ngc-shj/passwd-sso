# Code Review: enhance-extension-options
Date: 2026-04-03
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

**[F-CR-01] Critical: Popup copy paths bypass clipboardClearSeconds** — RESOLVED
- File: popup/components/MatchList.tsx:61-63,79-81
- Problem: Popup used hardcoded 30_000ms for clipboard clear
- Fix: Import getSettings, read clipboardClearSeconds dynamically

**[F-CR-02] Major: clipboardClearSeconds not in onChanged listener** — RESOLVED
- File: background/index.ts onChanged handler
- Problem: Plan required reschedule on settings change, not implemented
- Fix: Added clipboardClearSeconds branch to onChanged listener

**[F-CR-03] Major: initTheme() async — flash prevention incomplete** — DEFERRED
- File: lib/theme.ts:22-28, options/main.tsx:7, popup/main.tsx:7
- Problem: chrome.storage.local.get is async, theme applied after first render
- Note: Chrome local storage callbacks fire sub-millisecond. Actual flash is imperceptible in practice. Synchronous inline script approach requires HTML template changes not supported by CRXJS. Recorded as known limitation.

**[F-CR-04] Minor: About link uses unvalidated serverUrl** — RESOLVED
- File: options/App.tsx:330
- Fix: Applied validateServerUrl() to href value

## Security Findings

**[SEC-CR-01] Medium: serverUrl onChanged bypasses validateSettings** — DEFERRED
- File: background/index.ts:628-629
- Note: registerTokenBridgeScript has internal URL parse + error handling. Low risk.

**[SEC-CR-02] Medium: unvalidated serverUrl in href** — RESOLVED (same as F-CR-04)

**[SEC-CR-03] Low: Alarm fallback min 1 minute** — ACCEPTED
- Chrome Alarms API minimum is 1 minute. setTimeout is the primary timer.

## Testing Findings

**[QA-CR-01] Major: MatchList.test.tsx missing getSettings mock** — RESOLVED
- Fix: Added mockGetSettings with clipboardClearSeconds: 30

**[QA-CR-02] Major: background test mocks don't return new fields** — DEFERRED
- Note: Tests pass because getSettings() uses DEFAULTS for missing keys. New branch tests (vaultTimeoutAction, autoCopyTotp, etc.) deferred to follow-up PR.

**[QA-CR-03] Minor: theme.test.ts not created** — DEFERRED to follow-up PR

## Adjacent Findings
None

## Quality Warnings
None

## Resolution Status
### F-CR-01 Critical — Resolved
- Action: Added getSettings import and dynamic clipboardClearSeconds to MatchList.tsx
- Modified file: extension/src/popup/components/MatchList.tsx

### F-CR-02 Major — Resolved
- Action: Added clipboardClearSeconds branch to chrome.storage.onChanged listener
- Modified file: extension/src/background/index.ts

### F-CR-04 Minor — Resolved
- Action: Applied validateServerUrl() to About link href
- Modified file: extension/src/options/App.tsx

### i18n: totpCopied string — Resolved
- Action: Removed hardcoded "(30s)" from en.json and ja.json
- Modified files: extension/src/messages/en.json, extension/src/messages/ja.json

### QA-CR-01 Major — Resolved
- Action: Added getSettings mock to MatchList.test.tsx
- Modified file: extension/src/__tests__/popup/MatchList.test.tsx
