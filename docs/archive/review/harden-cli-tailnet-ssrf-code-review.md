# Code Review: harden-cli-tailnet-ssrf

Date: 2026-08-01
Review round: 1

## Changes from Previous Round

Initial code review. Phase 2 had already run a focused R1-R50 (+RS/RT) self-check and fixed its five findings (D7), so this round operated as incremental verification. Ollama pre-screening returned `No findings` for the security perspective; that was treated as an unproven signal, not evidence of safety, and each expert ran its own full check.

## Convergence map

| Merged | Reported by | Severity floor |
|--------|-------------|----------------|
| `wouldIpBeAllowed` not updated for C5's new denial axis | F1 (functionality) + S2 (security) | Major, `convergent: functionality+security` |

## Functionality Findings

- **F1 [Major]** `wouldIpBeAllowed` (`access-restriction.ts`) — the self-lockout preview behind the policy PATCH endpoint returns `true` unconditionally whenever `tailscaleEnabled`, on the pre-C5 reasoning that a tailnet could not be verified synchronously. After C5 that shortcut clears exactly the save that locks the admin out. *(convergent with S2)*
- **F2 [Major]** `check-cli-shell-safety.mjs` — D7's `flowsIntoShellQuote` treated *any* template literal passed to `shellQuote()` as needing its own interpolations quoted. Reproduced with a fixture: `PATH=${shellQuote(\`${dir}/${name}\`)}` is flagged, and the "compliant" form the gate demands embeds literal quote characters and breaks the shell parse. A false positive with no correct discharge is worse than the miss it replaced.

## Security Findings

- **S1 [Major]** The gate is evaded by one further hop of indirection in both rules — an alias of an alias, a function return, an array element (Rule B), and a `const` holding `"cmd"` (Rule A). Reproduced against the real gate with four fixtures, all exiting 0. No shipped code uses these shapes, so there is no live vulnerability; the issue is that I3.1 asserts the gate *is* the coverage claim.
- **S2 [Major]** Same as F1, reached from the trust-boundary side. *(convergent with F1)*
- **S3 [Major]** `parseGroups` in `ip-access.ts` validates a group with `parseInt(g, 16)`, which stops at the first unreadable character instead of rejecting the token: `parseIpv6Bytes("1.2:0:0:0:0:0:0:1")` returns a valid-looking 16 bytes where `net.isIP` returns 0. Pre-existing, but D1 made this parser the adjudication authority for a security decision and exported it, and `isIpInCidr` feeds it raw `X-Forwarded-For` text with no `net.isIP` gate.

Security expert verified and found no issue on: C1's `rundll32` argv safety (no URL satisfying C2 can carry argv-boundary content; `windowsVerbatimArguments` is never set), C2's regexes against IDNA / percent-encoding / trailing-dot / `..` inputs, C3's double quoting against the full adversarial set through a real `/bin/sh` including a trap-firing test with a decoy file, C4's `/96`-vs-`/48` split, C5/C8's boundary direction, RS4, and all six RFC citations added by the diff (fetched and checked).

## Testing Findings

- **T1 [Major]** D7's R3 fix (`IPV6_SIMPLE_REGEX` admitting dots) has no differentiating test — the four cases R43 added exercise `isIpInCidr`, not `isValidIpAddress`, so the suite passes identically with the regex reverted.
- **T2 [Minor]** `"denies fail-closed when tailscaled is unreachable"` duplicates the mismatch test's setup and asserts less; `checkAccessRestriction` cannot distinguish the two causes, so the name promises coverage the suite does not have.

Testing expert verified by mutation on throwaway copies (production source never touched) that the `browserLaunchCommand` platform matrix, the NAT64 vectors including the public-embedded negative case, the C5 denial/allow cases, the i18n copy test, and every gate self-test fixture are non-vacuous; and confirmed each new test's CI job and path filter.

## Adjacent Findings

None raised this round.

## Quality Warnings

None. Every finding carried reproduction evidence: F2, S1 and S3 were each demonstrated by running the real gate or the real exported function against a fixture rather than argued from reading.

## Resolution Status — Round 1

### F1 + S2 [Major] `wouldIpBeAllowed` predicted the old verdict
- Action: extracted `evaluateAccessPolicy(policy, clientIp)` from `checkAccessRestriction` and made both the adjudicator and the preview call it. `wouldIpBeAllowed` is now `async` and returns the real verdict for the unsaved policy. This is the same collapse C5 performed for the adjudicators, applied to the predictor: a preview that re-implements the decision is a second adjudicator by another name, and it drifted the moment C5 landed.
- Modified: `src/lib/auth/policy/access-restriction.ts`, `src/app/api/tenant/policy/route.ts:811` (now awaits), `src/__tests__/lib/access-restriction.test.ts` (three new cases: pinned tailnet that fails verification → false, that verifies → true, no pinned tailnet → CGNAT-only with `verifyTailscalePeer` not called).

### F2 [Major] Rule B demanded a fix that corrupts the value
- Action: retargeted the rule from "flows into `shellQuote()`" to "becomes a **trap body**". The trap case needs both levels because the body is parsed twice — once when the `trap` line is read, again when it fires — while quoting a composed value once is the correct idiom everywhere else. `PATH=${shellQuote(\`${dir}/${name}\`)}` is no longer flagged; the composed-trap regression still is.
- Modified: `scripts/checks/check-cli-shell-safety.mjs` (`findTrapBodies` / `isTrapBody` replace `shellQuotedBindingNames` / `flowsIntoShellQuote`).

### S1 [Major] The gate is evaded by a second hop
- Action: the limit is now stated at the function rather than implied away — the rule follows one hop, by name rather than by resolved binding, and is a tripwire for the shape the codebase uses. Full data-flow closure was not built: it is disproportionate to the class, and the guarantee that the shipped emissions are correct comes from the tests that fire the real trap line through a real shell, not from the gate alone. I3.1's "the gate is the coverage claim" is accordingly narrowed in the deviation log.
- Modified: `scripts/checks/check-cli-shell-safety.mjs` (documented limit).

### S3 [Major] The shared parser coerced malformed text into an address
- Action: `parseGroups` now requires the whole token to match `/^[0-9a-fA-F]{1,4}$/`. `parseIpv6Bytes("1.2:0:0:0:0:0:0:1")` returns null, agreeing with `net.isIP`.
- Modified: `src/lib/auth/policy/ip-access.ts`, plus a regression case in `ip-access.test.ts`.

### T1 [Major] The regex fix had no differentiating test
- Action: added `isValidIpAddress("64:ff9b::169.254.169.254")` → true (fails with the regex reverted) and the malformed-fragment case that pins S3's fix.
- Modified: `src/lib/auth/policy/ip-access.test.ts`.

### T2 [Minor] A test named for coverage it did not have
- Action: renamed to state what it pins — that any false verdict from `verifyTailscalePeer` propagates to the same denial — and strengthened it to assert the full result including the reason.
- Modified: `src/lib/auth/policy/access-restriction.test.ts`.

No finding was skipped, accepted or deferred; the Anti-Deferral format is not exercised.

## Environment Verification Report

| Constraint | Path | Classification |
|-----------|------|----------------|
| VE1 (no Windows runner) | `browserLaunchCommand`'s win32 argv vector | `verified-CI` — asserted as a pure function from Linux, and mutation-proven against the old `cmd /c start` vector. A real `rundll32` launch remains `blocked-deferred`; the fallback if it misbehaves is `explorer.exe`, also shell-free, never a return to `cmd`. |
| VE2 (no tailscaled on CI) | WhoIs verdict propagation | `verified-CI` via a mocked transport whose shape matches `WhoIsResponse`. Real two-tailnet isolation remains `blocked-deferred` — it needs two Tailscale accounts. |
| VE3 (no NAT64 network) | NAT64 classification | `verified-CI` by address-classification unit tests over literal addresses, including the public-embedded negative case. End-to-end delivery through a real NAT64 gateway remains `blocked-deferred`. |
| VE4 (proxy runtime) | C5's Node-runtime premise | `verified-local` — `npx next build` plus manifest/NFT inspection; recorded in the deviation log. |

## Recurring Issue Check

### Functionality expert
R1, R2, R3, R17, R19, R29, R49, R50, RT10 — Checked, no issue. R42 — the D7 composed-trap fix verified closed, but its own new failure mode found (F2). R48 — C5's collapse verified; `wouldIpBeAllowed` surfaced as a stale predictor outside the grep-defined member set (F1). Remaining R-numbers: N/A for the areas this incremental round targeted.

### Security expert
R1/R17, R3, R29 (all six new citations fetched and verified), R49, R50, RS1-RS3, RS5, RS6 — Checked, no issue. RS4 — Checked, no issue. R42/R43 — Finding S1. R48 — Checked for the adjudicators; S2 is a stale predictor, a related but distinct shape.

### Testing expert
R1/R17, R19, R29, R42, R48, R49/R50, RT1, RT2, RT5, RT7, RT9, RT10 — Checked, no issue. R43 — Finding T1 (the sibling gap the Phase 2 fix left). All other items: no new issue this round.

---

# Round 2

## Changes from Previous Round

All six Round 1 findings applied. Round 2 reviewed the fixes themselves.

## Findings

- **F3 [Critical]** `src/app/api/tenant/policy/route.ts` — the self-lockout gate's trigger condition tested `allowedCidrs` and `tailscaleEnabled` but not `tailscaleTailnet`, so a PATCH carrying only that field skipped the check entirely. Reproduced against the real handler: `wouldIpBeAllowed` was never called and the save returned 200. This is the scenario Round 1's F1/S2 fix was written for, still open one layer up. Investigating the fix surfaced the same omission a second time in the same file: `needsCurrentState` gated the current-tenant read on the identical two-field list, so even with the trigger corrected the hypothetical policy was built from `?? []` / `?? false` and `hasRestrictions` evaluated false.
- **T3 [Major]** (= F4) Both route-level suites mock `wouldIpBeAllowed` as returning a bare boolean while production now returns a Promise. Verified by deleting the `await` at `route.ts:811` on a throwaway worktree: all 97 tests still passed — the exact regression Round 1 fixed would ship silently.
- **T4, T5 [Major]** Two of Round 1's new `wouldIpBeAllowed` cases pass unchanged against the pre-fix synchronous body, so they do not discharge the fix.
- **T6 [Major]** (= F5) No fixture pins the shape Round 1's F2 identified as a false positive, so a future widening of Rule B's trigger would reintroduce it unnoticed.
- **S1 [Major, continuing]** The gate's one-hop, name-based matching stands as a documented limit. The security expert was asked to challenge the argument that the real guarantee comes from the tests rather than the gate, and confirmed it: both CLI suites execute the emitted `trap` line through `/bin/sh` against a socket path containing `'` and a space and assert a decoy file survives — an adversarial proof for the two real sites, not a happy-path smoke test.
- **[Adjacent, Minor]** `isTrapBody` recognizes `const x = <template>` but not a bare reassignment (`let x; x = ...`). Pre-existing shape, no live code uses it; recorded, not fixed.

## Resolution Status — Round 2

| ID | Disposition | Where applied |
|----|-------------|---------------|
| F3 | Fixed at both sites, and the duplication that caused it removed | `route.ts` now names the predicate once (`lockoutRelevantFieldChanged`) and both the current-state read and the self-lockout gate key off it. The two spellings had drifted apart in exactly the same way, which is why fixing only the one the finding named left the bug live. |
| T3 / F4 | Fixed | Both mocks now resolve a Promise, so a dropped `await` changes the assertion's outcome |
| T4 | Fixed | The allow case now asserts `verifyTailscalePeer` was called with the pinned tailnet — the old approximation returned true by never asking |
| T5 | Fixed by adding a differentiating sibling | The CGNAT-only case pins I5.3 and legitimately holds under both implementations; a new case (non-CGNAT address under a Tailscale-only policy) fails against the old body, which cleared that save unconditionally |
| T6 / F5 | Fixed | A green fixture pins `PSSO_PATH=${shellQuote(\`${dir}/${name}\`)}` as passing |
| S1 | Accepted as a documented limit | Argument re-verified rather than restated; recorded above |

Verification: `npx vitest run` → 1004 files, 13891 passed, 1 skipped. `npx tsc --noEmit` clean. Gate green.
