# Code Review: autofill-sequential-fill

Date: 2026-10-10
Review round: 1

## Changes from Previous Round

Initial code review. Phase 2's self-R-check findings were already fixed in `8fb03c561` (see the deviation log, "Step 2-5 self-R-check dispositions").

## Functionality Findings

- **F1 [Major]:** a focused or hinted OTP field was claimed by the username step, so the TOTP was never written. Single and split OTP were both affected, a regression against `main`.
  - Resolved: OTP targets are reserved before the username is chosen (D10).
  - Rows: focused single OTP, focused first box of a split group, a reserved OTP next to a real username field, and an unfocused page whose OTP is labelled like an account field.
  - Red-proven per clause: the focused exclusion, the hinted exclusion, and the exclusion from the candidate list.
- **F2 [Minor]:** the deadline handler could run before `performance.now()` reached the deadline, leaving the run non-terminal.
  - Resolved: the deadline is monotonic and the delay is rounded up (D11).
  - Row: the handler runs inside a write while the clock stays short; the run must exit and release once. Red with the monotonic flag removed.
- **F3 [Minor]:** a waiting step was woken only by a DOM mutation, so a CSS-only reveal was abandoned.
  - Resolved: a 100 ms poll while any step is waiting, which only schedules (D11).
  - Paired rows: acceptable at 300 ms gets written; acceptable after the deadline does not. Red with the poll removed.
- **F4 [Minor]:** `content-bundle.ts` was not declared.
  - Resolved: D9.
- **F5 [Minor]:** a shared T0 element flipped last-wins to first-wins and kept the run open.
  - Resolved: first-wins is now the stated rule, and a later step that owns nothing is abandoned at once (D10).
  - Row: the run settles in its first tasks. Red with the duplicate check removed.

## Security Findings

- **S1 [Major]:** the resend loop and the LOGIN `func` delivered by `frameId` to whatever document arrived during the window. The rationale for leaving this unpinned (SC3) was incorrect.
  - Resolved: a probe pins one `documentId`. The bundle, every resend, and the LOGIN `func` go to that document. An unpinnable frame (two documents, an empty id, no document) fails closed (D9).
  - Red-proven against seven mutants: LOGIN resend by frame, CC resend by frame, bundle by frame target, `func` by frame target, scope gate removed, single-document check removed, empty id accepted.
- **S2 [Minor]:** the now-working injection could reach `http://` pages through `activeTab`, and only an incidental denial of the web-accessible resource prevented it.
  - Resolved: the bundle goes only to documents inside its manifest `content_scripts.matches` (D9).
  - Rows: https and `http://localhost` are injected; `http://` and `about:blank` are refused. There are also `matchesPattern` unit rows.

## Testing Findings

- **T1 [Major]:** the per-kind re-selection rows asserted only the final value, so a run without supersession (the first entry written, then overwritten) passed.
  - Resolved: each row logs the late field's `input` events and asserts that only the second value was written.
  - Each row is red with the new-run supersession deleted.
- **T2 [Minor]:** the comparison at exactly the deadline was unpinned.
  - Resolved: paired rows with windows of 0 and 1 and a deferred step that resolves on the first task. Red with `>=` changed to `>`.
- **T3 [Minor]:** capture-phase registration was untested.
  - Resolved: the row asserts capture `true` on add, and removal of the same function. Red without capture.
- **T4 [Minor]:** the Identity FR4 deny row lacked a positive precondition.
  - Resolved: it asserts that the earlier fill wrote the name.

## Adjacent Findings

None.

## Quality Warnings

None.

## Recurring Issue Check

Phase 2 Step 2-5 covered R1–R57, RS1–RS6 and RT1–RT11 (deviation log). This round's experts additionally applied R3, R29, R38, R39, R41, R42, R43, R48, R49 and R52.

## Resolution Status

Every round 1 finding is resolved, and every new row is red-proven on a scratch copy.
