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
