# Code Review: unify-direct-autofill (#878)
Date: 2026-10-15
Review round: 1

## Scope
The removal of the LOGIN `directAutofill` twin (`238b52aa5`) and its test migration (`8860af729`). Three expert sub-agents reviewed the diff against `unify-direct-autofill-plan.md` and ran mutations on scratch copies.

## Functionality Findings

| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| F1 | Minor | A probe that found no usable document returned `AUTOFILL_INJECT_FAILED` (or `ORIGIN_MISMATCH`) outside the fallback's catch, so a lock while the probe ran did not read as `VAULT_LOCKED`. This was pre-existing; it applied to the LOGIN path and to `deliverToRequester`. | Every early return after a `pinDocument()` checks the vault epoch first: the context-menu first probe, the LOGIN fallback probe, and both probes in `deliverToRequester`. Each one has a lock test and a control. All the lock tests are red on the pre-fix code. |
| F2 | Minor | `docs/architecture/extension-token-bridge.md` still listed the deleted `webauthn-inject.ts`. | The row now points at the `registerContentScripts` block in `background/index.ts`. |

## Security Findings

No findings. Checked:
- no `executeScript` carries a secret;
- every send and resend is pinned to the origin-checked document;
- `isInBundleScope` stays URL-based;
- epoch checks come before every send and before the TOTP copy;
- failure codes are fixed strings.

## Testing Findings

| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| T-1 | Minor | The hidden-type custom-field test was a lone negative, so it would pass if the custom-field step never ran. | It became a pair: hidden is not written, while text with the same label is. The control is red when the custom field is dropped from the payload. |
| (self) | Minor | The moved "custom-field reservation" row used a label (`brchNum`) that is never username-like, so it passed with the reservation removed. | The fixture now uses a username-like custom field (`member-id`) nearest the password, with a separate username field. The test is red when the reservation is removed. |

## Noted, not changed here

Two reviewers each raised this from reading the code; neither reproduced it in a browser:
- **Mechanism:** the content `AUTOFILL_FILL` listener never calls `sendResponse`, so the background cannot tell "filled" from "refused" (for example, a frame that fails `isFrameAllowedToFill`).
- **Effect:** when a frame refuses, the fill can report `ok`, and with auto-copy on, it can copy the TOTP although nothing was written. The code is the user's own and goes to their own clipboard.
- **Not a regression:** `main` behaves the same, and so do the CC and Identity fills.
- **Next step:** VE2 scenarios 1 and 2 also check the popup's success toast and the TOTP copy. A listener that answers fill or refuse is the candidate fix.

## Recurring Issue Check
- **Functionality:** R3 (F1 applies to both delivery paths, and both were fixed); R42 (the early-return member set is the four `pinDocument` sites).
- **Security:** RS3 OK; R29 OK.
- **Testing:** RT7 (T-1, and the self finding); RT10 (the lock arms pair with controls that use the same fixed wait where no outcome is observable).
- **Others:** OK or n/a.

## Environment Verification Report
- **Unit tests:** 2100 passed. `tsc`, `typecheck:test` and the extension build all pass.
- **VE2:** blocked-deferred to the user's manual check before merge (plan scenarios 1–4).

## Round 2: C3–C5 (http fill, http-scheme gate, fill result)

The VE2 check found the popup contradicting itself on an http page, and an external security review then raised the scheme-less host match (Medium) and the unanswered fill (Low). The user chose to fix both here: C3 (`3b90cac70`), C4 and C5 (`af7e11bc0`). Two reviewers then checked those commits.

| ID | Expert | Severity | Finding | Resolution |
|----|--------|----------|---------|------------|
| F1 | Sec/Func | Major | A tab-wide send reports no receiver only when no frame listens, so an in-scope iframe hid a top document with no listener (an http top page, an orphaned https top frame), and no inject-and-resend ran. | After a broadcast with no `filled > 0`, one send pinned to the top frame's probed document; only its no-receiver rejection injects and resends (plan C5). |
| F2 / T6 | Sec/Func, Test | Minor | Chrome ends a send whose receivers all stay silent with a "message port closed" rejection, which the code read as a failure, not "nothing filled". | That rejection counts as no answer on every judged send. |
| F3 | Sec/Func | Minor | Two frames with targets: a `{ filled: 0 }` can win over a frame that wrote. | Accepted cost, recorded in plan C5 (fail-closed). |
| F4 | Sec/Func | Minor | Failure returns after the fetch/decrypt skipped the lock check (pre-existing). | One epoch check right after the decrypt. |
| F5 | Sec/Func | Minor | The content-side insecure check read only `location.href`, missing an about:blank inheriting http. | It also reads `self.origin`, as the background does. |
| (obs) | Test | Minor | A content request from an http page reached the content gate with no background C4 check. | The CONTENT request origin carries `senderUrl`; the popup's pre-check covers it. |
| T1 | Test | High | `npx vitest run` exited 1: an unchanged test called the CC/Identity listeners without `sendResponse` (the summary line still read "passed"). | The test passes one and pins each listener's answer on a throw. |
| T2–T5, T7 | Test | Medium/Low | The http-host match, the url-type filter, the content host match, the probed-origin arm, and the CC/Identity supersede had no deny row. | Deny rows added; each red under its mutation. |

Every fix was red-proved on a scratch copy (19 reverts). The full suite exits 0 (2245 tests); `tsc`, `typecheck:test` and the build pass.

**VE2** covers what unit tests cannot: which rejection a silent broadcast produces in Chrome, the F1 pinned send on a page with an https iframe, and the fill-only script on an http page.

## Round 3 (external review)

| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| X1 | Low | `filled` counted claimed fields, not writes: `written.add` came before `step.write`, and a select with no matching option changes nothing, so a form of only unmatched selects answered `{ filled: 2 }`; a throwing write was counted too. | `FillStep.write` returns whether the field took the value (the select setters return false on no match); the claim set stays for write-once, and a separate count increments only after a write that took. Tests: a write reporting false or throwing is not counted (each with a control); identity selects with no match answer 0 (control 2); a CC expiry select with no match is not counted (control 2). Each red when reverted on a scratch copy. |
| X2 | Low | An input write always counted: a value the input's type rejects (a postcode in `type=number`, `01/15/1990` in `type=date`, a spaced card number in `type=number`) is sanitized to "" without an error. | `setInputValue` (LOGIN, CC, Identity) returns whether the value was taken, read right after the native setter and before any event: not taken only when a non-empty value left the field empty. Exact equality is not used, because the browser also normalizes accepted values. Tests: identity number/date inputs answer 0 (control 2); a spaced card number in `type=number` answers 0 (control 1); both red when the check is reverted. |
