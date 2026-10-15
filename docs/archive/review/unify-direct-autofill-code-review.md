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
