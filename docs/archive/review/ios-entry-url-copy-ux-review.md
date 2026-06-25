# Plan Review: ios-entry-url-copy-ux

Date: 2026-06-26
Review round: 1

## Changes from Previous Round
Initial review (three experts: functionality, security, testing).

## Functionality Findings
- **F1 (Major)** Toast overlay placement under-specified — must attach `.overlay(alignment:.bottom)` to the OUTER `Group` in `body` (EntryDetailView.swift:34/59), not inside the conditionally-rendered `List`, or it scrolls away / wrong stacking context.
- **F2 (Major)** I5 (auto-lock activity on URL tap) is unimplementable with SwiftUI `Link` (no action closure). Must use `Button { autoLockService?.recordActivity(); openURL(url) }` with `@Environment(\.openURL)`. Drop `Link` as an option.
- **F3 (Minor)** I6 contract text "copy button preserved in both branches" contradicts existing `fieldRow` (empty value → `notSetText`, no copy button) and scenario 3. Reword to "non-empty branches".
- **F4 (Minor)** `mailto:` link in a login "URL" field opens Mail not browser; FR1 says "browser". Recommend narrowing login URL row to http/https only. (Converges with S3.)
- **F5 (Minor)** Acceptance vectors omit `HTTPS://` (uppercase), IDN/unicode host, whitespace-wrapped. Swift `URL(string:)` diverges from web `new URL()`. (Converges with T2/T3.)
- **F6 (Minor)** `onChange(autoLockService.state)` lock handler clears `detail` but not the new `showCopyToast` — a stale (non-secret) "Copied!" toast could float over a locked view. Add `showCopyToast = false` to the lock branch.

## Security Findings
- **S1 (Major)** iOS-specific launch vectors not in the (web-inherited) threat model: an `https://` URL can be intercepted by **Universal Links** into another app, so FR1 "opens the system browser" is not guaranteed. Custom schemes (`tel:`/`sms:`/`myapp://`) are correctly excluded by the allowlist — document + add negative test vectors. Decide: accept Universal Link interception (document in Considerations) or force Safari.
- **S2 (Major→Med)** "Lowercased compare" (I1) is load-bearing: Swift `URL(string:).scheme` does NOT lowercase (codebase proves it — `URLMatcher.swift:9` and `ServerURLSetupView.swift:54` both call `.scheme?.lowercased()`). Promote lowercasing from a parenthetical into the contract + acceptance vectors; follow the `URLMatcher.swift:9` precedent.
- **S3 (Minor)** `mailto:` widens surface with no use case for a website-URL field. Narrow login URL row to http/https only (matches existing `URLMatcher` http/https convention). Converges with F4.
- **S4 (Minor)** No length cap on the URL before parse/launch (RS3 boundary incomplete). Reject `> 2048` chars → nil. Cheap.
- **S5 (Minor/confirm)** Verify toast renders a constant `"Copied!"`, never the copied value. Add a forbidden-pattern (interpolated toast) to lock it.
- **S6 (Minor/confirm)** Toast must render INSIDE the `isScreenRecording`-gated body so capture redaction + lock teardown keep covering it. `.allowsHitTesting(false)` already prevents tap interception.
- **S7 (confirm)** Clipboard path unchanged (SecureClipboard funnel, `.localOnly` + expiration). No new exposure. No action.

No Critical findings; no escalation.

## Testing Findings
- **T1 (Major)** SafeURLTests must add web-parity rejection vectors: `data:`, `file:`, `chrome:`, `about:` → nil (web `safe-href.test.ts:16-25` covers them; plan only had `javascript:`/`ftp:`).
- **T2 (Major)** Add case-insensitivity vectors: `HTTPS://example.com` → non-nil, `JavaScript:alert(1)` → nil (proves I1 on both sides). Load-bearing (S2).
- **T3 (Minor)** Add `not a url` → nil and `/relative/path` → nil (web parity, defends I2/NFR1 no-prepend).
- **T4 (Minor)** No anti-drift mechanism between iOS `SafeURLTests` and web `safe-href.test.ts`. Add cross-reference comments in both directions naming the SSoT.
- **T5 (confirm)** VC1/VC2/VC3 untestable classifications correct; no ViewInspector/snapshot dep exists (confirmed `project.yml`), and the pure-predicate factoring is the right seam. No action.
- **T6 (Major)** Manual test doc is the SOLE verification for the two primary user bugs (FR1/FR2/FR3 non-automatable) but is not in the Go/No-Go gate. Add it as a gate row so its absence blocks merge.
- **T7 (Minor)** I5 (auto-lock on URL tap) has no verification path. Add an explicit manual step rather than over-engineering a seam for one call.

## Adjacent Findings
- [Adjacent] (func→test) F5 test-vector completeness — routed to T2/T3.
- [Adjacent] (func→security) javascript: rejection threat adequacy — routed to S1.
- [Adjacent] (test→security) whether data:/file: are dangerous to launch on iOS — answered by S1 (allowlist correct; iOS won't execute javascript:, custom schemes excluded).

## Recurring Issue Check
### Functionality expert
R1-R7 checked; R8 (UI pattern) FLAG — app has no existing toast idiom (only TOTP label-swap); justified because copy buttons are icon-only. R25 clean (shared `fieldRow` untouched — `urlRow` additive in `loginSections`). R39 FLAG → F6. R9-R24, R26-R41 N/A.

### Security expert
R1/R4/R5 (XSS/scheme) — iOS analog; javascript: does NOT execute in SwiftUI Link (OS won't run it) — allowlist exclusion is belt-and-suspenders. R6 (file:) excluded. R38 (deep-link/scheme abuse) core → S1. R36 (privacySensitive) no regression. R39 (Universal Clipboard) blocked by `.localOnly`. R41 (clipboard expiration) preserved. RS3 → SafeURL is the boundary guard (incomplete: S2 lowercase + S4 length cap). RS1 partial (iOS threat delta unstated → S1). RS2/RS4/RS5 OK.

### Testing expert
RT1 PASS (pure predicate seam). RT2/RT3 PASS (untestable correctly classified, no new framework). RT6 PASS (SafeURLTests in same PR). RT7 FAIL → T1/T2/T3 (vector set doesn't match web SSoT). R35 → T6 (manual doc not gated).

---

# Review round: 2 (incremental — verify round-1 fixes)

## Changes from Previous Round
Applied all round-1 findings to the plan: narrowed allowlist to http/https only (S3/F4), explicit lowercased scheme per URLMatcher.swift:9 (S2/T2), 2048-char length cap (S4), full web-parity reject vectors incl. case/data:/file:/chrome:/about:/relative (T1/T2/T3), Button+openURL instead of Link for auto-lock activity (F2), toast on outer Group gated on !isScreenRecording + cleared on lock (F1/F6/S6), forbidden-pattern for interpolated toast (S5), manual-test doc gated as C5 (T6), Universal-Link interception accepted+quantified (S1).

## Round-2 Findings (all resolved or trivial)
- All round-1 findings F1-F6, S1-S7, T1-T7 verified **RESOLVED** by all three experts.
- **F8/S8 (Med/Low)** NFR1 still listed `mailto` as link-eligible — contradicted the http/https-only allowlist. **FIXED** (NFR1 reworded to http/https-only narrowing).
- **F7 (Low)** Self-contradictory "stays INSIDE the swap — wait:" prose in the toast-placement bullet. **FIXED** (rewritten: overlay is a sibling of the swap, hence the explicit `!isScreenRecording` gate).
- **F9 (Low)** FR2 cited bare "isSafeHref behavior". **FIXED** ("rejection behavior, adapted to http/https-only").
- **T9 (Low)** `sms:` reject vector present in C1 acceptance but missing from the Testing-strategy list. **FIXED** (added to both — single canonical vector set).
- S9/S10/S11 — informational confirmations (http: cleartext acceptable=web parity; 2048 cap reasonable, fail-safe; `!isScreenRecording` sufficient since toast text is constant). No action.

## Resolution
Plan converged. No Critical/Major findings open. All four round-2 findings were sub-5-minute doc-consistency edits, applied. Proceeding to Phase 2.
