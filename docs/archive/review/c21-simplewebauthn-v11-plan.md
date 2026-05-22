# C21 — @simplewebauthn v9 → v11 migration

> **Round 2 plan** (Round 1 + findings F1-F11, S1-S10, T1-T9 incorporated). See `c21-simplewebauthn-v11-review.md` for the raw round-1 review log.

## Project context

- **Type**: web app (Next.js 16 / Auth.js v5 / Prisma 7)
- **Test infrastructure**: unit (vitest) + integration (real Postgres) + Playwright E2E. **Note (T1)**: NO existing passkey E2E specs — `find e2e/tests -name '*passkey*'` returns 0 files. PRF auto-unlock has no E2E coverage today either. Verification falls to unit + manual smoke test (see Testing strategy).
- **Pre-1.0**: backwards compatibility not strictly required, but PRF-enabled credentials in dev DBs must continue to unlock

## Objective

Bump `@simplewebauthn/server`, `@simplewebauthn/browser`, AND `@simplewebauthn/types` from `^9.0.x` to `^11.0.0` (skipping v10/v12/v13 — see Considerations) to remove a stale crypto dependency from the WebAuthn trust path. Net behavioral change: zero — pure API rename / shape migration. The wire format (registration response, authentication assertion, PRF extension data) MUST stay byte-identical so existing credentials and PRF-wrapped vault keys continue to work.

## Requirements

### Functional

- Registration ceremony (`POST /api/webauthn/register/verify`) accepts the same client payload, persists the same `webauthn_credentials` row shape.
- Authentication ceremony (`POST /api/webauthn/authenticate/verify`, `POST /api/auth/passkey/verify`, `POST /api/auth/passkey/reauth/verify`, `authorizeWebAuthn` in `webauthn-authorize.ts`) accepts the same assertion shape and advances the counter the same way.
- PRF-wrapped vault auto-unlock continues to function for credentials already in DB.
- Discoverable credentials / passkey sign-in continues to work.
- Timing-equalization branch in `webauthn-authorize.ts` (credential-not-found path) MUST continue to invoke `verifyAuthenticationResponse` through the full crypto path. Under v11, the existing all-zeros dummy public key may short-circuit at CBOR decode (faster than the real branch's signature-verify), introducing a credential-enumeration timing oracle. Mitigation: use a valid COSE-encoded P-256 public key as dummy (see C5).

### Non-functional

- No NEW `any`-typed escape hatches added solely to silence v11 strictness — if v11 tightens a type, accept the tighter type or add a precise mapper. Existing `any` clusters (route.ts:103-145, server.ts:124) stay as-is unless v11 makes them resolvable.
- ESLint clean (no new disable comments).
- `npx tsc --noEmit`: 0 errors.
- `npx vitest run`: 100% pass.
- `bash scripts/pre-pr.sh`: 19/19 PASS.
- Manual smoke test plan (see Testing strategy) executed and recorded in `docs/archive/review/c21-simplewebauthn-v11-manual-test.md` before commit.

## Technical approach

### v9 → v11 known breaking changes (source: simplewebauthn v10/v11 release notes)

> **Citation status**: simplewebauthn v10 introduced the bulk of these changes; v11 was a smaller refactor pass. Plan reviewers should verify against the v10 + v11 CHANGELOG URLs (citation unverified offline; see https://github.com/MasterKale/SimpleWebAuthn/releases/tag/v10.0.0 and v11.0.0). Implementer MUST re-verify against `node_modules/@simplewebauthn/server` after `npm install`.

1. **`AuthenticatorDevice` type removed** (v10) — replaced by `WebAuthnCredential` (from `@simplewebauthn/types@^11.0.0`). Field renames in the same step:
   - `credentialID: Uint8Array` → `id: string` (base64url-encoded, NOT Uint8Array)
   - `credentialPublicKey: Uint8Array` → `publicKey: Uint8Array` (renamed, kept binary)
   - `counter: number` → `counter: number` (unchanged)
   - `transports?: AuthenticatorTransportFuture[]` → `transports?: AuthenticatorTransport[]`
2. **`verifyRegistrationResponse` result shape changed** (v10) — `registrationInfo` no longer has top-level `credentialID` / `credentialPublicKey` / `counter`. Instead nested under `registrationInfo.credential.{id, publicKey, counter}`. The string vs Uint8Array distinction applies: `credential.id` is a base64url string, `credential.publicKey` stays binary.
3. **`verifyAuthenticationResponseOpts.authenticator` renamed to `credential`** (v10) of type `WebAuthnCredential`.
4. **`verifyAuthenticationResponse` result shape changed** (v10, correction to round-1 plan claim) — `authenticationInfo.credentialID: Uint8Array` was moved under `authenticationInfo.credential.id: string` in parallel to the registration rename. **Impact on this codebase**: ZERO. The only field this codebase reads on `authenticationInfo` is `.newCounter` (`webauthn-server.ts:392`, `webauthn-authorize.ts:135`), which is unchanged. No consumer reads `authenticationInfo.credentialID`/`credential.id`. Documented here for completeness; no code change required.
5. **`excludeCredentials[].id` and `allowCredentials[].id`** (v10) type changed from `Uint8Array` to `string` (base64url) — `generateRegistrationOptions` / `generateAuthenticationOptions` now expect strings.
6. **Type renames in `@simplewebauthn/types`** (v10):
   - `PublicKeyCredentialDescriptorFuture` → `PublicKeyCredentialDescriptorJSON` (the JSON-flavored descriptor with string id)
   - `AuthenticatorTransportFuture` → `AuthenticatorTransport`
   - Existing imports in `webauthn-server.ts:27-33` must be updated.
7. **`expectedRPID`** accepts `string | string[]` (additive; no migration needed). This project keeps the single-string surface — see C9 for defensive narrowing.
8. **`userID` typing** — v9 accepted `string | Uint8Array`; v11 may have tightened. Current code passes a base64url string (`Buffer.from(userId, 'utf-8').toString('base64url')` at `webauthn-server.ts:111`). Implementer MUST verify v11's `GenerateRegistrationOptionsOpts.userID` type accepts string; if changed to `Uint8Array`, convert via `new TextEncoder().encode(userId)`. See C8.

### Files to touch (10 source + 6 tests + 1 manual-test doc)

| File | Change |
|------|--------|
| `package.json` | bump `@simplewebauthn/server`, `@simplewebauthn/browser`, AND `@simplewebauthn/types` to `^11.0.0`. (caret range preserved per project convention; supply-chain snapshot recorded in commit message, see Testing strategy → Supply chain) |
| `package-lock.json` | regenerated by `npm install` |
| `src/lib/auth/webauthn/webauthn-server.ts` | (1) drop `AuthenticatorDevice` import; import `WebAuthnCredential` from `@simplewebauthn/types`. (2) Drop `PublicKeyCredentialDescriptorFuture` and `AuthenticatorTransportFuture` imports; rely on type inference where possible OR import `PublicKeyCredentialDescriptorJSON` / `AuthenticatorTransport`. (3) `verifyAuthentication()` builds `credential: WebAuthnCredential` (string `id`, Uint8Array `publicKey`, no `credentialID`/`credentialPublicKey` fields) and passes as `credential:` option (not `authenticator:`). (4) `verifyAuthenticationAssertion()` builds the new shape. (5) `generateRegistrationOpts()` `excludeCredentials` constructs descriptors with string `id` (no `base64urlToUint8Array(c.credentialId)` call). (6) `generateAuthenticationOpts()` `allowCredentials` constructs descriptors with string `id` (same). |
| `src/lib/auth/webauthn/webauthn-authorize.ts` | mirror webauthn-server.ts changes: drop `AuthenticatorDevice` import, build `WebAuthnCredential` with string `id`, pass via `credential:` option. **Critical (S3)**: replace `DUMMY_PUBLIC_KEY = new Uint8Array(65)` (all zeros, likely short-circuits in v11 CBOR decode) with a fixed valid COSE-encoded P-256 public key (constant). Replace `DUMMY_CRED_ID = new Uint8Array(32)` with a fixed 43-char base64url string. See C5 for exact constants. |
| `src/app/api/webauthn/register/verify/route.ts` | (1) read `registrationInfo.credential.id` (string, NO `uint8ArrayToBase64url` call needed — it's already base64url). (2) read `registrationInfo.credential.publicKey` (Uint8Array, still convert via `uint8ArrayToBase64url`). (3) read `registrationInfo.credential.counter` (number) — top-level `registrationInfo.counter` is gone. (4) `registrationInfo.credentialDeviceType` and `registrationInfo.credentialBackedUp` stay at top level (per v11 types). |
| `src/lib/auth/webauthn/webauthn-server.test.ts` | mock shape update — none of the currently-tested functions directly touch the changed shapes, but Functionality F9 / Testing T6 require: post-install, verify `mockVerifyAuthLib`'s return shape `{verified, authenticationInfo: {newCounter}}` is type-compatible with v11's `VerifiedAuthenticationResponse`. Type the mock against the real signature (`vi.fn() as Mock<typeof verifyAuthenticationResponse>`) to make structural drift compile-error. |
| `src/lib/auth/webauthn/verify-authentication-assertion.test.ts` | same — type the mock against the real type, verify post-install. |
| `src/lib/auth/webauthn/webauthn-authorize.test.ts` | T4: add `expect.objectContaining({ id: expect.any(String), publicKey: expect.any(Uint8Array), counter: 0 })` assertion on `mockVerifyAuthentication` call's `credential:` argument in BOTH the happy-path test AND the timing-equalization test. This locks in C5's dummy-credential shape. |
| `src/app/api/webauthn/register/verify/route.test.ts` | (1) update `mockRegistrationInfo` at line 133-139 from flat `{credentialID, credentialPublicKey, counter, credentialDeviceType, credentialBackedUp}` to nested `{credential: {id: "AQID" (base64url string), publicKey: Uint8Array([4,5,6]), counter: 0}, credentialDeviceType, credentialBackedUp}`. (2) T5: add `expect(mockPrismaCredentialCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ credentialId: "AQID", publicKey: expect.stringMatching(/^[A-Za-z0-9_-]+$/), counter: 0n }) }))` to ONE happy-path test to lock the post-v11 persisted shape. (3) T8: add `expect(mockUint8ArrayToBase64url).toHaveBeenCalledTimes(1)` (was 2 in v9, now 1 in v11 — only publicKey conversion remains). |
| `docs/archive/review/c21-simplewebauthn-v11-manual-test.md` | NEW — manual smoke test plan covering: (a) fresh passkey registration → row inserted with correct `credentialId`/`publicKey`/`counter` shape; (b) sign-in via discoverable credential → session created; (c) PRF unlock after sign-in → vault auto-unlocks; (d) reauth flow on vault sensitive op; (e) verify dummy timing branch is still hit when a non-existent credential is presented (curl/console). Operator runs against dev DB containing pre-v11 credentials before commit. |

**Verified no change needed (T9 — explicit acknowledgement)**: `src/lib/auth/webauthn/webauthn-client.ts` (uses raw WebAuthn API, not `@simplewebauthn/browser`; line 6-8 comment confirms intentional). `src/lib/auth/webauthn/webauthn-client.test.ts`, `passkey-reauth-client.test.ts`, `recent-passkey-verification.test.ts` (no `@simplewebauthn` imports — verified by grep). `src/components/auth/passkey-signin-button.test.tsx` (line 47 comment explicitly states it mocks `@/lib/auth/webauthn/webauthn-client`, NOT `@simplewebauthn/browser` — verified by grep).

**Routes that USE `verifyAuthenticationAssertion()` (verified no direct shape touch, but require post-install re-run)**:
- `src/app/api/webauthn/authenticate/verify/route.ts` and `.test.ts`
- `src/app/api/webauthn/credentials/[id]/prf/route.ts` and `.test.ts`
- `src/app/api/auth/passkey/verify/route.ts` and `.test.ts`
- `src/app/api/auth/passkey/reauth/verify/route.ts` and `.test.ts`

### Wire format (unchanged) — proof of compatibility

| Surface | v9 representation | v11 representation | Compatibility |
|---------|-------------------|-------------------|---------------|
| `webauthn_credentials.credentialId` (DB column) | base64url string | base64url string (unchanged) | ✅ |
| `webauthn_credentials.publicKey` (DB column) | base64url string of COSE key | base64url string of COSE key (unchanged) | ✅ |
| `webauthn_credentials.counter` (DB column) | bigint | bigint (unchanged) | ✅ |
| Client→server registration payload (JSON) | base64url-encoded fields per WebAuthn-3 spec | unchanged | ✅ |
| Client→server authentication payload (JSON) | unchanged | unchanged | ✅ |
| PRF extension input/output | raw ArrayBuffer in browser, hex-string on wire | unchanged (handled by raw WebAuthn API client, not `@simplewebauthn/browser` — confirmed `webauthn-client.ts:5-8,232-238,295-301`) | ✅ |

The only thing changing is the INTERNAL Node-side shape we hand into / out of `@simplewebauthn/server` calls. Everything we persist or send over the network stays identical.

### Replay safety (S6 — explicit affirmation)

Captured v9 assertions replayed against a v11 server are mitigated by:
- (a) Redis `getdel` one-shot challenge consumption (`webauthn-server.ts:325`, `webauthn-authorize.ts:74`) — same code path, version-independent
- (b) DB counter CAS (`webauthn-server.ts:394-401`, `webauthn-authorize.ts:147-154`) — same SQL, version-independent
- (c) Tx-scoped counter advance for PRF rebootstrap — same prisma plumbing, version-independent

simplewebauthn v9↔v11 is irrelevant to the replay defense.

### PRF chain (S9 — explicit affirmation)

The PRF chain (`WEBAUTHN_PRF_SECRET → HKDF-SHA256 → PRF salt → browser PRF eval → AES-256-GCM wrap`) is wholly outside the v9↔v11 boundary:
- `derivePrfSalt()` uses `node:crypto` `hkdfSync` only (`webauthn-server.ts:216-224`)
- `derivePrfWrappingKey()` uses Web Crypto `crypto.subtle.deriveKey` only (`webauthn-client.ts:142-165`)
- PRF extension is invoked via raw `navigator.credentials.create/get` with `extensions: { prf: ... }` (`webauthn-client.ts:232-238,295-301`), bypassing `@simplewebauthn/browser`

Implementer MUST verify these files are NOT touched by the v11 migration.

## Contracts

### C1 — `verifyAuthentication()` accepts `WebAuthnCredential`, not `AuthenticatorDevice`

- **Signature**: `verifyAuthentication(response: AuthenticationResponseJSON, expectedChallenge: string, rpId: string, rpOrigin: string, credential: WebAuthnCredential): Promise<VerifiedAuthenticationResponse>`
- **Invariants**:
  - The `credential` argument's `id` is a base64url string (NOT `Uint8Array`), matching what is stored in `webauthn_credentials.credentialId`. No `base64urlToUint8Array(...)` conversion at the call site.
  - The `credential` argument's `publicKey` is a `Uint8Array` decoded from the stored base64url string. Same as today — only the field name changes.
  - `counter` and `transports` semantics unchanged.
- **Forbidden patterns**:
  - `pattern: "AuthenticatorDevice" — reason: removed in v10, must not appear in src/ diff (test files may legitimately reference it in legacy mock comments)`
  - `pattern: "credentialID:" — reason: v9 field name, replaced by "id" in WebAuthnCredential. Test fixtures only — flag in src/.`
  - `pattern: "credentialPublicKey:" — reason: v9 field name, replaced by "publicKey"`
  - `pattern: "authenticator:" (within VerifyAuthenticationResponseOpts construction in src/lib/auth/webauthn/) — reason: v9 option name, replaced by "credential:"`
- **Acceptance**: `verifyAuthentication()` passes the same set of tests as today; `WebAuthnCredential` import is the only new symbol from `@simplewebauthn/types`.

### C2 — Registration result fields move under `registrationInfo.credential.*`

- **Signature**: caller of `verifyRegistration(...)` reads `verification.registrationInfo.credential.id` (string), `verification.registrationInfo.credential.publicKey` (Uint8Array), `verification.registrationInfo.credential.counter` (number), plus top-level `verification.registrationInfo.credentialDeviceType` / `credentialBackedUp`.
- **Invariants**:
  - `credential.id` is the base64url string stored directly in `webauthn_credentials.credentialId` — NO `uint8ArrayToBase64url` conversion needed.
  - `credential.publicKey` is still binary and converted via `uint8ArrayToBase64url(publicKey)` before persistence.
- **Forbidden patterns**:
  - `pattern: "registrationInfo.credentialID" — reason: v9 top-level field, moved under credential.id`
  - `pattern: "registrationInfo.credentialPublicKey" — reason: v9 top-level field, moved under credential.publicKey`
  - `pattern: "registrationInfo.counter" — reason: v9 top-level field, moved under credential.counter`
- **Acceptance**: `POST /api/webauthn/register/verify` persists the same `webauthn_credentials` row given the same client payload, byte-for-byte. Asserted in route test via T5 fix.

### C3 — `excludeCredentials[].id` is a base64url string (not Uint8Array)

- **Signature**: `generateRegistrationOpts(userId, userName, existingCredentials)` constructs descriptors with string `id`. Type should be `PublicKeyCredentialDescriptorJSON[]` (v10+ rename from `PublicKeyCredentialDescriptorFuture[]`), OR omit the explicit annotation and let TS infer from the v11 `GenerateRegistrationOptionsOpts` shape.
- **Invariants**: `existingCredentials[].credentialId` (the stored base64url string) is passed through verbatim — no `base64urlToUint8Array` conversion.
- **Forbidden patterns**:
  - `pattern: "id: base64urlToUint8Array(c.credentialId)" — reason: v9 conversion, must not appear in v11 excludeCredentials/allowCredentials construction`
  - `pattern: "PublicKeyCredentialDescriptorFuture" — reason: removed in v10/v11, use PublicKeyCredentialDescriptorJSON or let TS infer`
  - `pattern: "AuthenticatorTransportFuture" — reason: removed in v10/v11, use AuthenticatorTransport`
- **Acceptance**: `generateRegistrationOptions` accepts our shape without runtime error and returns options whose `excludeCredentials[].id` is a string the browser will accept.

### C4 — `allowCredentials[].id` is a base64url string (not Uint8Array)

Same as C3 but for `generateAuthenticationOpts` and downstream authentication flow.

- **Acceptance**: `generateAuthenticationOptions` produces options with string `id` per credential.

### C5 — Dummy timing-equalization branch uses valid COSE-encoded P-256 key

- **Signature**: when no credential is found, build a placeholder `WebAuthnCredential` with:
  - `id`: a fixed 43-char base64url string of all 'A' chars (`"A".repeat(43)`) representing a 32-byte dummy ID — matches the byte-length of the prior `DUMMY_CRED_ID = new Uint8Array(32)`.
  - `publicKey`: a fixed COSE-encoded P-256 public key constant. The encoded bytes represent a valid (but non-secret-key-bound) EC2 public key per [COSE RFC 8152 §13.1](https://www.rfc-editor.org/rfc/rfc8152#section-13.1). Hardcoded as a `Uint8Array` literal (~77 bytes). Generated once via standard P-256 keygen; the private key is discarded — only the public-key COSE encoding is committed. This ensures v11's `verifyAuthenticationResponse` proceeds through CBOR decode + signature verify (matching the real branch's CPU profile) and returns `verified: false` due to signature mismatch, not throws early.
  - `counter: 0`
  - `transports`: omitted (optional per `WebAuthnCredential` v11 type)
- **Invariants**:
  - The dummy branch ALWAYS produces `verification.verified === false` (or a controlled throw absorbed by `try/catch` at `webauthn-authorize.ts:124-139`).
  - The dummy branch's CPU cost is within an order of magnitude of the real branch (both perform CBOR decode + ECDSA verify). Verified by manual benchmarking in the manual-test artifact.
- **Forbidden patterns**:
  - `pattern: "DUMMY_CRED_ID = new Uint8Array" — reason: v11 expects string id; use base64url string literal`
  - `pattern: "DUMMY_PUBLIC_KEY = new Uint8Array(65)" — reason: zero-byte public key likely short-circuits in v11 CBOR decode, breaking timing equalization`
- **Acceptance**: T4 test assertion on dummy-credential shape passes; manual benchmark confirms dummy/real timing parity within 2×.

### C6 — `verifyAuthenticationAssertion()` builds new credential shape

- **Signature**: same exported signature; INTERNALLY the construction `const authenticator: AuthenticatorDevice = { credentialPublicKey: ..., credentialID: ..., counter: ..., transports: ... }` becomes `const credential: WebAuthnCredential = { id: storedCredential.credentialId, publicKey: base64urlToUint8Array(storedCredential.publicKey), counter: Number(storedCredential.counter), transports: storedCredential.transports as AuthenticatorTransport[] }`.
- **Invariants**: pass into `verifyAuthentication` as the new `credential` argument.
- **Acceptance**: PRF rebootstrap, sign-in, and reauth all continue to pass their existing tests post-install.

### C7 — `@simplewebauthn/browser` bumped to v11 even though unused (T3)

- **Signature**: `@simplewebauthn/browser@^11.0.0` is bumped for ecosystem hygiene only. This project does NOT import from `@simplewebauthn/browser` (`webauthn-client.ts:5-8` comment explicitly explains the raw WebAuthn API choice). `passkey-signin-button.test.tsx:47` comment confirms test side also bypasses it.
- **Acceptance**: `grep -r "@simplewebauthn/browser" src/` returns no matches; `package.json` shows `^11.0.0`; `npm install` resolves without peer-dep error.

### C8 — `userID` typing post-v11 verified (S7 follow-up)

- **Signature**: `generateRegistrationOpts()` passes `userID: Buffer.from(userId, "utf-8").toString("base64url")` (a base64url string). v11 `GenerateRegistrationOptionsOpts.userID` may accept `string | Uint8Array` (v9 behavior preserved) OR may have tightened to `Uint8Array` only.
- **Invariants**: implementer MUST verify post-install. If string-acceptance is preserved, no change. If string-rejection, convert to Uint8Array: `userID: new TextEncoder().encode(userId)` and document in code.
- **Forbidden patterns**: none — verification step only.
- **Acceptance**: `npx tsc --noEmit` clean; first-time passkey registration smoke test passes.

### C9 — `expectedRPID` narrowed defensively to `string` (S4)

- **Signature**: keep our wrapper `verifyAuthentication(..., rpId: string, ...)` typed as `string`, not `string | string[]`. v11 widens the underlying lib's accepted type, but the project's wrapper rejects array.
- **Invariants**: no future code path passes `string[]` to the underlying lib via this wrapper.
- **Forbidden patterns**:
  - `pattern: "expectedRPID: [" — reason: array form of expectedRPID, project policy is single-RPID only; if multi-RPID needed, requires explicit security review`
- **Acceptance**: type-checks accept only single-string rpId; no array-form expectedRPID anywhere in src/.

### C10 — Auth.js `@auth/core` WebAuthn provider remains dead code (S1, defense-in-depth)

- **Signature**: this project does NOT use `@auth/core/providers/passkey` or `@auth/core/providers/webauthn`. The `@auth/core` package transitively peer-deps `@simplewebauthn/server@^9.0.2`; bumping the project's direct dep to v11 means the dead code path in `@auth/core` is incompatible with the runtime lib. As long as we don't enable it, no risk. Risk is purely "future contributor enables it without knowing".
- **Invariants**: no import of `@auth/core/providers/passkey` or `@auth/core/providers/webauthn` anywhere in src/.
- **Forbidden patterns**:
  - `pattern: "@auth/core/providers/passkey" — reason: incompatible with v11 server; do not enable until Auth.js bumps its peer dep`
  - `pattern: "@auth/core/providers/webauthn" — reason: same`
- **Acceptance**: `grep -r "@auth/core/providers/passkey\|@auth/core/providers/webauthn" src/` returns empty. Add to pre-pr.sh or eslint-plugin-import config (cost-to-fix < 30 min, deferral disallowed under Anti-Deferral 30-minute rule). Actual mechanism: add to `scripts/pre-pr.sh` grep list (already has similar guards).

### Consumer-flow walkthroughs

#### C1 consumer: `verifyAuthenticationAssertion()` (webauthn-server.ts:313)
Reads `{ ok, credentialId, storedPrf }` from C6's shape; `credentialId` is the same base64url string today. Uses `credentialId` to (a) emit audit logs, (b) populate the API response. No new fields needed.

#### C1 consumer: `authorizeWebAuthn()` (webauthn-authorize.ts:53)
Reads `verifiedResult.authenticationInfo.newCounter` to advance the counter via raw SQL CAS. `authenticationInfo.newCounter` is unchanged in v11 (verified above; the parallel rename `authenticationInfo.credentialID → authenticationInfo.credential.id` does not affect this consumer because it never reads credentialID).

#### C2 consumer: `POST /api/webauthn/register/verify` route handler
Reads `registrationInfo.credential.id` (now a base64url string) and persists directly to `webauthn_credentials.credentialId`. Reads `registrationInfo.credential.publicKey` (still Uint8Array), converts via `uint8ArrayToBase64url`, persists to `webauthn_credentials.publicKey`. Reads `registrationInfo.credential.counter` (number) for the row's `counter` BigInt field. Reads `registrationInfo.credentialDeviceType` and `registrationInfo.credentialBackedUp` (still top-level — confirmed by v11 type defs).

#### C3 / C4 consumer: browser
Receives `{ excludeCredentials | allowCredentials: [{ id: <base64url string>, type, transports }] }`. The browser-side `toCreationOptions` / `toRequestOptions` in `webauthn-client.ts` already decodes `c.id` from base64url to ArrayBuffer (lines 57-61, 75-79) — this path is independent of `@simplewebauthn/server` and stays correct because v11 emits strings (which is what the client expects to decode).

#### C6 consumer: PRF rebootstrap route (`/api/webauthn/credentials/[id]/prf`)
Uses `verifyAuthenticationAssertion()` whose internal `credential:` plumbing is the only change. The route's API surface (request body shape, response shape, audit emission) is untouched.

## Testing strategy

### Unit

- Re-run `npx vitest run` after each file change. Targeted re-run for files most likely to break: `webauthn-server.test.ts`, `register/verify/route.test.ts`, `verify-authentication-assertion.test.ts`, `webauthn-authorize.test.ts`.
- Update the single test fixture in `register/verify/route.test.ts:133-139` per Files-to-touch.
- T4 fix: add assertion on `mockVerifyAuthentication` call's `credential:` argument in `webauthn-authorize.test.ts` (both happy-path AND timing-equalization tests).
- T5 fix: add `expect.objectContaining({ data: ... })` assertion in register/verify route test.
- T6 fix: type the lib mocks against the real `typeof verifyAuthenticationResponse` / `verifyRegistrationResponse` to make structural drift compile-error.
- T8 fix: add call-count assertion on `mockUint8ArrayToBase64url` (1 call in v11, was 2 in v9).

### Integration (T7 — explicit acknowledgement of gap)

The project has NO db-integration test that exercises the WebAuthn ceremony end-to-end (verified via grep on `src/__tests__/db-integration/` and `src/__tests__/integration/`). The Round-1 plan's claim "`npm run test:integration` (if it exercises WebAuthn paths — verify)" is misleading. **Replacement**: rely on (a) unit + R19 mock-shape verification, (b) manual smoke test below. **Out-of-scope follow-up**: add a db-integration test that inserts a known-format `webauthn_credentials` row, calls `verifyAuthenticationAssertion` with a fixture assertion (lib boundary mocked, real DB + RLS), and asserts counter advance. TODO(c21-followup): file as separate task.

### E2E (T1 — explicit acknowledgement of gap)

The project has NO passkey E2E specs (verified via `find e2e/tests -name '*passkey*'` returns 0 files, AND `grep -rln 'PRF\|passkey\|webauthn\|@simplewebauthn'` returns only admin-IA navigation specs that route to passkey URLs but exercise no ceremony). The Round-1 plan's claim "`npx playwright test passkey` 100% pass" is a vacuous gate — zero matching tests = trivially zero failures. **Replacement**: skip the E2E gate; rely on manual smoke test below. **Out-of-scope follow-up**: add Playwright virtual-authenticator specs for (a) registration, (b) discoverable sign-in, (c) PRF unlock, (d) reauth. TODO(c21-followup): file as separate task (significant scope, separate PR).

### Manual smoke test (T1+T2+T7 replacement gate)

Recorded in `docs/archive/review/c21-simplewebauthn-v11-manual-test.md`. Operator MUST execute all steps and check off the result list before commit:

- **Pre-conditions**: dev DB containing at least one pre-existing v9-format `webauthn_credentials` row (PRF-enabled if possible). Snapshot DB before test.
- **Steps**:
  1. `npm run dev` — confirm server boots clean
  2. Sign in as a user with the existing passkey → confirm session created
  3. Confirm vault auto-unlocks via PRF (if PRF-enabled credential)
  4. Register a NEW passkey from settings → confirm row inserted with correct shape (compare `credentialId`/`publicKey` byte-length to pre-existing row via psql)
  5. Sign out, sign in with the NEW passkey → confirm session created
  6. Trigger reauth (vault sensitive op, e.g., view password) → confirm reauth flow completes
  7. Simulate non-existent credential: in browser DevTools, modify the assertion `id` field to an unregistered base64url string and submit → confirm response is generic auth failure (no enumeration leak)
  8. Verify counter advanced in DB after each successful auth
- **Expected result**: all 8 steps succeed; DB rows pre/post identical in shape (only counter changes).
- **Rollback**: if any step fails, `git revert` the v11 commit BEFORE production deploy.

### Pre-PR

- `bash scripts/pre-pr.sh` — must be 19/19 PASS.
- Supply chain snapshot (S8): commit message MUST include `npm ls @simplewebauthn/server` output diff (transitive deps before vs after). Add new transitive deps must be checked against `npm audit` (no high/critical CVEs).

## Considerations & constraints

### Why v11 and not v13?

The user instruction explicitly requests v11. v13 is the current latest and would include additional breaking changes (v12 / v13 surface diff not analyzed in this PR). Going to v11 keeps the diff scoped. **Deferred**: TODO(c21-v13-upgrade): after C21 lands, schedule a separate upgrade to v13 to stay current.

### Forward compatibility with A02-8

A02-8 (PRF per-credential salt, the next task on this branch) adds a column `webauthn_credentials.prfSalt`. C21's diff touches `webauthn-server.ts` in the same module as A02-8 will. To avoid merge friction within this branch, C21 lands FIRST and A02-8 builds on the new v11 surface.

### Supply chain (S8)

Snapshot the transitive dep tree before and after `npm install`. Verify the v11 tree is not LARGER than v9 (per simplewebauthn release notes, v10 removed `cross-fetch`; v11 made smaller refactors). Any new transitive package must:
- Have no known high/critical CVEs (per `npm audit`)
- Be actively maintained (last commit ≤ 12 months)
- Be on an established maintainer (not a typosquat)

Document the snapshot in the commit message body.

### Risk: PRF auto-unlock regression

If C1/C6 introduces a shape mismatch that escapes type checking (e.g., `credential.id` accidentally encoded as Uint8Array, or `publicKey` accidentally encoded as base64url string), authentication will fail and existing PRF-unlocked users will be locked out. Mitigation:

- Mandatory manual smoke test (above) before commit.
- Explicit type annotation `const credential: WebAuthnCredential = ...` at every construction site (so TypeScript rejects mismatches at compile time).
- T4/T5 unit-test assertions on mock argument shapes catch a class of mock-reality regressions even without integration tests.

### Out of scope

- PRF per-credential salt (A02-8 — separate task on same branch)
- New WebAuthn features in v11 (e.g., conditional UI improvements, attestation enhancements)
- BYO authenticator metadata service (MDS) verification
- Switching the browser side from raw WebAuthn API to `@simplewebauthn/browser` (the project intentionally uses raw API for PRF control — confirmed in `webauthn-client.ts:5-8` comment)
- Adding passkey E2E specs (separate follow-up — see TODO above)
- Adding db-integration tests for WebAuthn ceremony (separate follow-up — see TODO above)

## User operation scenarios

- **Existing user with PRF-enabled passkey**: Signs in via passkey → vault auto-unlocks via PRF → list passwords. Wire format unchanged; INTERNAL v9→v11 rename invisible to user.
- **New user registering first passkey**: Sees the registration prompt → completes attestation → row inserted into `webauthn_credentials` with same column shape as before.
- **User adding security key to existing account**: Discoverability flag persists correctly; subsequent sign-in uses discoverable flow.
- **User on Windows Hello with counter==0 device** (existing OWASP A07-2 edge case): C10 audit telemetry continues to fire since `newCounter` field on `authenticationInfo` is unchanged in v11.
- **Attacker probing for credential existence** (S3): sends an assertion with an arbitrary credential ID → server hits the dummy branch with a valid COSE-shaped placeholder → `verifyAuthenticationResponse` completes the full ECDSA verify (returns `verified: false`) → response timing matches a real credential's verify-failed timing → no enumeration leak.

## Go/No-Go Gate

| ID  | Subject                                                          | Status |
|-----|------------------------------------------------------------------|--------|
| C1  | verifyAuthentication accepts WebAuthnCredential                  | locked |
| C2  | Registration result reads from registrationInfo.credential.*     | locked |
| C3  | excludeCredentials[].id is base64url string                      | locked |
| C4  | allowCredentials[].id is base64url string                        | locked |
| C5  | Dummy timing-equalization uses valid COSE-encoded P-256 key      | locked |
| C6  | verifyAuthenticationAssertion builds new credential shape        | locked |
| C7  | @simplewebauthn/browser bumped (unused) for ecosystem hygiene    | locked |
| C8  | userID typing post-v11 verified                                  | locked |
| C9  | expectedRPID narrowed defensively to string                      | locked |
| C10 | @auth/core WebAuthn provider remains dead code (grep guard)      | locked |
