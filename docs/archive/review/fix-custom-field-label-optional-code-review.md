# Code Review: fix-custom-field-label-optional
Date: 2026-07-07
Review round: 1 (converged — zero findings)

## Changes from Previous Round
Initial review of the implemented fix (commit f6a85fa1).

## Functionality Findings
**No findings.** The implemented predicate at `src/lib/vault/entry-form-helpers.ts:38-42` is byte-for-byte the plan's C1 "Resolved rule" and satisfies INV-C1.1–C1.7. Boolean branch (`field.value === "true"`) is safe: the UI writes boolean values only via `String(checked)` (`entry-custom-fields-totp-section.tsx:140`), so the domain is strictly `{"true","false"}`. Both callers still pass `EntryCustomField[]` (required `type`); the `type?` widening does not compile-break (`tsc --noEmit` clean on touched files). `parseUrlHost || null` change inert at all three consumers. No downstream code assumes labelled-only custom fields (`map-detail-fields.ts:37` passes through verbatim). Fix reaches both the reported bug (value-only) and the mirror (label-only) on both personal and team login paths.

## Security Findings
**No findings.** The `parseUrlHost` `|| null` change is a net security improvement (empty-string hosts from `javascript:`/`data:`/`mailto:` no longer reach `additionalUrlHosts`). `isSafeHref` gate is label-independent (`login-section.tsx:130-141`, `share-entry-view.tsx:152-169`) — label-less dangerous-scheme URL fields still render as inert text. Share plaintext path (`shareDataSchema`) already tolerated empty labels; the new client behavior is consistent, no bypass. No length-cap/DoS bypass (opaque blob capped at `CIPHERTEXT_MAX`). No auth/authz path touched. Escalation: none.

## Testing Findings
**No findings.** All 12 C1 acceptance rows have tests. The label-less URL repro test is a genuine failing-first regression guard (verified: old `label.trim() && value.trim()` predicate returns `[]` for the repro input). `personal-entry-payload.test.ts` asserts length 2 + the `additionalUrlHosts` side-effect with a host distinct from the main URL host (non-vacuous). `team-entry-payload.test.ts` rewritten to `.toEqual` with an untouched-row drop proof. `parseUrlHost` C2 tests cover dangerous schemes → null. No old-behavior assertions left behind. Detail-render test acceptably deferred (optional per plan T7).

## Adjacent Findings
- [Testing, non-blocking] An optional lightweight `login-section` render test of a label-less URL field would close the only untested link (detail-render tolerance), but is not required — the render path was verified by inspection and the fix is pure client logic fully unit-covered.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
- R42 (member-set completeness): PASS — re-grepped `filterNonEmptyCustomFields`; 2 callers (personal + team), import path correctly excluded, no raw-SQL/aliased writers. Centralized-helper fix covers full set.
- R1-R41: N/A (pure-logic client-side change; no migrations, i18n strings, routes, tokens).

### Security expert
- R1 (injection): clear (share `type` enum-validated; no SQL/command surface).
- R5 (XSS): clear (`isSafeHref` allowlist gate label-independent).
- R6 (SSRF): clear/improved (empty hosts no longer reach `additionalUrlHosts`; favicon proxy retains `normalizeFaviconHost`).
- R42: N/A to a security defect; `|| null` applied at the single primitive shared by both call sites.
- RS1-RS5: no new secret-response / no-store / plaintext-leak / auth-enumeration surface.

### Testing expert
- RT4 (regression-fails-before-fix): PASS (repro test provably red against old predicate).
- RT6 (write-read / vacuous-assertion): PASS (`additionalUrlHosts` test uses a distinct host, avoiding the dedup-vacuity trap).
- R42 (test member-set): PASS (both caller tests updated; import path excluded; every `CUSTOM_FIELD_TYPE` value appears ≥ once).

## Environment Verification Report
- C1 (keep-if-touched predicate): `verified-local` — `npx vitest run` (12033 passed, 0 failed); the repro row confirmed failing-first against the old predicate.
- C2 (parseUrlHost empty→null): `verified-local` — dangerous-scheme unit tests pass; `npx next build` succeeds.
No Phase-1 `Verification environment constraints` entries were `blocked-deferred` (all paths were `verifiable-local`).

## Resolution Status
All three experts returned **No findings** in Round 1. Phase 1's F1/F2/F3/F4/S1/T1-T7 findings were all resolved in the plan + implementation before Phase 3 (see `-review.md` Resolution Status). No new findings to fix. Review converged in one round.
