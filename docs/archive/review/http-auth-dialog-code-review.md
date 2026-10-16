# Code Review: http-auth-dialog (#905)
Date: 2026-10-16
Review round: 1

## Changes from Previous Round
This is the initial review of `900a9815e`..`bda95ed3b`.
- `bda95ed3b` already fixed what the Phase 2 recurring-rule self-check found:
  - prompts left open after a lock;
  - no deadline before the prompt;
  - bindings not tied to the account;
  - the server-URL rule enforced only in the options page;
  - a triplicated id regex;
  - the hygiene wildcard check.
- The copy-path skip is recorded as D9.

## Security Findings
| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| S1 | Major | Click-through. A disabled-button click during the 800 ms arm does not restart it, and stacked prompts open at the same position, so a "click fast" lure can land the first armed click on Send. | The arm restarts on input while disarmed. Send counts only when its pointerdown came after arming. One prompt window at a time, the rest queued. |
| S2 | Major | The undefined-initiator label claims "address bar or bookmark", but a link from another app or a redirect also has no initiator. That falsely reassures in the one row meant to expose an unexpected trigger. | Neutral label. |
| S3 | Minor | A request joining a shared prompt inherits a decision made on another request's displayed facts. | Join only when url, initiator and scheme are equal. |
| S4 | Minor | Prompt flooding and fatigue after Cancel. | Per-origin cooldown after a cross-site-initiated prompt ends. |
| S5 | Minor | A long attacker URL pushes the warning and the buttons below the fold. | Warning and method first; URL truncated. |
| Adj | Minor | Three serverUrl readers skip the server-URL rule. | The rule is applied there too. |

## Functionality Findings
| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| F1 | Major | A throw during registration (network, `HTTPS_REQUIRED`, decrypt) skipped the rollback, leaving permissions with no binding. | Registration is wrapped; rollback runs on any throw. |
| F2 | Minor | `onAdded` never completes an https registration: https origins are already granted by `content_scripts.matches`. | `permissions.contains` on API-permission grants. |
| F3 | Minor | Negative window coordinates were clamped to 0. A `windows.create` failure cancelled with no fallback. | No clamp; retry once without position. |
| F4 | Minor | One failed request cancelled the whole shared prompt. | Only that request is dropped. |
| F5 | Minor | The popup register send had no catch. | Toast on failure. |
| F6 | Minor | A prompt window could outlive a SW restart. | The page closes itself after the prompt timeout. |

## Testing Findings
| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| T1 | Minor | No test that an origin-only `onRemoved` keeps the listener (mutant survived). | Test added. |
| T2 | Minor | The team-binding overview lookup is untested (two mutants survived). | Wiring e2e with a team entry, plus a control. |
| T3 | Minor | The epoch check before the prompt is untested. | Test added. |
| T4 | Minor | No control that closing another tab leaves the prompt pending. | Control added. |
| T5 | Minor | The "never autofocused" test is vacuous. | Focus spy. |
| T6 | Low | The rule-6 tests deny through the account check. | Unlock-only denial. |
| T7 | Low | Unpinned branches (after-Send teamId, LRU bound, onErrorOccurred wiring, visibility re-arm, create without an id, incognito undefined); loosely typed deps. | Tests added; typed deps. |
| Adj | Minor | The hygiene check hard-codes the prompt path; `resourceCovers` has no self-test. | Shared constant; fixtures. |

## Verified without findings
- **Decrypt order:** the full decrypt runs strictly after Send, with rules 4 and 9 re-checked first.
- **Prompt ids:** unguessable, settled once.
- **Page exposure:** the page is not web-accessible.
- **Activity:** prompt messages do not register it.
- **Server-URL rule:** no regression for valid stored URLs. It is identical to the options validator.
- **C7 extraction:** behaviour unchanged.
- **i18n:** key parity holds.

## Round 2 (verifying `edac5b17b`)
All round-1 resolutions were verified correct. T1–T7 each fail for the reason they claim. The new findings are Minor or Low only.

| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| S-R2-1 | Minor | Prompts already queued are still shown inside an origin's cooldown. | `showNext` cancels a queued cross-site prompt for an origin in cooldown. |
| S-R2-2 | Minor | Only the last cross-origin redirect hop is shown, so an attacker can choose the displayed source. | The first source is kept. |
| S-R2-3 | Minor | A cross-site page can keep the cooldown armed and suppress the user's own address-bar login. | The cooldown never applies to a challenge with no initiator. |
| S-R2-4 | Low | Tab to Send then Space needs no pause. | The arm restarts when Send gains focus. |
| F-R2-1 | Low | Assistive-tech activation (a click with no preceding press) cannot send. | A `detail === 0` click counts while armed and focused; the press flag resets on disarm. |
| F-R2-2 | Low | Long initiator and redirect rows push the buttons out of view. | Rows capped; sticky button row. |
| F-R2-3 / T-R2-3 | Minor | The join rule ignores `redirectedFrom`. | The join compares every view field. |
| T-R2-1 | Minor | The shown-only checks for a queued prompt are untested. | Test with the queued id. |
| T-R2-2 | Minor | Removing a settled prompt from the queue is untested; a regression would wedge HTTP auth. | Test, including the decide step. |
| T-R2-4 | Minor | The `aria-disabled` choice (S1) is unpinned. | Asserted, with the jsdom caveat. |
| T-R2-5 | Low | The script's use of the exposure filter is untested. | Moved into the lib and tested with manifest fixtures. |
| T-R2-6 | Low | The bridge's server-URL check argument is unpinned. | `toHaveBeenCalledWith` the stored URL. |
| T-R2-7 | Low | The queued-timeout test fails only by hanging. | Explicit settle assertions. |

**Stopping call.** Round 2 found nothing above Minor. Its fixes change only test code and narrow existing behaviour; no new feature surface is added. Per the review-loop stopping rule, there is no round 3. The next check is the manual run (VE1).

## Manual verification (VE1)
The user ran these on a build of `2685a2f98` in Chrome (macOS, z1mn). Test servers: go-httpbin on the tailnet (http `:8080`, https through tailscale `:10000`).

- **http Basic, real device.** A Yamaha RTX840 router logged in after registration, confirmation and Send.
- **http Basic, test server.** Registration shows the cleartext warning and the permission prompt. The confirmation window shows the method, site, address, the neutral initiator label and the login. Send logs in.
- **Send arming.** Send stays inactive until the window has focus and 800 ms pass; a click inside the window first is needed when it opens unfocused. This works as designed, though the first-time UX is not obvious.
- **Registration from a different port.** Registering from a page on another port of the same host (`:8767`) is refused with `HTTP_AUTH_ENTRY_MISMATCH`. This is correct: the exact-origin rule applies.
- **Cross-site iframe.** A cross-site page embedding the bound URL in an iframe gets no confirmation window; Chrome's own dialog shows.
- **Cancel; wrong password; SW stopped; locked vault; binding removed.** The user reported all of these as passing:
  - Cancel falls through to Chrome's dialog;
  - a wrong password gets a single answer, then Chrome's dialog, with no loop;
  - after stopping the SW in chrome://serviceworker-internals, the confirmation still shows;
  - with the vault locked, no confirmation shows;
  - after removing the binding, Chrome's dialog shows again and the site permission is gone.
- **https Digest** (`:10000`):
  - registration showed no permission prompt (the API permissions were already granted, and https origins are covered by `content_scripts.matches`), which exercises the F2 completion;
  - the confirmation showed "Digest" with no http warning;
  - Send gave `"authorized": true`.

VE1 status: **verified**.

**Environment note.** The local `node_modules` on one host had an older `@types/chrome` than the lockfile. `npm ci` fixed it, and the build passes on 0.3.5 from the lockfile.
