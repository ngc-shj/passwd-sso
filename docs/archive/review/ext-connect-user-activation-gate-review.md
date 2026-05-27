# Plan Review: ext-connect-user-activation-gate

Date: 2026-05-28
Review round: 1

## Changes from Previous Round

Initial review. Three expert sub-agents (Functionality, Security, Testing) ran
in parallel against the locked plan. The prototype branch is UX-validated and
empirically confirmed (`isActive: true` at click handler entry); this PR
formalizes the production implementation.

## Resolution Summary

### Critical / Major (all addressed)

| Finding | Disposition |
|---------|-------------|
| Test F3: `token-bridge-js-sync.test.ts` doesn't assert gate presence in `.js` (RT4 vacuous-test risk — gate could exist only in `.ts`, production-deployed `.js` silently lacks it) | **Accepted** — C1 + C4 now mandate a sync test that greps for `navigator.userActivation` in the `.js` file. |
| Test F1+F11: `vi.stubGlobal("navigator", ...)` overwrites prototype accessors and has no cleanup | **Accepted** — C4 mandates `Object.defineProperty` pattern with explicit before/after cleanup, referencing `autofill-identity.test.ts` as precedent. |
| Test F4: "mechanical click insert" framing under-counts test rework (URL-timing assertions need to move) | **Accepted** — C4 contains per-test transformation rules instead of a single shortcut sentence. |
| Test F5: URL persistence tests missing (reload-re-prompt invariant) | **Accepted** — C4 adds three explicit tests for URL retention through AWAITING_CLICK / removal on click / S3 reload. |
| Test F9: no test asserts "click is the only trigger" (RT4 pattern — test the gate but not the door) | **Accepted** — C4 adds `it("does NOT call requestExtensionConnect on mount")`. |
| Test F8: TC4 manual test has TTV (timing) issues, observable undefined | **Accepted** — C5 now provides copy-pasteable DevTools snippets and concrete browser-side observables; "absence of audit row" removed (required DB access). |
| Func F5: `ext-connect-banner.tsx` co-renders with AWAITING_CLICK due to URL retention | **Accepted** — C2 invariants now require verifying the banner has no `aria-live` (or fixing it if it does). |
| Sec F1: SW trusts START_CONNECT from any extension-internal sender (gate is layer-1 only) | **Documented as out-of-scope** with rationale — C15 threat model is host-page XSS, which cannot reach SW except through token-bridge content script (chrome isolated-world boundary). SW-side sender check is a separate hardening opportunity, tracked as future work. |

### Minor (folded into plan)

| Finding | Disposition |
|---------|-------------|
| Func F1: .js returns void vs .ts returns false | C1 explicitly distinguishes the two return disciplines. |
| Func F2: ordering rationale should be oracle-prevention not performance | C1 invariant text reframed. |
| Func F4: file still exists on `main`; modify in place, don't restore from git | C4 reflects this. |
| Func F6: `useEffect` `[]` deps may trip `react-hooks/exhaustive-deps` | C2 pre-acknowledges the eslint-disable case. |
| Func F9: 5s is implementation-defined, not spec value | "Considerations" updated; HTML spec link added. |
| Sec F2: enumerate `tokenChanged → clearVault()` damage profile | "Considerations" expanded with full damage profile + TC4 must record actual behavior. |
| Sec F3: TC4 observable needs to be concrete | C5 updated per above. |
| Sec F5: forbidden-pattern grep too narrow | C1 replaced with structural rule ("no postReady between reqId-validation and SW round-trip"). |
| Sec F6: spec citation | Added link to https://html.spec.whatwg.org/multipage/interaction.html . |
| Sec F7: frame-ancestors note | Added to "Out of scope" with verify-at-review-time pointer. |
| Sec F8: `vi.stubGlobal` cleanup hazard | Folded into Test F1+F11. |
| Test F2: edge case tests (hasBeenActive only, empty object) | Added to C4. |
| Test F10: i18n parity test missing | C4 adds a 10-line parity test. |
| Test F12: pathname-independent gate test | Added to C4 acceptance. |

### Skipped with rationale

| Finding | Rationale |
|---------|-----------|
| Sec F4: timing-distinguishable paths between activation-fail and reqId-fail | Reviewer self-concluded "effectively closed via timeout-collapse on page side" (page-side `requestExtensionConnect` 8-second timeout makes all silent-drop paths look identical to the page). No code change; the 8s timeout is an existing invariant. |

## Adjacent Findings

- [Adjacent] Sec → Func: SW handler trusts all internal senders. Functionality unaffected (legitimate code paths are unchanged); only relevant if a future feature adds a new internal sender of `START_CONNECT`. Documented as out-of-scope follow-up.
- [Adjacent] Test → Sec: F3 (sync test gap) is both a test-quality issue and a security-control assurance issue. Resolution covers both.

## Recurring Issue Check

### Functionality expert
- R9 (async-in-tx): N/A — no DB transactions.
- R10 (circular imports): No new cross-module imports. Pass.
- R12 (audit coverage): N/A — no new server-side action.
- R16 (no any): Pass — `?.isActive` is typed.
- R35 (manual test artifact): Pass — C5 commits to Tier-2 artifact.
- `project_extension_parallel_impl`: Pass — C1 explicitly covers both files + sync test extension.

### Security expert
- RS1 (timing-safe compare): N/A.
- R23 (no secrets in logs): Pass — no new logging.
- R25 (METADATA_BLOCKLIST): N/A.
- R31 (no destructive DB ops): N/A.
- R35 (manual test artifact, Tier-2 Adversarial): Pass.

### Testing expert
- RT4 (race-test vacuous guard): **Two RT4-shaped findings raised and resolved** — F3 (JS-sync test) and F9 (no-auto-fire negative test). Both are now explicit acceptance criteria.
- `feedback_const_object_for_string_literals`: Pass — CONNECT_STATUS extension.
- `feedback_e2e_aria_label_phantom_match`: addressed — `getByRole({name})` mandated for button queries.
- `feedback_subagent_findings_essence_filter`: applied during this synthesis — speculative findings (e.g., "what if HTML spec v3 changes") not pursued.

## Conclusion

All Critical and Major findings resolved in plan. Minor findings folded into
acceptance criteria. One finding explicitly scoped out (Sec F1 SW sender
check) with rationale documented.

Go/No-Go Gate from the plan:

| ID | Subject                                     | Status |
|----|---------------------------------------------|--------|
| C1 | Content-script userActivation gate          | locked |
| C2 | Web-app click-driven flow + AWAITING_CLICK  | locked |
| C3 | i18n parity (en + ja, 3 new keys)           | locked |
| C4 | Test coverage (content script + component)  | locked |
| C5 | Manual test artifact (R35 Tier-2)           | locked |

Transitioning to Phase 2 (implementation).
