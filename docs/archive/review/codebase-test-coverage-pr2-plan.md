# Plan: Codebase-wide Test Coverage Closing — PR2 (Tier 3 components)

Date: 2026-05-04
Plan name: `codebase-test-coverage-pr2`
Branch: `test/components-test-coverage`
Status: Phase 1 (plan creation), Round 1 input
Tracks: GitHub issue #429
Predecessor: PR #425 (`test/codebase-test-coverage`, merged 2026-05-03) — established P0 jsdom + RTL infra, mock allowlist, `scripts/coverage-diff.mjs`, `vi.unstubAllEnvs()` setup convention.

---

## Project context

- **Type**: web app (Next.js 16 + Prisma 7 + Auth.js v5 — security-critical password manager)
- **Test infrastructure**: unit + integration + E2E + CI/CD
  - Unit: Vitest 4 (`vitest.config.ts`, `npm run test` / `npx vitest run`)
  - Integration: real-DB via `npm run test:integration`
  - E2E: Playwright in `e2e/` (33 spec files; `e2e/tests/`)
  - Coverage: v8 provider, threshold 60% (line) globally, 80% on `auth-or-token.ts` / `crypto-server.ts` / `crypto-team.ts`. `coverage.include` already includes `src/components/**/*.{ts,tsx}` — Tier 3 untested files are currently in the denominator.
- **Existing test count after PR #425**: ~720 test files (+73 from PR1), ~+1187 unit tests
- **Trigger**: GitHub issue #429 — close the deferred Tier 3 gap (170 components in `src/components/**`)

---

## Objective

Add unit-test coverage for the 170 component files under `src/components/**` deferred from PR #425, while:
- Filtering out files where unit tests would be decorative (pure types) or duplicative (E2E-covered with no unit-only edge logic)
- Keeping each batch reviewable (≤ ~30 files per sub-PR commit)
- Preserving the security obligations established in PR #425 (mock allowlist, no `vi.mock("node:crypto", ...)`, `vi.stubEnv` only, no `it.skip`)
- Materially increasing the headline coverage % now that the Tier 3 denominator gets numerator additions

Non-goals:
- Adding E2E or integration tests
- Refactoring components beyond minor testability tweaks (`_resetXForTests` exports with `@internal` JSDoc, identical to PR #425 pattern)
- Raising coverage thresholds in `vitest.config.ts` (separate follow-up)
- Adopting Storybook for visual regression (not currently set up; out of scope for this PR — re-evaluate after Tier 3 lands)

---

## Requirements

### Functional

1. Every newly added test file executes under `npx vitest run` and passes.
2. `npx next build` succeeds after each batch (catches SSR bundling regressions; some components are RSC-bound).
3. New tests follow PR #425 conventions:
   - **Sibling test placement** (e.g., `src/components/auth/signin-button.tsx` → `src/components/auth/signin-button.test.tsx`)
   - Per-file `// @vitest-environment jsdom` pragma — components are jsdom-bound
4. Reuse existing helpers under `src/__tests__/helpers/` (`mock-prisma`, `mock-auth`, `mock-translator`, `request-builder`, `fixtures`); reuse the existing `webhook-card-test-factory.tsx` factory for webhook variants. Extend rather than duplicate.
5. Tests verify behavior, not implementation details. AAA structure, one behavioral assertion per test (multiple `expect()` allowed only when they together verify a single behavior).
6. Each test must fail when its assertion is removed (no decorative tests) — enforced by per-batch v8 *branch* coverage gate (see §Testing strategy).

### Non-functional

1. **Pre-declared 9-step split** (matching issue #429's 7 sub-areas, plus 2 infra prerequisites — see §Implementation steps for the full ordered list):
   - **C0a** — Test-hygiene infra (grep gates + ESLint rule audit + `coverage-diff.mjs` branchless-fix + tsc gate)
   - **C0b** — Navigation mock helper + extension to `mock-team-auth.ts`
   - **C0c** — `components/ui/**` (22 shadcn primitives)
   - **C1** — `components/passwords/{shared,entry,detail,detail/sections}` (~30)
   - **C2** — `components/passwords/{personal,dialogs,import,export}` (~20)
   - **C3** — `components/team/**` (22)
   - **C4** — `components/settings/**` (26)
   - **C5** — `components/{audit,entry-fields,share,auth}/**` (28)
   - **C6** — `components/{vault,layout,breakglass,watchtower,tags,emergency-access,admin,sessions,providers,folders,notifications}/**` (~22)
2. **Single PR for all 7 batches OR a 2-PR pre-declared split if C-batch coverage diff exceeds reviewer-fatigue threshold (~50 files)**:
   - Default: **single PR `test/components-test-coverage`** with 7 commits (one per C-batch). Predecessor established the discipline; reviewer can review per-commit.
   - Fallback: if reviewer requests split, PR-A = C0–C3, PR-B = C4–C6 (rebased). Decision is made AFTER C3 commit — record in deviation log.
3. Tests isolate from one another (vitest `isolate: true` per file; new tests must not introduce cross-`it()` shared state).
4. **Mock allowlist** (this is a security boundary, not a style preference):
   - Allowed: `@/lib/prisma`, `next-intl` (bare — for `useTranslations`/`useLocale`), `next-intl/{middleware,server}`, `next-auth`, `next/headers`, `next/server`, `next/navigation`, `@/i18n/navigation` (locale-aware wrapper used by ~80% of components), `@/lib/http/with-request-log`, `@/lib/auth/session/{session-cache,csrf}`, `@/lib/auth/webauthn/webauthn-client` (consumer-side WebAuthn mock — see §Security obligation 7 for required return shape), `@/lib/crypto/crypto-client`, `@/lib/crypto/crypto-team`, `@/lib/crypto/crypto-recovery`, `@/lib/crypto/crypto-aad`, `@/lib/crypto/crypto-utils` (consumer-side mocking with shape-assertion obligations — see §Security obligation 1), `node:fs`, `node:fs/promises`, `@octokit/*`, `@aws-sdk/client-s3`.
   - **`globalThis.fetch`** — `vi.spyOn(globalThis, 'fetch')` only (NOT `vi.mock(...)`). Each test that mocks fetch MUST restore in `afterEach` via `vi.restoreAllMocks()`.
   - **`@/lib/vault/vault-context`, `@/lib/team/team-vault-context`, `@/lib/emergency-access/emergency-access-context`, `@/lib/vault/active-vault-context`, `@/lib/vault/auto-lock-context`** — allowed (consumer-side mocking; the contexts themselves are tested in PR #425 Tier 1.5).
   - **`node:crypto`** — only `vi.spyOn(cryptoModule, 'randomBytes')`. **`vi.mock('node:crypto', ...)` is FORBIDDEN.** (Enforcement: see §Implementation step C0a — gate ADDED in this PR; PR #425 did NOT establish it.)
   - **Mock factory return-shape obligation (S104)**: every `vi.mock(<allowed-target>, factory)` MUST: (a) the factory's exports match the real module's exported names AND callable signatures (no missing/extra exports). Use `import type` from the real module to surface shape drift at TS compile. (b) At least one test in the same file MUST assert the mock was called (`expect(<mock>).toHaveBeenCalled()` / `.toHaveBeenCalledWith(<args>)`). (c) Per-batch `npx tsc --noEmit` runs as a fast delta gate to surface mock-vs-real shape divergence.
5. No skipped tests (`it.skip` / `describe.skip`). Files genuinely not unit-testable go in the **Skip log** with rationale.
6. No `// @ts-ignore` / `// @ts-nocheck` / explicit `any` in new test files. Enforcement: ESLint `@typescript-eslint/no-explicit-any` + `@typescript-eslint/ban-ts-comment` (verify present at C0a). Grep gate (added in C0a) catches `@ts-ignore`/`@ts-nocheck` in `**/*.test.{ts,tsx}`.
7. Tests are deterministic — no real network, no real timers (use `vi.useFakeTimers()`), no `setTimeout`-based waits (use RTL `waitFor` / `findBy*`).

### Security obligations

1. **Tests must not weaken security primitives**:
   - **Auth-bearing components** (`auth/passkey-signin-button.tsx`, `auth/security-key-signin-form.tsx`, `auth/email-signin-form.tsx`, `auth/signin-button.tsx`, `auth/signout-button.tsx`) — assert that the form does NOT submit to a server endpoint without CSRF/cookie context (verify the request mock receives the expected fetch call shape; verify error-path does NOT leak the email/credential into the rendered DOM).
   - **Vault-touching components** (`vault/**`, `breakglass/**`, `emergency-access/**`) — MUST mock the vault-context consumer hook (`useVault`, `useTeamVault`, `useEmergencyAccessVault`). Tests **MAY** mock `@/lib/crypto/crypto-client`, `@/lib/crypto/crypto-team`, `@/lib/crypto/crypto-recovery`, `@/lib/crypto/crypto-aad` at the consumer boundary, **PROVIDED** the test asserts the mock is called with correctly-shaped arguments (e.g., `Uint8Array` of expected length, AAD string format, IV length). Decorative `() => mockReturnValue` without input-shape assertion violates §Functional 6. The encryption round-trip itself is tested in `src/lib/crypto/*.test.ts` (PR #425 Tier 1); the encryption-boundary contexts are tested in PR #425 Tier 1.5. Reference existing pattern: `src/components/vault/recovery-key-dialog.test.ts:24`. **`crypto-server.ts` is NOT in scope** — server-only module, cannot run in jsdom.
   - **Share-flow crypto** (`share/share-dialog.tsx`, `share/share-e2e-entry-view.tsx`):
     - `share-dialog.tsx:81-112` (`encryptForShare`) — assert (a) `shareKey` generated via `crypto.getRandomValues(new Uint8Array(32))` (mock and verify the call); (b) the `fetch` POST body to `/api/share-links` does NOT contain `shareKey` or its base64url representation (scan all `mockFetch.mock.calls[0][1].body` for sentinel hex); (c) `shareKey.fill(0)` is called both in happy path AND in `finally` (use sentinel `Uint8Array(32).fill(0xCD)` and assert `every(b => b === 0)` after function returns).
     - `share-e2e-entry-view.tsx:33-128` (recipient `decryptShareE2E`) — assert (a) `<meta name="referrer" content="no-referrer">` is appended to `document.head` on mount AND removed on unmount; (b) `history.replaceState(null, "", location.pathname + location.search)` is called BEFORE decrypt runs (asserts URL fragment removed from history); (c) keys with `length !== 32` produce error state `missingKey`; (d) `keyBytes.fill(0)` runs in `finally` regardless of decrypt success/failure (sentinel `Uint8Array(32).fill(0xCE)` → `every(b => b === 0)` after).
   - **Team key-rotation flow** (`team/management/team-create-dialog.tsx`, `team/security/team-rotate-key-button.tsx`):
     - `team-create-dialog.tsx:142-157` — assert `teamKey.fill(0)` runs in `finally` for create-team flow.
     - `team-rotate-key-button.tsx:140-234` — for rotate-key, EACH `rawItemKey.fill(0)` runs after re-wrap (loop test with sentinel bytes); `newTeamKeyBytes.fill(0)` runs after member-key rewrapping completes; `fetch` POST body to `/api/teams/[id]/rotate-key` does NOT contain raw `newTeamKey` bytes (scan body for hex of sentinel).
   - **`passphrase-strength.ts`** (utility, `src/components/vault/passphrase-strength.ts:14-29`) — 4-bit length+character-class score, NOT an entropy estimator. Tests enumerate the 4 score branches: `score++` for length≥`PASSPHRASE_MIN_LENGTH` (=10, from `@/lib/validations` (barrel re-export — `passphrase-strength.ts:6` already imports this way)), length≥16, mixed-case, digit-or-symbol. Assert exact `level/labelKey` per score: empty string → `{ level: 0, labelKey: "" }`; below MIN with no scoring boost → level 1 (`strengthWeak`); etc. Reference `PASSPHRASE_MIN_LENGTH` via `@/lib/validations` (barrel re-export — `passphrase-strength.ts:6` already imports this way) import (per RT3). Tests must NOT embed real-looking secrets that could leak via `git log -p`.
2. **No-secrets-in-error-DOM** assertion: for any component that handles a passphrase, OTP, recovery code, share-link password, or backup phrase, write a "decryption-fails" or "submit-fails" path test asserting the rendered error message does NOT contain the user-entered secret. Use a clearly-non-secret sentinel input `SENTINEL_NOT_A_SECRET_ZJYK` (letters Z/J/Y/K outside hex range, prevents gitleaks false-positives) and `expect(screen.queryByText(/SENTINEL_NOT_A_SECRET_ZJYK/)).toBeNull()`. Applies to: `auth/email-signin-form.tsx`, `vault/change-passphrase-dialog.tsx`, `vault/passphrase-*.tsx` (the actual passphrase-input dialogs), `breakglass/breakglass-dialog.tsx`, `emergency-access/create-grant-dialog.tsx`, `share/share-password-gate.tsx`. Removed from list (do not handle secrets / already tested in PR #425): `passwords/personal/personal-save-feedback.ts`, recovery-key dialogs (`vault/recovery-key-dialog.tsx`, `vault/recovery-key-banner.tsx`).
3. **Cross-tenant rendering denial**: components that render team-scoped data (`team/**`, `audit/audit-log-list.tsx` when in tenant view, share/audit consumers) — test path "rendered with team A data while user is in team B" → assert empty / fallback render, NOT a crash that exposes raw API response. **Concrete fixture**: extend `src/__tests__/helpers/mock-team-auth.ts` with `mockTeamMismatch({ actorTeamId: "team-a", resourceTeamId: "team-b" })` factory returning a useTeamVault stub whose `currentTeamId !== resourceTeamId`. C3 batch creates this helper as part of its first commit. The rendering itself is the assertion target; the auth deny-path was tested at the API layer in PR #425.
4. Test files MUST NOT embed real secrets. Existing setup-injected dummy keys in `src/__tests__/setup.ts` are the only allowed source.
5. **Test-only exports** (if added) MUST: (a) use `_testFn` / `_resetXForTests` naming; (b) carry `@internal` JSDoc; (c) NOT export key material, PRF outputs, derived encryption keys, signing secrets, or HMAC keys — even briefly. Test via plaintext input + observable side-effects (state transitions, fetch arg shape, sessionStorage absence on failure) only. (Inherits PR #425 §Security obligations 4 verbatim.)
6. **`process.env` mutations** — `vi.stubEnv` only. The `afterEach(() => vi.unstubAllEnvs())` from PR #425's `setup.ts` covers cleanup.
7. **WebAuthn / PRF mock shape** (corrected): the codebase uses raw WebAuthn API via `src/lib/auth/webauthn/webauthn-client.ts` (it explicitly does NOT use `@simplewebauthn/browser`). Tests of `auth/passkey-signin-button.tsx`, `auth/security-key-signin-form.tsx`, AND `settings/security/passkey-credentials-card.tsx` PRF path MUST:
   - **(a)** mock `@/lib/auth/webauthn/webauthn-client.startPasskeyAuthentication` (and `.startPasskeyRegistration` for the credentials-card) with resolved value `{ responseJSON: <fixture object>, prfOutput: new Uint8Array(32).fill(0xAB) }`. The function returns `{ responseJSON: Record<string, unknown>; prfOutput: Uint8Array | null }` per `webauthn-client.ts:284-287, 329-339` — NOT `{ clientExtensionResults: { prf: ... } }`.
   - **(b)** assert success-path: `sessionStorage.getItem('psso:prf-output')` equals the hex-encoding of the sentinel bytes after sign-in completes.
   - **(c)** assert verify-failure path (mock verify endpoint to return `{ ok: false }`): `prfOutput.every(b => b === 0)` (zeroization invariant per `passkey-signin-button.tsx:72-76`, `security-key-signin-form.tsx:84-88`); AND `sessionStorage` contains NO `psso:prf-output` / `psso:prf-data` / `psso:webauthn-signin` keys. Preferred assertion form: post-hoc zero check on the array (`expect(prfOutput.every(b => b === 0)).toBe(true)` after the function settles); spying on `Uint8Array.prototype.fill` is acceptable but more brittle.
   - **(d)** for `passkey-credentials-card.tsx` (registration path, settings/security/`:140-231`): additionally assert `secretKey.every(b => b === 0)` after `wrapSecretKeyWithPrf` completes — `secretKey` is the vault root and zeroization (line 172) MUST be tested on every code path including `catch`.
8. **AutoFill / extension boundary** (re-check during C5): components that call `navigator.credentials.*` — mock at the WebAuthn library boundary (`@/lib/auth/webauthn/webauthn-client`), NOT at `navigator.credentials`. The library's call-site has authoritative parameter validation; mocking lower can mask validation regressions.

### Recurring Issue Check obligations (R1-R35, RT*) — applied at plan stage

- **R3** (incomplete pattern propagation): every "category-typical" pattern (e.g., disabled-state UI cue, error-message rendering, form submit gate) chosen for one component MUST be enumerated across siblings in the same C-batch and verified.
- **R7** (E2E selector breakage): the C-batches do NOT change `data-testid`, `aria-label`, `id`, or class hooks — they only ADD tests. Confirm in C0c that the shadcn primitives' existing `data-slot` attributes remain unchanged.
- **R12** (action group coverage gap): `audit/audit-action-icons.tsx` source declares `ACTION_ICONS: Partial<Record<AuditActionValue, React.ReactNode>>` (line 23) intentionally — actions without a mapping fall back to `<ScrollText />`. Tests MUST: (a) iterate over `Object.entries(ACTION_ICONS)` and assert each mapped action renders the expected icon; (b) assert the call-site fallback `<ScrollText />` for an unmapped action; (c) `import type { AuditActionValue }` from the canonical SSoT (verified at C5 start: likely `src/lib/constants/audit/audit.ts` or similar — orchestrator confirms exact path before C5 sub-agent dispatch). Do NOT redefine `Record<AuditActionValue, ...>` in the test (would conflict with source's `Partial`). `audit/audit-action-filter.tsx` is **dropped from R12** — verification shows it is fully prop-driven (receives `actionLabel: (action) => string` callback); the upstream label registry (i18n keys / `useAuditLogs` hook) is the right exhaustiveness gate, NOT this filter component.
- **R23** (mid-stroke input mutation): `vault/passphrase-strength.ts` consumers and any numeric input component (`settings/**` for retention windows / TTLs) — verify clamp/min/max runs at commit, not on every keystroke. Test asserts `onChange("3")` does NOT clamp before `onBlur` (the user is on the way to "30").
- **R26** (disabled-state UI without visible cue): every disabled control across **ALL batches** (C0c–C6) — not just `ui/**` — must have a visual style. Examples beyond `ui/**`: `auth/email-signin-form.tsx` submit button while pending; `settings/**` save buttons; `breakglass/breakglass-dialog.tsx` action buttons; `vault/**` lock toggles; `team/forms/**` member-add submits; `passwords/dialogs/**` save buttons. Test asserts `disabled:opacity-*` / `data-disabled` / aria-disabled is present when `disabled` prop is true. Per-batch obligation: enumerate disabled controls and confirm cue assertion exists for each. **Carve-out for factory-based tests**: tests that consume `webhook-card-test-factory.tsx` rely on `ui/button.test.tsx` (in C0c) for the visual-cue assertion; the factory's mocked `Button` strips Tailwind classes, so visual-cue assertion inside factory tests would be tautological — see §Anti-deferral log entry "R26 visual-cue obligation for factory-based tests".
- **R27** (numeric range hardcoded in user-facing strings): test assertions on rendered limit text (e.g., "between 5 and 1440 minutes") MUST import the CONSTANT and reference it via interpolation in the assertion — not as a string literal. Constant locations to search (no `index.ts` in subfolders): `src/lib/constants/{app,time,timing,vault}.ts` (top-level files) and `src/lib/constants/{audit,auth,integrations,team,vault}/<name>.ts` (per-topic files). Validation constants like `PASSPHRASE_MIN_LENGTH` live at `src/lib/validations/{common,entry,team}.ts` (NOT in `src/lib/constants/`). Discovery procedure: `grep -rn 'export const FOO_CONSTANT' src/lib/` before inlining. Inlining a numeric literal in a test assertion that mirrors a validation constant fails this check.
- **RT1** (mock-reality divergence): every fetch / API mock MUST match the real OpenAPI response shape. Reuse `src/__tests__/helpers/fixtures.ts`; if a missing fixture is needed, ADD it to fixtures (do not inline a one-off).
- **RT2** (testability verification): files in the §Skip log have a documented reason; do not invent tests for un-testable surfaces.
- **RT3** (shared constant in tests): import limit constants from `src/lib/constants/**` rather than inlining.

---

## Scope inventory (170 → triaged)

Source: `docs/archive/review/test-gen-2026-05-03/untested-components.txt` (committed in PR #425).

### Distribution by sub-area

| Sub-area | File count | Batch |
|---|---|---|
| `passwords/**` | 50 | C1 + C2 |
| `settings/**` | 26 | C4 |
| `team/**` | 21 | C3 |
| `ui/**` | 22 | C0c |
| `entry-fields/**` | 8 | C5 |
| `audit/**` | 8 | C5 |
| `share/**` | 6 | C5 |
| `auth/**` | 6 | C5 |
| `vault/**` | 4 | C6 |
| `layout/**` | 4 | C6 |
| `breakglass/**` | 3 | C6 |
| `watchtower/**` | 2 | C6 |
| `tags/**` | 2 | C6 |
| `emergency-access/**` | 2 | C6 |
| `admin/**` | 2 | C6 |
| `sessions/**`, `providers/**`, `folders/**` | 1 each | C6 |
| `__tests__/webhook-card-test-factory.tsx` | 1 | Skipped (test infra) |
| **Total** | **170** | |

Note: `passwords/**` total of 50 splits as ~30 (C1) + ~20 (C2); the actual line count in `untested-components.txt` shows 50 password files. C1/C2 boundary will be drawn at implementation time to keep each commit ≤ ~30 files, reaffirmed in the §Implementation steps. `notifications/**` was previously listed as "1 each" but inventory confirmation shows 0 untested files (`notification-bell.tsx` already has a sibling test from PR #425) — corrected to drop the row.

### Pure-type / utility files (.ts, not .tsx) — 9 files

These need per-file pre-screen:

| File | Initial classification |
|---|---|
| `passwords/dialogs/personal-password-edit-dialog-types.ts` | Skip (pure types — name suffix `-types.ts`) |
| `passwords/import/password-import-types.ts` | Skip (pure types) |
| `passwords/personal/personal-login-form-types.ts` | Skip (pure types) |
| `passwords/entry/entry-form-tags.ts` | Re-classify at C1 — read first to confirm if logic or const-only |
| `passwords/import/password-import-utils.ts` | TEST — utility logic (CSV/JSON parse, schema-detect) |
| `passwords/personal/personal-save-feedback.ts` | TEST — likely state utility |
| `passwords/shared/folder-like.ts` | Re-classify at C1 — likely type guard / discriminated union helper |
| `team/forms/team-entry-copy-data.ts` | Re-classify at C3 |
| `vault/passphrase-strength.ts` | TEST — 4-bit length+character-class score (security-relevant; see §Sec-1 for correct test obligations). Tested in C6 step 10. |

Re-classify rule: read the file at batch start; if it has runtime logic with branches, write a test; if it is type aliases + const objects only, add to §Skip log with rationale.

### E2E coverage cross-reference (pre-screen action 2)

The `e2e/tests/` directory has 33 spec files. For each C-batch, run a coverage cross-reference at batch start: open the relevant spec(s) and identify components covered end-to-end. Findings recorded in `docs/archive/review/codebase-test-coverage-pr2-e2e-overlap-log.md` (created at C0a start). Decision rule: if E2E exercises every visible behavior AND the component has no internal branching that E2E does not exercise (e.g., RTL-only assertions on edge-case rendering), defer to Skip log. Otherwise, write the unit test — even when E2E touches the component, unit tests catch render-edge bugs faster.

E2E specs likely overlapping with this branch (pre-mapped):
- `password-crud.spec.ts` → `passwords/detail/**`, `passwords/dialogs/**`
- `teams.spec.ts` → `team/**`
- `tags.spec.ts` → `tags/**`
- `folders.spec.ts` → `folders/**`
- `audit-logs.spec.ts` → `audit/**`
- `share-link.spec.ts`, `share-link-public.spec.ts`, `send-text.spec.ts` → `share/**`
- `emergency-access.spec.ts` → `emergency-access/**`
- `admin-authz.spec.ts`, `admin-ia.spec.ts`, `tenant-admin.spec.ts` → `admin/**`, `settings/**`
- `import-export.spec.ts` → `passwords/import/**`, `passwords/export/**`
- `vault-lock-relock.spec.ts`, `vault-reset.spec.ts`, `passphrase-change.spec.ts` → `vault/**`
- `recovery-key.spec.ts` → recovery-key-related dialogs
- `bulk-operations.spec.ts` → `bulk/**` (already tested? confirm at C2 start)

---

## Technical approach

### Test framework (already in place per PR #425)

- Vitest 4 with `globals: true`, default `environment: "node"`, per-file `// @vitest-environment jsdom` pragma for component tests.
- Setup: `src/__tests__/setup.ts` (PR #425 added `afterEach(() => vi.unstubAllEnvs())`).
- jsdom Web Crypto probe (PR #425 `src/__tests__/jsdom-web-crypto-probe.test.ts`) confirms HKDF + AES-GCM-256 + 12-byte IV round-trip works.
- Coverage gate: `scripts/coverage-diff.mjs` (PR #425).

### Test patterns to apply

| Component category | Test pattern |
|---|---|
| Presentational primitive (most of `ui/**`) | `render(<Comp .../>)` → assert visible role/text/attribute via `screen.getByRole`/`getByText`/`getByLabelText`; assert disabled/readonly states have a visible cue (R26); avoid `data-testid` unless aria-* / role / accessible name fails |
| Interactive control (button, switch, dialog) | `userEvent.setup()` → `userEvent.click(...)` → assert callback fired with expected args; assert ESC / outside-click dismissal where applicable (per `dialog.tsx` `onEscapeKeyDown` pattern in MEMORY.md) |
| Form components (auth/email-signin-form, settings/**, team/forms/**) | `userEvent.type(...)` → submit → assert fetch called with expected body shape; assert error-path does NOT leak input into DOM (security obligation 2) |
| Auth components (auth/**) | Mock `next-auth` (signIn/signOut/useSession) AND `@/lib/auth/webauthn/webauthn-client` for passkey buttons (corrected — codebase does NOT use `@simplewebauthn/browser`); assert call args, not implementation |
| Vault-consuming (vault/**, breakglass/**, emergency-access/**) | Mock the consumer hook (`useVault` etc.) — never the underlying crypto module; assert render branches on locked / unlocked / decrypting states |
| Audit log rendering (audit/**) | Type-driven exhaustive enum table (R12) — `Record<AuditAction, …>` so missing entries are TypeScript errors |
| Settings pages (settings/**) | Mock `fetch` against the real OpenAPI shape (RT1 — pull from fixtures); assert success → state update; assert HTTP-error → user-visible error rendered |
| Team forms (team/**) | Mock team-vault-context; assert render branches per role (admin / member); cross-tenant denial (security obligation 3) |
| Pure utility (.ts files in components/) | Direct call, table-driven; no jsdom needed (use `// @vitest-environment node` for these) |

### When to skip vs test (decision tree)

```
Is the file pure types / no runtime?              → SKIP (rationale: "pure types")
Does the file re-export from a barrel only?       → SKIP (rationale: "barrel re-export")
Does E2E cover every visible behavior AND
  the component has no internal-only branches?    → SKIP (rationale: "E2E covers; log <spec>.spec.ts:line")
Does the file have ANY runtime branch
  (conditional render, callback dispatch,
  enum mapping, validation/clamp)?                → TEST
Otherwise (single-line wrapper, presentational
  with no states beyond raw prop pass-through)?   → TEST a smoke render only (1 test: "renders without crashing")
```

Skip decisions go to the **Skip log** (`docs/archive/review/codebase-test-coverage-pr2-skip-log.md`) with the following mandatory fields per entry:

- `file`: path
- `rationale`: one of `pure-types` / `barrel re-export` / `RSC-only` / `E2E covered` / `framework-only` / `test-infra` (other rationales rejected at review)
- `decision-rule`: cite the specific section that justifies skipping (e.g., `R# / §Skip decision tree / pure-types skip rule`). Entries without a cited rule are rejected at review time.
- `evidence`: for `RSC-only`, the import that triggered the rule; for `E2E covered`, `<spec>.spec.ts:line` referencing the test step that exercises the visible behavior; for `pure-types`, the file's exported surface (e.g., "exports `Foo` type alias only").
- `date`: ISO 8601

### Reuse over invention

Before writing a new mock or fixture, check:

- `src/__tests__/helpers/{fixtures,mock-prisma,mock-auth,mock-team-auth,mock-translator,request-builder}.ts`
- `src/components/__tests__/webhook-card-test-factory.tsx` — **EXISTS** (verified at line 1 of `untested-components.txt`). It is a reusable test factory used BY component tests, NOT a test target. C3 (team) and C4 (settings) webhook-card variants MUST consume this factory; do not write parallel factories.
- `src/__tests__/setup.ts` (process.env defaults — DO NOT mutate directly).
- **Navigation mock helper** — DOES NOT EXIST in `src/__tests__/helpers/` (verified via grep). The codebase uses TWO navigation modules: (a) raw `next/navigation` (for `usePathname`, sometimes `useRouter` in non-locale contexts); (b) `@/i18n/navigation` — the next-intl wrapper used by ~80% of components for `useRouter` + locale-aware `Link`. **C0a obligation**: ADD `src/__tests__/helpers/mock-app-navigation.ts` exporting two factories: (1) `mockNextNavigation()` for `next/navigation` `useRouter`/`useSearchParams`/`usePathname`; (2) `mockI18nNavigation()` for `@/i18n/navigation` `useRouter` + `Link`. The helper file's leading comment block MUST list both module paths and document the convention. Each batch's test files use whichever helper matches the component's import path. The helper has its own unit test (`mock-app-navigation.test.ts`) covering each factory's return shape — committed alongside the helper.

If a needed helper does not exist, extend `src/__tests__/helpers/` rather than duplicate.

### Test-only exports — strict scoping

`_resetXForTests` / `_test_*` exports are an **escape hatch of last resort**, not a default pattern. Add one only when:

1. The component holds module-private state that must be reset between `it()` blocks (timer caches, debounce buckets, audit-emission dedup maps), AND
2. No public API can reset it (the public API is read-only or commit-bound), AND
3. The state crosses test isolation (`vitest isolate: true` does NOT reset module-level state between `it()` calls within the same file).

If those conditions are NOT met, refactor the test to avoid module state, or accept the test ordering constraint. Adding `_resetXForTests` to a component without these conditions degrades production code for test convenience and is rejected at review time. Inheritance: same gate as PR #425 §Security obligations 4.

### Sub-agent strategy

For mechanical generation, dispatch one Sonnet sub-agent per **C-batch** (or per sub-batch when a C-batch is dense). Each sub-agent:
- Reads the target list + the in-scope helper modules + 1-2 existing component tests as exemplars (e.g., `src/components/__tests__/webhook-card-test-factory.tsx`)
- Generates tests
- Runs `npx vitest run -- <new-test-glob>` to verify locally
- Reports completion

R21 obligation: orchestrator MUST re-run `npx vitest run` (full suite) AND `npx next build` after each sub-agent batch. Sub-agent "completed successfully" is intent, not outcome. For batches touching auth/security-bearing components (C5, C6 vault), additionally complete an R3 propagation check by hand.

### Per-batch coverage delta gate

Inherits PR #425's `scripts/coverage-diff.mjs` and `.coverage-snapshots/` workflow. Each C-batch:
```bash
npx vitest run --coverage --coverage.reporter=json --coverage.reportsDirectory=.coverage-snapshots/post-C<n>
mv .coverage-snapshots/post-C<n>/coverage-final.json .coverage-snapshots/post-C<n>.json
node scripts/coverage-diff.mjs .coverage-snapshots/post-C<n-1>.json .coverage-snapshots/post-C<n>.json --files <batch-targeted globs>
```
Pre-C0a baseline: snapshot main's HEAD post-PR #425 merge.

### Pre-PR check

```bash
scripts/pre-pr.sh
npx vitest run
npx next build
```

---

## Implementation steps

1. **Pre-flight**: pull main (post-PR #425), branch off `test/components-test-coverage`. Create `docs/archive/review/codebase-test-coverage-pr2-{plan,review,skip-log,e2e-overlap-log,deviation}.md` (skip-log + e2e-overlap-log + deviation start empty; appended during implementation).

2. **Commit plan + reviews**: `docs/archive/review/codebase-test-coverage-pr2-plan.md`, `codebase-test-coverage-pr2-review.md`. (No code changes yet.)

3. **Pre-baseline snapshot**: `mkdir -p .coverage-snapshots`; verify `.gitignore` contains `.coverage-snapshots/` (PR #425 should have added; if missing, append). Then `npx vitest run --coverage --coverage.reporter=json --coverage.reportsDirectory=.coverage-snapshots/post-PR425`; `mv .coverage-snapshots/post-PR425/coverage-final.json .coverage-snapshots/post-PR425.json`. NOT committed; for diff use only.

4. **Batch C0a — Test-hygiene infrastructure (separate small commit)**:
   - **Add grep gates to `scripts/pre-pr.sh`** (or extract to `scripts/checks/check-test-hygiene.sh`) — these gates were claimed as PR #425-inherited but verification confirmed they DO NOT exist:
     - (a) reject `vi\.mock\(['"]node:crypto['"]` in `**/*.test.{ts,tsx}` — fail message: "FORBIDDEN: vi.mock('node:crypto', ...) silently disables AES/HKDF; use vi.spyOn(cryptoModule, 'randomBytes') only — see plan §Non-functional 4"
     - (b) reject `\b(it|describe|fdescribe|fit)\.skip\b` and `\bfdescribe\(|\bfit\(` in `**/*.test.{ts,tsx}` — fail message: "FORBIDDEN: skipped tests; document deviation in skip-log"
     - (c) reject `^[\s]*process\.env\.[A-Z_]+ *=` in `src/**/*.test.{ts,tsx}` (allowlist `src/__tests__/setup.ts`) — fail message: "FORBIDDEN: direct process.env mutation; use vi.stubEnv"
     - (d) reject `@ts-ignore|@ts-nocheck` in `src/**/*.test.{ts,tsx}` — fail message: "FORBIDDEN: @ts-ignore in tests; fix the type"
   - **Verify ESLint rules present** (or ADD to `eslint.config.*`): `@typescript-eslint/no-explicit-any`, `@typescript-eslint/ban-ts-comment`, `@typescript-eslint/no-unused-vars`. Use `grep -E "no-explicit-any|ban-ts-comment" eslint.config.*` — if missing, add.
   - **Patch `scripts/coverage-diff.mjs:104`** — fix the branchless-component gate. Current: `linesGain > 0 && branchGain > 0`. Replacement logic: a file with zero instrumented branches passes the gate when `linesGain > 0` AND covered-branches stayed equal. Pseudocode:
     ```js
     const hasBranches = Object.keys(nextEntry.b ?? {}).length > 0;
     const ok = linesGain > 0 && (hasBranches ? branchGain > 0 : true);
     ```
     Without this fix, C0b (UI primitives like `badge.tsx`/`label.tsx`/`separator.tsx` with zero branches) cannot pass the gate.
   - **Add fast type-check delta gate**: `npx tsc --noEmit` runs as part of `scripts/pre-pr.sh` (verify or add). This catches mock-vs-real shape divergence (S104) at TS-compile time, faster than waiting for `next build`.
   - Run vitest — must pass without behavior change. Commit. Commit message: `test(infra): add test-hygiene grep gates and coverage-diff branchless-fix (C0a)`

5. **Batch C0b — Navigation-mock helper (separate small commit)**:
   - ADD `src/__tests__/helpers/mock-app-navigation.ts` per §Reuse over invention spec (two factories: `mockNextNavigation()`, `mockI18nNavigation()`).
   - ADD `src/__tests__/helpers/mock-app-navigation.test.ts` covering each factory's return shape.
   - ADD (if needed) `mockTeamMismatch()` factory in existing `src/__tests__/helpers/mock-team-auth.ts` — used by C3 cross-tenant tests.
   - Run vitest. Commit. Commit message: `test(infra): add mock-app-navigation helper (C0b)`

6. **Batch C0c — `components/ui/**` (22 files)**:
   - Pre-screen: read each file; classify SKIP vs TEST per decision tree. shadcn primitives are mostly thin wrappers — likely many smoke-render-only tests. Disabled-state visual cue check (R26) MANDATORY for direct render tests; consult §Anti-deferral log for the factory carve-out.
   - Generate sibling `*.test.tsx` files. `// @vitest-environment jsdom` per file.
   - Run `npx vitest run`; run `npx next build`; coverage-diff; commit with body recording skip count and coverage delta.
   - Commit message: `test(ui): add C0c component coverage`

7. **Batch C1 — `passwords/{shared,entry,detail,detail/sections}` (~30 files)**:
   - Pre-screen `entry-form-tags.ts`, `folder-like.ts` per the .ts file classification table. Re-classify if needed; record in skip-log.
   - E2E cross-reference: `password-crud.spec.ts`, `password-generator.spec.ts`. Identify overlaps; record in e2e-overlap-log; SKIP only if E2E covers every visible behavior AND no internal branch is unit-only.
   - Generate tests. R12 applies to any audit-action / category mapping inside detail sections.
   - Run vitest + `next build`; coverage-diff; commit.

8. **Batch C2 — `passwords/{personal,dialogs,import,export}` (~20 files)**:
   - Pre-screen `password-import-utils.ts` (TEST), `personal-save-feedback.ts` (TEST — does NOT trigger §Sec-2 obligation; the file does not handle user secrets — see review F7/T7). Pure-types files SKIP.
   - **Security obligation 2 applies** to dialogs that handle passphrase input (NOT to `personal-save-feedback.ts` — that's just a router/toast helper).
   - E2E cross-reference: `import-export.spec.ts`, `password-crud.spec.ts`.
   - Run vitest + `next build`; coverage-diff; commit.

9. **Batch C3 — `components/team/**` (21 files)**:
   - Pre-screen `team/forms/team-entry-copy-data.ts`. Cross-tenant rendering tests (§Sec-3) using the new `mockTeamMismatch()` factory from C0b's `mock-team-auth.ts` extension.
   - **§Sec-1 team key-rotation crypto obligations apply** to `team/management/team-create-dialog.tsx` and `team/security/team-rotate-key-button.tsx` — assert `teamKey.fill(0)`, per-entry `rawItemKey.fill(0)` after re-wrap, `newTeamKeyBytes.fill(0)`, and POST body free of raw newTeamKey hex.
   - E2E cross-reference: `teams.spec.ts`.
   - Mock `useTeamVault` (consumer side); MAY mock `@/lib/crypto/crypto-team` / `crypto-aad` per §Sec-1 with shape-assertion obligations.
   - Run vitest + `next build`; coverage-diff; commit.

10. **Batch C4 — `components/settings/**` (26 files)**:
    - Group by sub-folder: `security`, `developer`, `account`. R23 (mid-stroke input mutation) applies to numeric settings (TTL, retention windows).
    - R27 applies — any rendered limit string must reference the constant, not a literal.
    - **§Sec-7 (WebAuthn/PRF) applies** to `settings/security/passkey-credentials-card.tsx` (registration + test handlers, identical mock shape obligations as `auth/**` passkey components — see §Sec-7(d) for the secretKey zeroization addendum).
    - **Source pre-fix required** (Round 2 S21): `passkey-credentials-card.tsx:213-227` `catch` block does NOT zero `secretKey` or `prfOutput` — it only routes by error message. Before writing the §Sec-7(d) tests, the C4 batch's first commit MUST move `secretKey.fill(0)` and `prfOutput?.fill(0)` from inside the success path (line 172-173) into the surrounding `try { ... } finally { ... }` block so zeroization runs on EVERY code path. The test obligation is currently testing a property the source does not implement; fix the source first, then enforce the test.
    - E2E cross-reference: `settings-*.spec.ts` (api-keys, key-rotation, sessions, travel-mode, passphrase-change).
    - Run vitest + `next build`; coverage-diff; commit.

11. **Batch C5 — `components/{audit,entry-fields,share,auth}/**` (28 files)**:
    - **R12** applies to `audit/audit-action-icons.tsx` ONLY (NOT to `audit-action-filter.tsx` — see §Recurring Issue Check obligations R12 entry). Use `Object.entries(ACTION_ICONS)` iteration on the source's `Partial<Record<AuditActionValue, …>>`; assert call-site fallback `<ScrollText />` for unmapped action.
    - **§Sec-1 share-flow crypto obligations apply** to `share/share-dialog.tsx` (sender) and `share/share-e2e-entry-view.tsx` (recipient) — assert all referrer-meta, history.replaceState, length validation, and zeroization invariants.
    - **§Sec-2 (no-secret-in-DOM) applies** to `share/share-password-gate.tsx` — sentinel `PWGATE_SENTINEL_8H3K`, simulate 429/401, assert sentinel never in DOM.
    - **§Sec-7 (WebAuthn/PRF mock shape, corrected)** applies to `auth/passkey-signin-button.tsx` and `auth/security-key-signin-form.tsx`. Mock target is `@/lib/auth/webauthn/webauthn-client`, NOT `@simplewebauthn/browser` (which is not used by the codebase). Resolved value `{ responseJSON: <fixture>, prfOutput: new Uint8Array(32).fill(0xAB) }`.
    - **§Sec-1 auth obligations apply** to all `auth/**` components — assert no-secret-in-DOM, assert WebAuthn library boundary mocking only.
    - E2E cross-reference: `audit-logs.spec.ts`, `share-link.spec.ts`, `share-link-public.spec.ts`, `send-text.spec.ts`.
    - Run vitest + `next build`; coverage-diff; commit.

12. **Batch C6 — `components/{vault,layout,breakglass,watchtower,tags,emergency-access,admin,sessions,providers,folders}/**` (22 files)**:
    - **`passphrase-strength.ts`** — 4-bit length+character-class score (NOT entropy estimator). Tests enumerate the 4 score branches per §Sec-1 obligation; reference `PASSPHRASE_MIN_LENGTH` from `@/lib/validations` (barrel re-export — `passphrase-strength.ts:6` already imports this way). Assert exact `level/labelKey` per score, including the empty-input branch.
    - Vault consumers — mock context per §Sec-1; MAY mock `@/lib/crypto/crypto-recovery` etc. with shape-assertion obligations.
    - **§Sec-3 cross-tenant denial** for `admin/**` rendering branches (use `mockTeamMismatch()` factory).
    - E2E cross-reference: `vault-lock-relock.spec.ts`, `vault-reset.spec.ts`, `passphrase-change.spec.ts`, `recovery-key.spec.ts`, `tags.spec.ts`, `folders.spec.ts`, `emergency-access.spec.ts`, `admin-*.spec.ts`, `tenant-admin.spec.ts`.
    - Run vitest + `next build`; coverage-diff; commit.

13. **Final pre-PR**:
    - `scripts/pre-pr.sh`
    - `npx vitest run` (full suite green)
    - `npx next build` (green)
    - `npx tsc --noEmit` (mock-vs-real shape check)
    - `npx vitest run --coverage` — final coverage delta vs PR #425 baseline. **Hard gate**: `node scripts/coverage-diff.mjs .coverage-snapshots/post-PR425.json .coverage-snapshots/post-C6.json --files 'src/components/**'` MUST report zero per-file regressions on already-tested files. Tier 3 denominator now has numerator additions; expect noticeable headline % bump.
    - Verify Skip log has rationale + count for each entry; verify e2e-overlap-log entries cite line numbers.
    - **STOP** before opening PR. Report state and await user approval.

---

## Testing strategy

Strategy here verifies the new tests are good, since the work IS testing.

1. **Per-batch coverage delta gate**: every C-batch must strictly increase `lines-covered`. For files with ≥1 instrumented branch, also require `branchGain > 0`. For files with zero instrumented branches (many shadcn UI primitives), `linesGain > 0` alone is sufficient. `scripts/coverage-diff.mjs` enforces this corrected gate (patched in C0a — see §Implementation step 4).
2. **Mock allowlist enforcement**: after each batch, `grep -nE 'vi\.mock\(' src/components/**/*.test.{ts,tsx}` and confirm each argument matches §Non-functional 4. Each `vi.mock(...)` outside the allowlist requires a comment line above it naming the justification (`// boundary: mocking external NPM lib X — reason`). **Plus mock factory return-shape obligation (S104)**: every mocked module's factory must export the same names with same callable signatures as the real module; tests `import type` from the real module to surface drift at TS compile.
3. **Type-driven exhaustiveness for enums** (R12): see §Recurring Issue Check obligations R12 entry — applies to `audit/audit-action-icons.tsx` only (`Partial<Record<AuditActionValue, …>>` iteration); `audit-action-filter.tsx` is dropped (prop-driven).
4. **No `it.skip` / `describe.skip` / `fdescribe` / `fit`** — `scripts/pre-pr.sh` grep gate (added in C0a) enforces. PR #425 did NOT establish this gate; PR2 adds it.
5. **No `// @ts-ignore` / `// @ts-nocheck`** — `scripts/pre-pr.sh` grep gate (added in C0a) + ESLint `@typescript-eslint/ban-ts-comment` enforce.
6. **No `any`** in new test files — ESLint rule `@typescript-eslint/no-explicit-any`. Verify via `grep -n no-explicit-any eslint.config.*` at C0a; if missing from `eslint.config.*`, ADD in C0a alongside `@typescript-eslint/ban-ts-comment` and `@typescript-eslint/no-unused-vars`.
7. **No `process.env.X = ...`** — `scripts/pre-pr.sh` grep gate (added in C0a) enforces; only `vi.stubEnv` is allowed (allowlist `src/__tests__/setup.ts`).
8. **No `vi.mock("node:crypto", ...)`** — `scripts/pre-pr.sh` grep gate (added in C0a) enforces. PR #425 did NOT establish this gate; PR2 adds it.
9. **No-secret-in-DOM gate for dialog/form tests**: per the affected file list (§Sec-2), verify the test contains a `screen.queryByText(SENTINEL_NOT_A_SECRET_ZJYK)` assertion.
10. **Decorative-test detection (sub-agent output verification)**: orchestrator MUST sample 10% of generated tests per batch and apply the assertion-removal probe — comment out each `expect(...)` in the sampled file; the test must FAIL. Failures are reported back to the sub-agent for regeneration. This is not a CI gate — it's a sub-agent-output verification step that catches decorative tests slipping through the coverage-delta gate.
11. **Skip log audit**: every entry in skip-log must have one of these rationales: `pure-types` / `barrel re-export` / `RSC-only` / `E2E covered (cite spec:line)` / `framework-only` / `test-infra` — plus a cited decision rule (e.g., `R# / §Skip decision tree`). Other rationales rejected at review time.

---

## Considerations & constraints

### Risks

1. **Coverage threshold not yet met**: PR #425 reduced the denominator-vs-numerator gap but Tier 3 still pulls headline coverage down. PR2 closes this; expect 60% line threshold to be comfortably exceeded post-merge. If a particular file lands below the 60% per-file mark (e.g., a complex audit log filter), accept it and record in deviation log — the 60% threshold is global not per-file.
2. **Component coupling to context providers**: many components consume `useVault` / `useTeamVault` / `useEmergencyAccessVault`. Mocking these requires a `vi.mock("@/lib/vault/vault-context")` pattern. Mitigated by §Non-functional 4 explicitly allowing these context module mocks. PR #425's Tier 1.5 owns testing the contexts themselves.
3. **Navigation mock surface (two modules)**: components call `useRouter`/`Link` from `@/i18n/navigation` (locale-aware, ~80% of cases) AND `usePathname`/`useRouter` from `next/navigation` (raw). C0b adds `mock-app-navigation.ts` with two factories — see §Reuse over invention.
4. **Server Components vs Client Components — concrete detection rule**: at the start of each C-batch, classify each file with this decision tree (apply in order; first match wins):
   - **Has `"use client";` directive at top** → Client Component → TESTABLE with RTL.
   - **Imports `next/headers`, `next/cookies`, `auth` from `@/lib/auth/auth` (Auth.js v5 server helper), `getServerSession`, or any `react`/`next` server-only API** → RSC-only → skip-log with rationale `"RSC-only — server-only API import"` + cite the import.
   - **Exports an `async function` returning JSX (top-level component is async)** → RSC-only → skip-log.
   - **Otherwise** (plain pure presentation, no async, no server APIs, no `"use client"`) → DEFAULT to TESTABLE with RTL — these compose under either RSC or Client trees and render fine in jsdom. Counter-example concrete: `src/components/audit/audit-action-icons.tsx` has no `"use client"` and no async — pure render — it remains testable with RTL.
   - When ambiguous, attempt `render(<Component />)` in a probe test; if it throws an `Error: ReactServerContainer ...` or RSC-runtime-shaped error, classify RSC-only and skip with the actual error message captured in skip-log. Do NOT silently skip without the probe — the false-positive cost is too high (we'd skip testable components).
5. **shadcn primitive churn**: shadcn updates may rename `data-slot` attributes. C0c tests using `data-slot` selectors are fragile. Prefer accessible-name / role queries; only fall back to `data-slot` when role/aria fails (e.g., styling-only divs).
6. **next-intl side effects in tests**: `useTranslations` calls inside hooks. Mock via `mock-translator.ts` helper. If a component's translation key is missing in fixtures, ADD it to the helper (do NOT inline a one-off mock factory).
7. **Reviewer fatigue if PR exceeds ~50 changed files**: pre-declared fallback to a 2-PR split (per §Non-functional 2). Decision deferred to post-C3 evaluation.
8. **R23 false-positive risk**: not every numeric input in `settings/**` is mid-stroke-clamp-affected. Apply R23 only to inputs that have validation constants drawn from `src/lib/constants/**`; pure free-text / non-validated numeric fields are exempt.

### Out of scope

- Storybook integration / visual regression tests (no `.storybook/` directory exists; separate plan)
- Adding `tsc --noEmit` as a CI gate (per issue #429 — separate hygiene concern)
- Refactoring components beyond `_resetXForTests` testability tweaks
- Raising coverage thresholds in `vitest.config.ts` (post-PR2 follow-up)
- Mutation testing (Stryker etc.) — separate concern

### Anti-deferral log (running)

Track skip / accepted-risk decisions inline during implementation. Mandatory format from triangulate `common-rules.md`:

| Item | Reason / Anti-Deferral check |
|---|---|
| `webhook-card-test-factory.tsx` | Test infrastructure (it IS a test factory — testing it tests Vitest). Anti-Deferral: out of scope (different feature). |
| Pure-types files (`*-types.ts`, ~3 files in inventory) | Pure types — no runtime to test. Anti-Deferral: rejected per common testing.md "tests must fail for a real reason". |
| RSC-only components (TBD at C0c) | Per-file decision; cite `"use client"` absence and the E2E spec covering the page. Anti-Deferral: out of scope (different feature) — testing RSC requires Next.js server runtime, which is E2E's domain. |
| **R26 visual-cue obligation for factory-based tests** | Tests that consume `webhook-card-test-factory.tsx` rely on the underlying `Button` test (`ui/button.test.tsx` in C0c) to verify the disabled-state visual cue. The factory's mocked `Button` strips Tailwind classes intentionally, so visual-cue assertion would be tautological inside factory-based tests. Factory-based tests verify the `disabled` prop wiring (`expect(btn).toBeDisabled()`); the visual cue is verified once at the source via `ui/button.test.tsx`. Anti-Deferral: this is a structural carve-out (R3 propagation has a single owner — the underlying primitive), not a deferral; the cost-to-fix would be re-implementing 23 webhook tests inline (high cost, low marginal value). |
| **`untested-components.txt` regeneration** | Future inventory regen MUST exclude `**/__tests__/**` paths so test factories don't reappear as untested targets. Documented note for the next coverage refresh task. Anti-Deferral: out of scope (process improvement), tracked TODO. |

Update during Phase 2.

---

## User operation scenarios

This plan does not change runtime behavior — only adds tests. Scenarios are about the developer / reviewer workflow:

1. **Developer adds a new shadcn primitive** — pattern is established at C0c; adds sibling `*.test.tsx` with role/aria assertion + R26 disabled-state cue.
2. **Refactor of `audit/audit-action-icons.tsx`** — when adding a new `AuditAction` enum value, the exhaustive `Record<AuditAction, …>` test fails at TypeScript compile until the icon mapping is updated.
3. **CI run on PR touching `auth/passkey-signin-button.tsx`** — security obligation 7 (PRF mock shape) catches consumers that omit the `prf.results.first` extension result, surfacing a class of Auth.js misuse before it reaches QA.
4. **Coverage dashboard** — Tier 3 denominator now has matching numerator; headline % climbs; per-file coverage report is the actionable signal for future PRs.
5. **Reviewer fatigue check** — if PR diff exceeds ~50 changed files, pre-declared 2-PR split kicks in. Reviewer can assess C0–C3 first, then C4–C6.
6. **Future component addition** — new component without a sibling test triggers `scripts/pre-pr.sh` warning (extends from PR #425 hygiene).
