# Code Review: personal-history-aad-mismatch
Date: 2026-05-31
Review round: 1 (Phase 3, 3 expert sub-agents — Functionality / Security / Testing)

## Changes from Previous Round
Initial Phase-3 review of the full branch (10 commits) vs origin/main.

## Outcome
- **Security**: No Critical/Major crypto break. S1–S6 explicitly CONFIRM sound: OK/AR byte-identical relocation, EM/WH/AC reformat encrypt/decrypt consistency, cross-entry/user/scope binding preserved, no-fallback proof holds, keyVersion stamps the encrypting key (client-supplied, correct under concurrent rotation). One Major (S7) is a gate-robustness residual gap, not an exploitable state.
- **Functionality**: all plan contracts C1–C16 satisfied (verified per-contract). Findings are gate false-positive risks + doc gaps (Minor).
- **Testing**: all 10 scopes have genuine real-crypto round-trips + anti-vacuous wrong-AAD rejection; C4/C5/C2 confirmed; keyVersion threading asserted at correct depth (app + extension); gate self-tests cover A–E pos+neg. Two Major gate-coverage gaps (T1/T2) + Minors.

## Findings + disposition

### Major (fix this round)
- **T1 / F2 — `aad-golden-vectors.json` omits `OV-overview` and `OK`** → Check D (the machine gate) doesn't verify them, so a both-sides-identical drift on those scopes would pass. Also `manifest.AT.crossCodebase=false` is wrong (iOS implements AT; Check D does verify it). **Fix**: add OV-overview + OK to the golden SSoT with per-vector codebase applicability (OK is app+ext only — no iOS builder); update Check D to honor applicability; correct the AT classification.
- **T2 — iOS `AADParityTests.swift` lacks a full-byte assertion for `buildTeamEntryAAD(... overview ...)`** (only blob). Plan C14 required full-byte OV blob+overview. **Fix**: add `testTeamEntryAADOverviewByteIdentical` (write-only; verified by Check D + iOS CI).
- **S7 — gate does not detect string-delimited AAD (`.join("|")`/template) fed to `additionalData`/`setAAD` INSIDE an allowlisted file** (C13 claimed this detection). Round-trip tests are a compensating control. **Fix**: Check A also flags delimiter-join AAD idioms in the crypto modules.

### Minor (fix this round — cheap gate hardening)
- **S8** — Check A comment filter misses `/*`-prefixed lines (false-positive risk). Add `/*` to the skip filter.
- **T3** — Check D self-test lacks a `//`-trailing-comment fixture for the iOS normalizer. Add one.
- **T4** — Check C "passes cleanly" self-test reuses one file for parity+roundTrip. Use distinct real files.
- **S9** — `OK` manifest `crossCodebase:true` is ambiguous (iOS has no OK). Clarified by the per-vector applicability in the T1 fix + a manifest note.
- **F3** — optional `AuditLog.json` orphan-label coverage test (plan C9, "recommended") not added. Add it (<30 min, closes the class).

### Accept / document (Anti-Deferral)
- **F1** — Check B `additionalData\s*[=:]` could false-positive on a TS interface field named `additionalData` outside the allowlist. **Anti-Deferral**: acceptable — no such field exists in the codebase; worst case = a spurious CI failure on a hypothetical future interface (not a security miss); cost-to-fix-precisely (context-aware match) > benefit. Documented in the gate; expand allowlist if it ever fires.
- **F4 / S10** — extension `getKeyVersion() => personalKeyVersion ?? 1`: after a service-worker restart of a session created BEFORE this change (no persisted personalKeyVersion), one save could stamp 1 until the next unlock. **Anti-Deferral**: pre-existing behavior (old code hardcoded 1 unconditionally) — not a regression; worst case = one history-metadata keyVersion off-by for a single save in a narrow transitional window; self-corrects on next unlock; the blob is still encrypted with the correct key (no crypto break). Acceptable; recorded in deviation D3 (forward-only fix).
- **T5** — `password-import.test.tsx` mock `getKeyVersion:()=>1` is a routing test; keyVersion threading is asserted in `use-import-execution.test.ts` / `password-import-importer.test.ts`. No action.

## Recurring Issue Check (per expert)
- **Functionality** R1–R37: all Checked-no-issue / N/A. R3 (propagation to app+ext+iOS) clean; R11/R12 (audit group coverage after enum removal) clean; R24 (enum recreate, audit_logs only) clean.
- **Security** R1–R37 + RS1–RS4: clean except S7 (Major, gate gap, escalate:false), S8–S10 (Minor). RS2 (cross-user binding) confirmed; R20/R24 (migration safety, audit_outbox untouched) confirmed; R19/R21 (mock alignment caught in D3) confirmed.
- **Testing** R1–R37 + RT1–RT5: RT1 (mock-reality) documented + closed by C5; RT4/RT5 (all round-trips real + anti-vacuous) confirmed; R19 (getKeyVersion in all useVault mocks) confirmed. Gaps T1–T4.

## Resolution Status — Round 2 (all Round-1 findings resolved)
- **T1/F2/S9 (Major)** — `aad-golden-vectors.json` gained `OV-overview` + `OK`; every vector now carries an `ios` flag; Check D verifies app-side hex for all and iOS bytes only when `ios:true` (OK is app-only). `manifest.AT.crossCodebase`→true + parity added. Files: `scripts/checks/aad-golden-vectors.json`, `check-crypto-domains.mjs`, `aad-scope-manifest.json`.
- **T2 (Major)** — added `testTeamEntryAADOverviewByteIdentical()` to `ios/PasswdSSOTests/AADParityTests.swift` (full-byte OV-overview). Verified by Check D (literal == SSoT) + iOS CI for the runtime build.
- **S7 (Major)** — Check A now flags `.join("|")` / `.join(":")` delimiter-join AAD idioms in `src/lib/crypto/**` + `extension/src/lib/**`, closing the in-allowlist string-AAD-regression gap. Self-tested + live-negative confirmed.
- **S8 (Minor)** — Check A comment skip now also strips `/*`-prefixed lines.
- **T3 (Minor)** — Check D self-test gained a `//`-trailing-comment iOS fixture.
- **T4 (Minor)** — Check C "passes cleanly" self-test now uses distinct parity vs roundTrip files.
- **F3 (Minor)** — `audit-i18n-coverage.test.ts` gained orphan-label tests (en + ja): every action-shaped `AuditLog.json` key must be in `AUDIT_ACTION_VALUES`.

### Accepted (Anti-Deferral — see findings above for justification)
- **F1** — Check B interface-field false-positive: no instance; documented; expand allowlist if it ever fires.
- **F4/S10** — extension `?? 1` fallback on pre-change-session SW restart: pre-existing behavior, self-correcting, no crypto break (deviation D3).
- **T5** — routing-test mock `getKeyVersion:()=>1`: threading asserted in deeper tests. No action.

### Verification (Round 2)
- Gate: all of Check A–E + the new string-join rule pass clean; **two own live-negatives confirmed** (string-join in a crypto dir → Check A fails; corrupting an iOS overview byte → Check D fails). Check D now pins **7 vectors**.
- Gate self-test: 41 tests (was 27). Full `npx vitest run`: **10,797 pass / 1 skip**. `npx next build`: exit 0, ✓ Compiled successfully.

### Convergence
Round-1 Major findings (T1/T2/S7) were all in the CI gate / test infra — **no production crypto behavior changed in Round 2**. The two new substantive gate rules were verified by injection (live-negatives) + pos/neg self-tests, which is the verification a Round-3 security pass would perform; a full 3-expert Round-3 panel on injection-verified gate-script changes is low-yield. Orchestrator judges the review converged. Security S1–S6 (the actual crypto correctness) were CLEAN in Round 1.
