# Plan Review: codebase-test-coverage-pr2

Date: 2026-05-04
Review rounds: 2 (terminating with Minor remainders accepted)

## Round 2 Outcome (verification of Round 1 fixes)

All Round 1 Critical (4) and Major (~20) findings VERIFIED RESOLVED against codebase ground truth — three perspectives concur:
- WebAuthn library mock target (S1) → corrected; mock shape `{ responseJSON, prfOutput }` matches `webauthn-client.ts:284-339`.
- Coverage-diff branchless gate (T1) → C0a sub-step describes correct patch (`hasBranches ? branchGain > 0 : true`).
- pre-pr.sh grep gates (F3/S9/T2) → C0a adds 4 explicit gates with fail messages.
- passkey-credentials-card omission (S100) → added to §Sec-7 + C4 step.
- All other Round 1 findings (S2-S11, S101-S104, F1-F8, T3-T14, S12-A, S13-A) verified resolved.

### Round 2 Regressions (resolved)

- F11 (Minor): `passphrase-strength.ts:6` imports from barrel `@/lib/validations`, not `/common` — corrected via global replace.
- F12-F15 (Major regressions from C0→C0a/b/c rename): stale "C0" references in §R7, §R26, distribution table, e2e overlap log, pre-baseline note, primitive churn risk, user scenario — all swept to C0a/b/c as appropriate.
- S20 (Minor): "Mock `@simplewebauthn/browser` for passkey buttons" still in Test patterns table — corrected.
- T20 (Minor): e2e count "30 spec files" still in §Project context line 18 — corrected to 33.
- T21 (Minor): "(created at C0 start)" stale reference — corrected to C0a.

### Round 2 New Findings (Major — addressed)

- **S21 (Major)**: `passkey-credentials-card.tsx:213-227` catch block does NOT zero `secretKey` / `prfOutput` — source has a latent zeroization gap. The Round 1 §Sec-7(d) test obligation would test a property the source doesn't yet implement. **Resolution**: added a "Source pre-fix required" obligation to C4 step — first commit of C4 moves `secretKey.fill(0)` / `prfOutput?.fill(0)` into a surrounding `try { ... } finally { ... }` block, then the §Sec-7(d) tests are written. This is a security-positive change (closes a real gap, not just adds tests).

### Round 2 Minor findings (accepted; deferred to implementation discretion)

- S23: crypto-utils allowlist entry not documented as "encoding helpers, no key material" — note added implicitly via §Non-functional 4 entries; OK.
- T24: `npx tsc --noEmit` ordering in pre-pr.sh — implementation detail; C0a sub-step can place it before lint or in parallel.
- T25: S104 typed-mock concrete example — sub-agent dispatch will include an exemplar in the C0a/C0b commits.
- T26: 10% sample probe rate may be low for primitive-heavy C0c — accept; if regression detected, raise to 25% in subsequent batches (deviation log).
- T27-A: existing TSC errors may block C0a's tsc gate — acknowledged; the project's CLAUDE.md says ~142 pre-existing TS errors exist in unrelated test files. C0a's tsc step runs `--noEmit` on changed-files only via vitest's tsc integration (vitest's typecheck), or restrict to `src/__tests__/helpers/**` and the touched test file globs.
- T28-A: `mockTeamMismatch()` factory shape underspecified — implementation detail; C0b will define the factory's TS interface during the helper commit.

### Convergence decision

After Round 2, no Critical or Major findings remain unresolved (S21 has been folded in as a source-fix obligation in C4). Minor findings are accepted with rationale. Plan is dispatchable.

## Changes from Previous Round (Round 1)

Initial review.

## Functionality Findings

### F1 [Major] passphrase-strength.ts mischaracterized as "entropy estimator"

Source: `src/components/vault/passphrase-strength.ts:14-29` is a length+character-class score (4-bit heuristic), NOT an entropy estimator. With `PASSPHRASE_MIN_LENGTH=10` (`src/lib/validations/common.ts:218`), `getStrength("password")` (len 8) and `getStrength("12345678")` (len 8) return `{ level: 1, labelKey: "strengthWeak" }` for `score=0` and `{ level: 2, labelKey: "strengthFair" }` for `score=1` (digits) respectively — `"12345678"→weak"` would FAIL.

Fix: rewrite §Security obligation 1 + §Implementation step 10. Drop "entropy estimator" framing. Tests enumerate the 4 score branches (length≥MIN, length≥16, mixed-case, digit-or-symbol) with correct expected level/labelKey per score.

### F2 [Major] Distribution table double-counts notifications/** (171 ≠ 170)

`grep -c "^src/components/notifications/"` returns 0; `notification-bell.tsx` already tested. Distribution row "sessions/**, providers/**, folders/**, notifications/** | 1 each" should be "sessions/**, providers/**, folders/** | 1 each".

### F3 / S9 / T2 [Critical] pre-pr.sh grep gates DO NOT EXIST

Plan claims gates for `vi.mock("node:crypto", ...)`, `it.skip`, `process.env.X = `, `@ts-ignore` exist in `scripts/pre-pr.sh` "from PR #425". Verified: PR #425 commit only modified `coverage-diff.mjs` and `setup.ts`; `scripts/pre-pr.sh` has NO such grep gates. `scripts/checks/` has no test-hygiene gate.

Fix: ADD the gates as a C0a sub-step BEFORE C0 main batch. Each gate: (a) reject `vi.mock(['"]node:crypto['"]`); (b) reject `it.skip|describe.skip|fdescribe|fit\(`; (c) reject `^[\s]*process\.env\.[A-Z_]+ *=` in `**/*.test.{ts,tsx}` (allow setup.ts); (d) reject `@ts-ignore|@ts-nocheck` in `**/*.test.{ts,tsx}`. Optionally extract to `scripts/checks/check-test-hygiene.sh`.

### F4 [Major] Constants module path citations are inaccurate

Plan cites `src/lib/constants/{audit,auth,team,vault}/index.ts` — no `index.ts` exists in any of those subfolders. `PASSPHRASE_MIN_LENGTH` is in `src/lib/validations/common.ts:218`, not `src/lib/constants/`.

Fix: correct paths to `src/lib/constants/{app,time,timing,vault}.ts`, `src/lib/constants/{audit,auth,integrations,team,vault}/<file>.ts` (no index.ts), and `src/lib/validations/{common,entry,team,...}.ts` for validation constants.

### F5 [Minor] `validations.ts` (singular) vs `validations/` directory

Standardize to `src/lib/validations/**/*.ts`.

### F6 [Minor] webhook-card-test-factory.tsx in inventory but excluded from skip-log

Cosmetic — inventory generator shouldn't have included `**/__tests__/**`. Add a regen note.

### F7 [Minor] passphrase-strength.ts dual classification (Pure-type table + C6 step)

Move out of Pure-type table or annotate "TEST (per C6 step 10)".

### F8 [Minor] Pre-baseline snapshot step lacks `mkdir -p` and `.gitignore` entry

Add `mkdir -p .coverage-snapshots` to step 3; verify `.gitignore` includes the directory.

## Security Findings

### S1 [Critical, escalate=true] Mock allowlist names wrong WebAuthn library

Plan lists `@simplewebauthn/browser` in §Non-functional 4 mock allowlist. Verified by Opus: `src/lib/auth/webauthn/webauthn-client.ts:1-8` literally states "Uses the raw WebAuthn API (not @simplewebauthn/browser)". `passkey-signin-button.tsx:8` and `security-key-signin-form.tsx:9-13` import from `@/lib/auth/webauthn/webauthn-client`, returning `{ responseJSON, prfOutput: Uint8Array | null }`. The plan's mandated mock shape `clientExtensionResults: { prf: { results: { first } } }` is the raw WebAuthn credential's extension result, NOT the function's return.

Fix: 1) Replace `@simplewebauthn/browser` with `@/lib/auth/webauthn/webauthn-client` in allowlist. 2) Rewrite §Sec-7 to require resolved value `{ responseJSON: <fixture>, prfOutput: new Uint8Array(32).fill(0xAB) }`. 3) Assert `prfOutput.every(b => b === 0)` after settles (or spy on `.fill`). 4) Assert sessionStorage empty on verify-failure. Apply identically to `security-key-signin-form.tsx`.

### S2 [Major] Blanket "NEVER mock crypto-client.ts" contradicts existing practice

Existing tests in PR #425 mock `crypto-client.ts` at consumer boundary: `recovery-key-dialog.test.ts:24`, `password-list-search.test.tsx:32`, `personal-login-form-folder.test.tsx:56`, `entry-history-section.test.tsx:40`, `personal-password-edit-dialog-loader.test.tsx:29`, `password-import-importer.test.ts:17`, `team-edit-dialog-loader.test.tsx:33`.

Fix: restate as "MAY mock crypto-* at consumer boundary, MUST assert mock called with correct argument SHAPES (Uint8Array length, AAD format). Decorative `() => mockReturnValue` without input-shape assertion violates §Functional 6."

### S3 [Major] crypto-server.ts irrelevant for component tests

Plan lists `crypto-server.ts` in components-context "never mock" list. crypto-server.ts is server-only (uses node:crypto), cannot run in jsdom. Replace with `crypto-team.ts`, `crypto-recovery.ts`, `crypto-aad.ts`, `crypto-client.ts`, `crypto-utils.ts` (the actually-imported set per `grep -rln "@/lib/crypto" src/components`).

### S4 [Major] PRF mock shape `clientExtensionResults.prf.results.first` is wrong

Covered by S1 fix. Function returns `{ responseJSON, prfOutput: Uint8Array | null }`.

### S5 [Major] PRF zeroization on verify-failure path not in test obligations

`passkey-signin-button.tsx:72-76` and `security-key-signin-form.tsx:84-88` zero `prfOutput` on verify-failure. Plan covers happy path only.

Fix: add to §Sec-7 — verify-failure test mocks `verify` returning `{ ok: false }`, asserts `prfOutput.every(b => b === 0)` AND `sessionStorage` contains NO `psso:prf-output` / `psso:prf-data` / `psso:webauthn-signin` keys.

### S6 [Major] share/share-dialog.tsx not listed as crypto-relevant

`share-dialog.tsx:81-112` defines `encryptForShare` — `crypto.getRandomValues(new Uint8Array(32))` shareKey, AES-GCM encrypt, `shareKey.fill(0)` in success + finally (lines 324, 333). Fragment-only; never sent to server.

Fix: add to §Sec-1 — assert (a) shareKey from `crypto.getRandomValues`; (b) fetch POST body to `/api/share-links` does NOT contain shareKey; (c) `shareKey.fill(0)` in happy + finally; (d) sentinel `Uint8Array(32).fill(0xCD)` → `every(b => b === 0)` after.

### S7 [Major] share/share-password-gate.tsx missing from no-secret-in-DOM

`share-password-gate.tsx:43-80` accepts user-supplied access password. Plan §Sec-2 list omits.

Fix: add. Test pattern: type sentinel `PWGATE_SENTINEL_8H3K`, simulate 429/401, assert `screen.queryByText(/PWGATE_SENTINEL_8H3K/)).toBeNull()`.

### S8 [Major] R12 audit-action-icons exhaustive Record vs source's Partial<Record>

Source `audit-action-icons.tsx:23` is `Partial<Record<AuditActionValue, React.ReactNode>>` — line 22 comment: "Actions without a mapping fall back to <ScrollText /> at the call site." Plan demands exhaustive Record — contradicts source contract.

Fix: reframe R12 for icons — assert ACTION_ICONS is `Partial<Record<...>>`; iterate over actions THAT ARE mapped, assert each renders expected icon; assert call-site fallback `<ScrollText />` for unmapped action. For `audit-action-filter.tsx`: drop from R12 — Opus verified it's prop-driven (receives `actionLabel` callback), no internal mapping. R12 obligation belongs at upstream label registry (i18n keys / `useAuditLogs` hook).

### S100 [Critical, escalate=true] passkey-credentials-card.tsx missing from PRF obligation

`settings/security/passkey-credentials-card.tsx:140-231` (registration) and `:269-340` (test) consume `{ responseJSON, prfOutput }`. Line 156-174: `wrapSecretKeyWithPrf(secretKey, prfOutput)` → zeroizes both `secretKey.fill(0)` (line 172) and `prfOutput.fill(0)` (line 173) on success. `secretKey` IS the vault root.

Fix: add to §Sec-7 — same mock obligations. Cite explicitly in C4 (settings batch).

### S101 [Major] share-e2e-entry-view.tsx (recipient) invariants unprotected

`share-e2e-entry-view.tsx:33-64` defines `decryptShareE2E`. Lines 84-91: dynamic `<meta name="referrer" content="no-referrer">`. Line 102-103: `history.replaceState(null, "", location.pathname + location.search)` removes URL fragment. Line 113-116: rejects keys not exactly 32 bytes. Line 128: `keyBytes.fill(0)` in finally.

Fix: add to §Sec-1 — assert (a) `<meta name="referrer">` appended on mount + removed on unmount; (b) `history.replaceState` called pre-decrypt; (c) `length !== 32` → `missingKey` error state; (d) `keyBytes.fill(0)` in finally.

### S102 [Major] team key-rotation components no zeroization test obligations

`team/management/team-create-dialog.tsx:142-157` generates `teamId`, `generateTeamSymmetricKey()`, wraps for owner, `teamKey.fill(0)` in finally.
`team/security/team-rotate-key-button.tsx:140-234` re-wraps every entry's ItemKey with new TeamKey; `rawItemKey.fill(0)` (line 157), `newTeamKeyBytes.fill(0)` (line 234).

Fix: add to §Sec-1 — assert (a) `teamKey.fill(0)` in finally for create; (b) per-entry `rawItemKey.fill(0)` after re-wrap; (c) `newTeamKeyBytes.fill(0)` after member rewrap; (d) fetch POST body does NOT contain raw newTeamKey hex.

### S103 [Major] mock-next-navigation helper misses @/i18n/navigation

Most components (`passkey-signin-button.tsx:5`, `security-key-signin-form.tsx:5`, dozens more) import `useRouter` from `@/i18n/navigation` — locale-aware wrapper, NOT `next/navigation`.

Fix: rename helper to `mock-app-navigation.ts`, exporting `mockNextNavigation()` (for `next/navigation` `useRouter`/`useSearchParams`/`usePathname`) AND `mockI18nNavigation()` (for `@/i18n/navigation` `useRouter` + `Link`). Document both module paths in helper file comment.

### S104 [Major] Mock allowlist enforces target only, not factory return shape

Static grep audits `vi.mock(...)` target names. A test mocking the right target with a wrong-shape return value passes vacuously — see S1 chain.

Fix: add to §Non-functional 4 — every `vi.mock(<target>, factory)` MUST: (a) factory's exports match real module's exported names + signatures (no missing/extra); (b) at least one `expect(<mock>).toHaveBeenCalled()` or `.toHaveBeenCalledWith(...)`; (c) `import type` from real module to catch shape drift at TS compile. Add `npx tsc --noEmit` as a fast per-batch gate.

### S10 [Minor] Sentinel "SECRET_SENTINEL_ABCDEF" is hex-shaped

Replace with `SENTINEL_NOT_A_SECRET_ZJYK` (non-hex letters Z/J/Y/K).

### S11 [Minor] §Sec-5 truncates PR #425's full prohibition list

Restate fully: "NOT export key material, PRF outputs, derived encryption keys, signing secrets, or HMAC keys — even briefly. Test via plaintext input + observable side-effects only."

## Testing Findings

### T1 [Critical] coverage-diff.mjs branchGain > 0 fails branchless components

`scripts/coverage-diff.mjs:104` — `linesGain > 0 && branchGain > 0`. Many shadcn primitives (`badge.tsx`, `label.tsx`, `separator.tsx`, `input.tsx`, `textarea.tsx`) have ZERO branches. Gate fails on legitimate test additions.

Fix: change to `linesGain > 0 && (branchGain > 0 || (prevCnt.coveredBranches === nextCnt.coveredBranches && hasZeroBranches))` where `hasZeroBranches = Object.keys(nextEntry.b ?? {}).length === 0`. Pre-declare as C0 prerequisite (C0a).

### T2 [Critical] grep gates claimed but don't exist

Same as F3/S9. Merged.

### T3 [Major] passphrase-strength.ts mischaracterized — same as F1

### T4 [Major] Mock allowlist incomplete — bare `next-intl` not listed

Plan lists `next-intl/middleware`, `next-intl/server`. PR #425 tests use `vi.mock("next-intl", ...)` (bare) for `useTranslations`, `useLocale` — at least 10+ tests including `member-info.test.tsx`, `tenant-webhook-card.test.tsx`, `mcp-client-card.test.tsx`.

Fix: add bare `next-intl` to §Non-functional 4 allowlist.

### T5 [Major] next/navigation helper misses @/i18n/navigation — same as S103

### T6 [Major] notifications/** = 0 — same as F2

### T7 [Major] §Sec-2 lists files that don't handle secrets

`personal-save-feedback.ts` (read in full) handles toast feedback + redirect — no user-supplied secret. "recovery-key-related share components" returns no inventory matches; existing recovery-key components (`vault/recovery-key-banner.tsx`, `vault/recovery-key-dialog.tsx`) already tested in PR #425.

Fix: drop both. Add `share/share-password-gate.tsx` (S7) and `vault/change-passphrase-dialog.tsx` (the actual passphrase input dialog).

### T8 [Major] webhook-card-test-factory mocked Button strips classes — R26 unsatisfiable

`webhook-card-test-factory.tsx:258-269` mocks Button as plain `<button>` stripping Tailwind classes. R26 visual-cue assertion becomes tautological for tests reusing the factory.

Fix: add carve-out — "R26 disabled-state visual-cue obligation applies to direct render tests only. Tests consuming `webhook-card-test-factory.tsx` rely on `ui/button.test.tsx` (C0) for cue verification; factory tests verify wiring (`disabled` prop passed)." Document in §Anti-deferral log.

### T9 [Major] AuditAction enum SSoT not specified for R12

Plan demands `Record<AuditAction, …>`. If `AuditAction` is widened to `string`, exhaustiveness collapses.

Fix: pre-declare canonical import path. Verify `AuditActionValue` is closed (`as const` union) at `src/lib/constants/audit/audit.ts` (or wherever; orchestrator confirm during Round 2 fix application). Plan: "Import `AuditActionValue` from `<exact-path>`; if widening detected, file follow-up — do NOT weaken test."

### T10 [Major] C0 mixes infra helper + 22 UI tests in one commit

Fix: split C0 into C0a (helper + helper test) and C0b (22 UI primitive tests). Helper test under `src/__tests__/helpers/mock-app-navigation.test.ts`.

### T11 [Minor] e2e count "30" should be "33"

`find e2e/tests -name "*.spec.ts" | wc -l` → 33.

### T12 [Minor] R27 path guidance — same as F4

### T13 [Minor] Step 11 final coverage-diff is descriptive, not a hard gate

Fix: add explicit `node scripts/coverage-diff.mjs .coverage-snapshots/post-PR425.json .coverage-snapshots/post-C6.json --files 'src/components/**'` with zero-regression assertion.

### T14 [Minor] Sub-agent strategy lacks decorative-test detection

Fix: add — "Orchestrator MUST sample 10% of generated tests + apply assertion-removal probe (comment out each `expect(...)`; test must fail). Sub-agent regenerates on probe failure."

## Adjacent Findings

### F9-A [Adjacent] Mock-allowlist enforcement claimed via grep is unenforced (route to Testing)
Routed and incorporated as part of T2/F3/S9.

### F10-A [Adjacent] PRF mock byte form unspecified (route to Security)
Routed and resolved by S1 fix (Uint8Array(32).fill(0xAB) sentinel).

### S12-A [Adjacent] webhook-card-test-factory reusability for C3+C4 (route to Testing)
Routed and incorporated as T8.

### S13-A [Adjacent] RSC detection rule misses `auth()` (Auth.js v5) (route to Functionality)
Auth.js v5 uses `auth()` from `@/lib/auth/auth`, not `getServerSession`. Add to §Risks 4 detection rule's "server-only API import" list.

### T15-A [Adjacent] PRF mock shape verification (route to Security)
Resolved by S1.

### T16-A [Adjacent] Cross-tenant fixture shape unspecified (route to Functionality)
Add concrete fixture spec for "team A data while user is in team B" — extend `mock-team-auth.ts` with `mockTeamMismatch()` factory.

## Quality Warnings

None. All findings have evidence (file:line + grep output + observation).

## Recurring Issue Check

### Functionality expert
- R1: Checked — F4 partially R1-related (constants paths)
- R2: Finding F4
- R3: Finding F3 (gates promised but not delivered cross-PR)
- R4: N/A (synthetic DOM events are RTL practice)
- R5: N/A
- R6: N/A
- R7: Checked — no issue (selectors preserved)
- R8: N/A
- R9: N/A
- R10: N/A
- R11: N/A
- R12: Checked — covered in plan
- R13: N/A
- R14: N/A
- R15: N/A
- R16: N/A
- R17: Finding F6 (cosmetic)
- R18: Finding F3
- R19: Checked
- R20: N/A
- R21: Checked
- R22: Checked
- R23: Checked
- R24: N/A
- R25: N/A
- R26: Checked
- R27: Finding F4
- R28: N/A
- R29: N/A
- R30: Checked
- R31: N/A
- R32: N/A
- R33: Finding F3 (CI gate gap)
- R34: Checked
- R35: N/A

### Security expert
- R1: Checked
- R2: Finding S8
- R3: Findings S5, S7, S100, S101, S102
- R4: N/A
- R5: N/A
- R6: Findings S1, S3, S103
- R7: Checked
- R8: Finding S5
- R9: N/A
- R10: Finding S6 not earlier flagged at cross-tenant lens (handled now)
- R11: Finding S9
- R12: Finding S8
- R13: Checked
- R14: N/A
- R15: N/A
- R16: Findings S2, S11
- R17: N/A
- R18: Checked
- R19: Finding S9
- R20: Checked
- R21: Checked
- R22: Finding S10
- R23: Checked
- R24: Finding S5
- R25: N/A
- R26: Checked
- R27: Checked
- R28: Findings S1, S4, S104
- R29: Verified mock-shape against webauthn-client.ts
- R30: Checked
- R31: N/A
- R32: N/A
- R33: Findings S5, S7
- R34: N/A
- R35: Checked
- RS1: N/A
- RS2: N/A
- RS3: Finding S7

### Testing expert
- R1: Finding T12
- R2: Finding T12
- R3: Finding T8
- R4: N/A
- R5: Checked
- R6: N/A
- R7: Checked
- R8: Checked
- R9: Checked
- R10: N/A
- R11: N/A
- R12: Finding T9
- R13: Checked
- R14: Finding T7
- R15: N/A
- R16: Checked
- R17: N/A
- R18: Finding T5
- R19: Checked
- R20: Checked
- R21: Finding T14
- R22: N/A
- R23: Checked
- R24: Finding T9
- R25: N/A
- R26: Finding T8
- R27: Finding T12
- R28: Checked
- R29: Checked
- R30: Checked
- R31: Checked
- R32: N/A
- R33: Finding T8
- R34: Checked
- R35: N/A
- RT1: Findings T3, T15-A
- RT2: Finding T7
- RT3: Findings T12, T3
