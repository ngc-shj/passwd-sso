# Code Review: ios-entry-url-copy-ux

Date: 2026-06-26
Review round: 1 (incremental — on top of Phase 2 self-R-check baseline)

## Changes from Previous Round
Initial code review of the Phase 2 implementation (SafeURL.launchable + tappable
urlRow + copy toast/haptic). Branch rebased onto origin/main (incl. #609, which
made `autoLockService` optional).

## Functionality Findings
- **F1 (Minor — accepted by plan)** Rapid repeated copies each schedule an independent 1.5 s reset Task; an earlier task can hide the toast while a later copy should keep it visible. Cosmetic flicker only, no leak. Mirrors the untested `TOTPCodeView.copyConfirmed` pattern the plan explicitly accepts (VC3). No fix.
- **F2 (Minor — accepted)** Toast reset Task not cancelled on `onDisappear`; matches `TOTPCodeView`. Worst case is a no-op `withAnimation` write post-dismiss; lock-clear path covers the security-relevant case. No fix.
- **F3 (Nit)** In `urlRow`'s safe branch the `Button` wraps only `Text(url)` (Spacer is an HStack sibling), so the tap target is text-width, not full-row. Intentional — keeps the copy button's tap region separate; consistent with `fieldRow`. No fix.

Contracts C1–C5 and invariants I1–I8 all verified against the diff. All 4 forbidden patterns absent.

## Security Findings
No findings. SafeURL.launchable correctly: lowercases scheme (matches URLMatcher.swift:9), http/https-only, length-caps before parse (2048), never prepends a scheme. Toast text is constant `"Copied!"` (no value interpolation, no logging). Clipboard funnel unchanged (SecureClipboard localOnly+expiration; no UIPasteboard.setItems added). `openURL` reached only inside the `if let launchable = SafeURL.launchable(url)` guard. Screen-recording redaction and lock zeroization intact.

## Testing Findings
No findings. SafeURLTests asserts the full plan parity set (accept http/https + uppercase; reject javascript/JavaScript/data/file/chrome/about/ftp/mailto/tel/sms/myapp; reject example.com/not-a-url/relative/empty; reject >2048). Accept/reject split into separate methods. RT7 prove-red structurally supported (and was demonstrated: dropping `.lowercased()` reds `testAcceptsUppercaseScheme`). RT6 satisfied (export + test in same diff). `testRejectsOverlongURL` builds a genuine 2068-char string exercising the length cap, not the parse — non-vacuous. Manual-test doc (C5) complete (Pre-conditions/Steps/Expected/Rollback, FR1-FR4 + I5b + screen-recording), gated. Web cross-ref comment reciprocal with no-mailto divergence noted.

## Adjacent Findings
- [Adjacent] (func→test) SafeURLTests `not a url` relies on Foundation `URL(string:)` leniency, but the scheme-allowlist guard makes the test robust regardless of OS-version parsing shifts. No action.
- [Adjacent] (test→security) SC-univlink (Universal Link interception) is a design-approved accepted risk, not a test concern.

## Recurring Issue Check
### Functionality expert
R8 (UI consistency): clean — copy button reuses the exact doc.on.doc/44pt/.plain/.accentColor idiom. R19/R25/R39: clean (R25 optional handling — no force-unwrap; R39 toast cleared on lock). Others N/A for this UI diff.
### Security expert
RS3 (boundary length cap): satisfied. RS5 (scheme smuggling / case bypass): satisfied + tested. R39 (zeroization on lock): satisfied. Others N/A.
### Testing expert
RT1 (mock-reality/vacuous): clean (pure tests, overlong vector genuinely >cap). RT6 (export ships with test): clean. RT7 (prove-red): clean. R35 (manual-test gating): clean. Others N/A.

## Environment Verification Report
Per the plan's Phase-1 `Verification environment constraints`:
- VC1 (browser launch via openURL) — `blocked-deferred` for automation; `verified-local` design via the pure SafeURL predicate (SafeURLTests green); OS launch covered by the C5 manual-test doc (FR1). Linked to plan VC1.
- VC2 (haptic) — `blocked-deferred`: no Taptic in simulator. Linked to plan VC2 / SC-cost. Device-manual step in C5.
- VC3 (toast timing) — `blocked-deferred` for unit assertion (real-time wait); toast state transition exercised manually (C5 FR3/FR4). Linked to plan VC3.
All three blocked-deferred paths link to a Phase-1 constraint entry — no un-justified skips.

## Resolution Status
All findings are accepted-by-plan Minor/Nit; no code changes required in review.
- F1/F2/F3: accepted (see Functionality Findings rationale). No Anti-Deferral entry needed — these are not deferred fixes but design decisions recorded in the plan (VC3, TOTPCodeView parity).
- Tests: 634/634 iOS XCTest pass; 5/5 web safe-href vitest pass. Build green (compiled via xcodebuild test). RT7 prove-red demonstrated and reverted.

Code review converged in 1 round.
