# Plan: iOS tap-target sizing (HIG 44×44pt)

## Project context
- Type: `mixed` — native iOS app (Swift/SwiftUI, xcodegen).
- Test infrastructure: `unit tests only` (PasswdSSOTests; logic-level). SwiftUI hit-target
  geometry is NOT unit-testable in this project (no ViewInspector/snapshot harness). Per Phase-1
  project-context rule, "add a snapshot test framework" findings are downgraded to Minor notes;
  verification is build + manual/visual + the existing logic suite staying green.

## Objective
Bring interactive controls up to Apple HIG's 44×44pt minimum tap target. On-device, every control
except the server-URL `TextField` feels too small. The URL field is the agreed baseline (it uses
`.padding()` ≈ 52pt height + rounded background); align the other controls to comparable comfort.

## Requirements
Functional:
- Every tappable control reaches ≥44pt in its smaller dimension (height for full-width buttons;
  both dimensions for icon-only buttons).
- No behavior change — only sizing/hit-area. Labels, actions, disabled logic unchanged.
- No layout regression (no clipping, no broken alignment, Dynamic Type still works).

Non-functional:
- Consistent idioms, not ad-hoc per-site tweaks: one idiom for standalone buttons, one for
  icon-only buttons, one for the passphrase field (match the URL baseline).

## Technical approach (idioms)
1. **Standalone bordered buttons** → add `.controlSize(.large)` (yields ≈50pt height, ≥44pt).
   Sites: ServerURLSetupView (Continue), SignInView (Sign in, DEBUG vault), VaultUnlockView
   (Unlock), TOTPCodeView (Copy), RootView (Sign in again), EntryDetailView (Retry),
   LockedFallbackView (Open passwd-sso), CredentialPickerView app-side sheet (**Fill AND Cancel** —
   F1: the destructive `Button("Cancel", role: .cancel)` at CredentialPickerView.swift:110 is a
   *body* button in the sheet, NOT a toolbar `cancellationAction`, so the toolbar-exemption does not
   cover it; it is sub-44pt and must be enlarged too).
2. **Icon-only buttons** — EntryDetailView has **three** sites (F2): `fieldRow` copy (~:156),
   `passwordRow` eye (~:181), `passwordRow` copy (~:190). Give each label a `.frame(minWidth: 44,
   minHeight: 44)` + `.contentShape(Rectangle())` so the whole 44×44 box is tappable; drop
   `.imageScale(.small)` (use default scale). Keep `.buttonStyle(.plain)` and `.tint`.
3. **Passphrase SecureField** (VaultUnlockView) → replace `.textFieldStyle(.roundedBorder)` with the
   URL-field baseline treatment: `.padding()` + `.background(Color(.secondarySystemBackground))` +
   `.clipShape(RoundedRectangle(cornerRadius: 10))`. (Two custom fields total — inline, no shared
   modifier per the "extract after 3rd duplication" rule.)

Out of scope / intentionally untouched:
- VaultListView entry rows, CredentialPickerView/OneTimeCodePickerView list rows: List enforces a
  ~44pt min row height and the `NavigationLink`/row `Button` spans the full row width — tap area is
  already adequate.
- EntryEditForm: `Form` rows are system-sized (~44pt) and the form is currently behind the disabled
  edit gate (#528). Touching it risks entangling #528 scope; not a violation, so left alone.
- Toolbar buttons (Lock, Edit, Cancel, Save): system toolbar items already meet HIG.

## Contracts

### C1 — Standalone buttons ≥44pt (locked)
- Every standalone `.bordered`/`.borderedProminent` button listed in approach §1 gains
  `.controlSize(.large)`.
- Acceptance: build succeeds; visual check shows each button ≥44pt tall. Forbidden pattern check:
  none of the listed buttons remain at default control size (grep the diff for the added modifier
  on each site).

### C2 — Icon buttons get a 44×44 hit area (locked)
- All THREE EntryDetailView icon buttons (fieldRow copy, password eye, password copy): label
  wrapped to `.frame(minWidth: 44, minHeight: 44)` + `.contentShape(Rectangle())`;
  `.imageScale(.small)` removed.
- Acceptance: build succeeds; the full 44×44 region is tappable (visual/manual). No change to copy
  or reveal behavior (same actions, same `autoLockService.recordActivity()` calls). Positive check:
  the diff adds exactly three `minHeight: 44` icon-button frames in EntryDetailView (not just
  removing `.imageScale`). Row height increasing to reach 44pt is the intended success condition
  (F4), not a regression.
- F3 (iPhone SE): `passwordRow` carries two trailing 44pt buttons (eye + copy = 88pt). The greedy
  leading value `Text`/`SecureField` truncates before the buttons clip, so layout holds — but C4's
  manual check must confirm no clipping on iPhone SE in both masked and revealed states.
- Forbidden patterns:
  - `pattern: imageScale(.small)` in EntryDetailView.swift — reason: small scale is the symptom;
    must be gone after the fix.

### C3 — Passphrase field matches the URL baseline (locked)
- VaultUnlockView SecureField uses the same `.padding()/.background()/.clipShape()` treatment as the
  URL field (no `.roundedBorder`).
- Acceptance: build succeeds; passphrase field height ≈ URL field height; `.textContentType(.password)`
  and `.onSubmit` unlock behavior preserved.

### C4 — No regression (locked)
- `xcodegen generate` + `build-for-testing` + `test-without-building` all pass; 233 unit + 2 UI
  tests green (one UI test added per T2). No new compiler warnings (project builds warnings-as-errors).
- iPhone SE manual check (F3): password row does not clip in masked or revealed state.

## Testing strategy (honest verification tiers — T1/T3)
The logic suite does NOT exercise these views (no test imports SwiftUI; grep-confirmed), so a green
suite does not "prove no behavior edit" of the touched files. The real guards, decreasing in strength:
1. **Automated, load-bearing**: `build-for-testing` compiling (warnings-as-errors) — proves the
   modifier-only edits are valid and dropped no referenced symbol/`action:`/`.disabled()` clause.
   This is the primary automatic guard, NOT the test suite.
2. **Automated, indirect**: 233 logic tests + the launch smoke test stay green — proves *unrelated*
   logic is untouched and the two launch-root views (`ServerURLSetupView`/`SignInView`) still render.
   The existing `testAppLaunches` is a launch smoke test (asserts the "passwd-sso" `staticText`); it
   does not measure geometry.
3. **New lightweight UI test (T2)**: add one `PasswdSSOUITests` test that taps/asserts the
   `ServerURLSetupView` "Continue" button is present, labeled, and hittable after `.controlSize(.large)`
   — catches the realistic regression (button removed/mislabeled/made non-interactive) for the most
   reachable resized control. It asserts hittability, NOT pixel height (geometry stays manual —
   measuring 44pt would need a snapshot/ViewInspector harness, out of scope per project context).
4. **Manual only**: actual 44pt sizing, hit-area, no-clipping (incl. iPhone SE), Dynamic Type —
   verified visually on device/sim. "verified" for the sizing claim means manually verified.

## Considerations & constraints
- `.controlSize(.large)` is the idiomatic, Dynamic-Type-friendly way to enlarge buttons; it scales
  with text size rather than hardcoding a frame.
- Avoid hardcoded `.frame(height: 44)` on text-bearing buttons — it fights Dynamic Type. Use
  controlSize for buttons; explicit 44×44 frame only for icon-only buttons that have no text to
  drive intrinsic height.

## User operation scenarios
- Tap "Unlock" / "Sign in" / "Continue" with a thumb → comfortable hit, no mis-tap.
- Tap the copy/eye icon next to a password → registers anywhere in a 44×44 box, not just the glyph.
- Passphrase field is as easy to tap into as the URL field.

## Round 1 Review Resolutions (triangulate)
- **F1 (Major) → fixed**: app-side sheet `Button("Cancel", role: .cancel)` (a body button, not a
  toolbar item) was missing from the offender list → added `.controlSize(.large)`.
- **F2 → fixed**: EntryDetailView has three icon buttons (not two) → all three wrapped (verified:
  `imageScale(.small)`=0, `minHeight: 44`=3).
- **F3 → noted**: iPhone-SE two-button password row manual check added to C4.
- **F4 → noted**: row-height increase is the intended success condition, not a regression.
- **T1/T3 → fixed**: verification reworded into honest tiers — compilation is the load-bearing
  automatic guard; the logic suite does not exercise these views; sizing is manual-only.
- **T2 → fixed**: added one lightweight UI hittability test on the launch primary CTA.
- **Security**: N/A — change touches only SwiftUI sizing modifiers; no auth/data/crypto/input
  surface. No security expert run (no surface to review).

## Go/No-Go Gate
| ID  | Subject                                  | Status |
|-----|------------------------------------------|--------|
| C1  | Standalone buttons → controlSize(.large) | locked |
| C2  | Icon buttons → 44×44 contentShape        | locked |
| C3  | Passphrase field → URL baseline          | locked |
| C4  | No build/test regression                 | locked |
