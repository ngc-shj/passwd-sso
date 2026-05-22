# A02-8 — WebAuthn PRF per-credential salt (v2)

> **Plan v2** — round-1 review (3 expert sub-agents) found Critical scope gaps (F1/F2/F3 — post-login unlock / PRF rebootstrap / credential test all missed), a Major race-condition design bug (S1/F7 — silent credential brick), and many test-coverage gaps. User direction (2026-05-23): expand scope to cover every PRF salt code path that has known credential ID. Discoverable signin alone keeps the legacy v1 salt. See `a02-8-prf-per-credential-salt-review.md` for the round-1 findings consolidation.

## Project context

- **Type**: web app (Next.js 16 / Auth.js v5 / Prisma 7)
- **Test infrastructure**: vitest unit + integration (real Postgres). No passkey/PRF Playwright specs (verified by C21 review). Manual smoke test is the primary regression net.
- **Pre-1.0**: existing PRF-enabled credentials in dev DBs must continue to unlock.
- **Builds on C21**: `@simplewebauthn` v11 is already landed; `WebAuthnCredential` types use string `id`, Uint8Array `publicKey`.

## Objective

Add a per-credential PRF salt (`prfSalt`) to the `WebAuthnCredential` model. Replace the RP-global v1 salt with a v2 derivation `salt = HKDF(ikm = WEBAUTHN_PRF_SECRET, salt = perCredentialSalt, info = "webauthn-prf-credential-v2", L = 32)` on every PRF code path that has a known credential ID. Discoverable signin keeps the v1 RP-global salt for backward compatibility.

**Forward-secrecy posture (S3 clarification)**: salt is the INPUT to PRF(authenticator_secret, salt). Salt secrecy alone does not crack a wrap — the attacker also needs (i) the authenticator hardware, or (ii) a previously captured PRF output. Per-credential salt narrows the forward-secrecy window: if `WEBAUTHN_PRF_SECRET` leaks but the DB does not, v2 wraps remain safe AGAINST FUTURE UNLOCK CEREMONIES (the attacker cannot pre-compute the salt without per-cred salt from DB). It does NOT change the rotation properties of `WEBAUTHN_PRF_SECRET` — see Considerations.

## Scope decision

User direction 2026-05-23: per-credential salt applies wherever the server knows the credential ID at the time of building PRF options. Discoverable signin (where the server does not know the credential ahead of the ceremony) keeps the legacy v1 RP-global salt.

| Path | Credential ID known? | v2 applies? |
|------|---------------------|-------------|
| Register options/verify (new credential) | yes (about to be created) | yes |
| Email-based signin options | yes (looked up by email) | yes |
| Post-login PRF unlock (`/api/webauthn/authenticate/options`) | yes (signed-in user's credentials) | yes |
| PRF rebootstrap (`/api/webauthn/credentials/[id]/prf/options`) | yes (cred id in URL) | yes |
| Discoverable signin (`/api/auth/passkey/options`) | NO | NO — v1 RP-global continues |
| `/api/auth/passkey/reauth/options` | yes (signed-in user) | yes |

After A02-8 lands:
- v1 credentials (NULL prfSalt) keep working everywhere using v1 salt fallback.
- v2 credentials work everywhere EXCEPT discoverable signin, where PRF auto-unlock fails and the user falls back to passphrase. Documented behavior change.

## Requirements

### Functional

- Existing PRF-enabled credentials (NULL `prfSalt`) continue to unlock via every flow using the v1 RP-global salt fallback. No re-registration required.
- New credentials registered after A02-8 lands receive a random 32-byte per-credential salt persisted to `webauthn_credentials.prf_salt`. Their wraps are bound to the v2 salt derivation.
- Each PRF-options-generating route (register, email-signin, post-login authenticate, PRF rebootstrap, passkey reauth) returns the correct salt(s) for the credentials it knows about:
  - All v1 (NULL prfSalt): send `extensions.prf.eval.first = <v1 salt>` only.
  - All v2: send `extensions.prf.evalByCredential = { <credId>: { first: <v2 salt> } }` per credential. NO top-level `eval`.
  - Mixed v1/v2: send BOTH `extensions.prf.eval.first = <v1 salt>` (fallback for v1 creds) AND `extensions.prf.evalByCredential` (v2 overrides).
- Discoverable signin: unchanged. v1 RP-global only. v2 creds fail PRF unlock here and fall back to passphrase. Documented in CHANGELOG.
- Browser client (`webauthn-client.ts:startPasskeyAuthentication`) accepts and forwards both `prfSalt` (top-level eval) and an optional `evalByCredential` parameter.
- Race-condition safety (S1/F7 fix): the per-cred salt cached at register/options time is **atomically tied to the challenge** so that if two concurrent register-options requests overlap, the second's verify will use the second's salt and the first's verify will fail (`getdel` returns null → no row created).
- Migration script: read-only diagnostic.

### Non-functional

- No new `any` escape hatches.
- ESLint clean; `npx tsc --noEmit`: pre-existing errors only.
- `npx vitest run`: 100% pass.
- `bash scripts/pre-pr.sh`: 20/20 PASS.
- Manual smoke test (concrete, executable — T9 fix) records each operation step + expected DB / network state.

## Technical approach

### Schema change (additive, nullable)

`prisma/schema.prisma` `WebAuthnCredential` model:

```prisma
prfSalt String? @map("prf_salt") @db.VarChar(64) // 32-byte hex, immutable per credential
```

Migration: pure additive (`ALTER TABLE webauthn_credentials ADD COLUMN prf_salt VARCHAR(64) NULL`). No CHECK constraint at DB level (validated at application boundary — see C2).

### derivePrfSaltV2 helper (input-validated)

`src/lib/auth/webauthn/webauthn-server.ts`:

```ts
const PER_CRED_SALT_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Per-credential PRF salt derivation (v2).
 *
 * salt = HKDF(ikm = WEBAUTHN_PRF_SECRET, salt = perCredentialSalt, info = "webauthn-prf-credential-v2", L = 32)
 *
 * `WEBAUTHN_PRF_SECRET` is the IKM (input keying material); `perCredentialSalt`
 * is the random 32-byte per-credential salt stored in the DB. Both contribute
 * entropy to the derived PRK via HKDF-Extract; the `info` string provides
 * domain separation from the v1 `prf-vault-unlock-v1` derivation.
 *
 * Output is sent to the browser via `extensions.prf.eval.first` or
 * `extensions.prf.evalByCredential[<credId>].first`. The browser uses it as
 * input to PRF(authenticator_secret, salt); the resulting PRF output is then
 * HKDF-derived (separately) into an AES-GCM key for vault wrap/unwrap.
 *
 * Throws if WEBAUTHN_PRF_SECRET is unset, or if perCredentialSalt is not
 * 64 lowercase-hex chars (Buffer.from(...,"hex") silently truncates invalid
 * hex, so we validate before calling).
 *
 * Returns 64-char lowercase hex.
 */
export function derivePrfSaltV2(perCredentialSalt: string): string {
  if (!PER_CRED_SALT_HEX_RE.test(perCredentialSalt)) {
    throw new Error("derivePrfSaltV2: perCredentialSalt must be 64 hex chars");
  }
  const ikm = getPrfSecret();
  const salt = Buffer.from(perCredentialSalt, "hex");
  const info = Buffer.from("webauthn-prf-credential-v2", "utf-8");
  const derived = hkdfSync("sha256", ikm, salt, info, 32);
  return Buffer.from(derived).toString("hex");
}
```

Legacy `derivePrfSalt()` (v1) stays unchanged.

### Server-side helper: buildPrfExtensions

Single helper used by every options route to construct the PRF extension input from a list of credentials. Avoids per-route reimplementation (R1).

```ts
/**
 * Build the WebAuthn PRF extension input from a list of credentials.
 *
 * Behavior:
 *   - all-v1 (every cred has NULL prfSalt): { eval: { first: <v1 RP-global> } }
 *   - all-v2 (every cred has non-NULL prfSalt): { evalByCredential: { ... } }
 *   - mixed: { eval: { first: <v1 RP-global> }, evalByCredential: { ...v2 only } }
 *
 * Returns null if WEBAUTHN_PRF_SECRET is unset (PRF disabled).
 *
 * Credential ID encoding: keys of evalByCredential are base64url (WebAuthn-3
 * §10.1.4). The stored credentialId column is already base64url — passed
 * through verbatim.
 */
export function buildPrfExtensions(
  credentials: Array<{ credentialId: string; prfSalt: string | null }>,
): {
  eval?: { first: string };
  evalByCredential?: Record<string, { first: string }>;
} | null {
  let v1Salt: string | null = null;
  try {
    v1Salt = derivePrfSalt();
  } catch {
    return null; // PRF disabled
  }

  const evalByCredential: Record<string, { first: string }> = {};
  let hasV1 = false;
  let hasV2 = false;

  for (const c of credentials) {
    if (c.prfSalt) {
      evalByCredential[c.credentialId] = { first: derivePrfSaltV2(c.prfSalt) };
      hasV2 = true;
    } else {
      hasV1 = true;
    }
  }

  const result: { eval?: { first: string }; evalByCredential?: Record<string, { first: string }> } = {};
  if (hasV1) result.eval = { first: v1Salt };
  if (hasV2) result.evalByCredential = evalByCredential;
  return result;
}
```

### Register flow (atomic challenge+salt to fix S1/F7)

`/api/webauthn/register/options`:
- Generate `perCredentialSalt = randomBytes(32).toString("hex")`
- Cache `{ challenge, prfSalt: perCredentialSalt }` as JSON in Redis at the existing key `webauthn:challenge:register:${userId}` (TTL = `CHALLENGE_TTL_SECONDS`).
  - **This replaces today's plain-string `challenge` storage**. The same key, the same TTL, the same one-shot semantics — but the value is now a small JSON envelope.
- Migration of the key value format: forward-only. Any in-flight register options request started before A02-8 lands and verified after will read the old string format → JSON.parse throws → verify fails with VALIDATION_ERROR. Acceptable (300s TTL window during a deploy).
- Compute `prfSalt = derivePrfSaltV2(perCredentialSalt)` ONLY if PRF is enabled. If `WEBAUTHN_PRF_SECRET` is unset: skip the per-cred salt entirely (no Redis JSON envelope change; store `{ challenge, prfSalt: null }`); return `{ options, prfSupported: false, prfSalt: null }`.
- Order of ops (F9): random salt generated → JSON envelope written to Redis → `derivePrfSaltV2` (may throw if SECRET is unset; catch and downgrade to v1-disabled flow; in that case Redis envelope holds `prfSalt: null`) → response returned.

`/api/webauthn/register/verify`:
- `redis.getdel("webauthn:challenge:register:${userId}")` returns the JSON envelope. Parse it. If parse fails: VALIDATION_ERROR (mid-deploy or replay).
- Extract `{ challenge, prfSalt: perCredentialSalt }` from the envelope. Use `challenge` for WebAuthn verification (unchanged behavior).
- After verification succeeds AND `hasPrf` (credential reported PRF wrap fields) AND `perCredentialSalt !== null`:
  - Validate `perCredentialSalt` against `PER_CRED_SALT_HEX_RE` before persisting (defense-in-depth against tampered Redis values — S4 fix).
  - Persist as `prfSalt = perCredentialSalt` on the new `webauthn_credentials` row.
- Otherwise persist `prfSalt = null`.
- Atomicity (S2 fix): the `redis.getdel` happens once at the top of the route, BEFORE the verify call. If verify throws, the salt is consumed but no row is created. The pending state is GONE (no leaked salt). On user retry, they start a fresh register/options cycle with a new salt.

### Email-based signin flow

`/api/auth/passkey/options/email`:
- Lookup credentials with `select: { credentialId, transports, prfSalt }` (add `prfSalt` to the existing select — F8).
- Call `buildPrfExtensions(credentials)`.
- Merge the returned PRF extensions into the options (server-side build of `options.extensions.prf`; the client just receives the options and forwards them — F4 resolution: SERVER builds the extensions field).
- Response shape: existing `{ options, challengeId, prfSalt }` stays. The `prfSalt` field is preserved for backward compat (top-level v1 fallback). The new `extensions.prf.evalByCredential` lives inside `options.extensions`.

### Post-login PRF unlock (F1 — was missed in v1 plan)

`/api/webauthn/authenticate/options`:
- Already calls `generateAuthenticationOpts(allowCredentials)`. Currently passes `prfSalt = derivePrfSalt()` to the response top-level.
- Change: same as email-based signin — lookup credentials with `prfSalt` selected; call `buildPrfExtensions`; merge into options.

### PRF rebootstrap (F2 — was missed in v1 plan)

`/api/webauthn/credentials/[id]/prf/options`:
- Single credential context. Look up the specific credential's `prfSalt`.
- Same `buildPrfExtensions` call but with a one-element array.
- If the credential has `prfSalt !== null`: send `evalByCredential[<credId>] = { first: <v2 salt> }` only.
- If `prfSalt === null` (legacy): send `eval.first = <v1 salt>` only.

**Important**: PRF rebootstrap re-wraps an existing credential's vault key against a NEW PRF output (after key rotation). The credential's `prfSalt` MUST NOT change during rebootstrap (per C1 immutability). The PRF eval uses the same salt the credential was registered with → re-wrap binds to the SAME salt → future unlocks continue to work.

### Credential test (F3 — was missed in v1 plan)

`passkey-credentials-card.tsx:handleTest` calls the post-login authenticate/options route. F3 is automatically fixed by the F1 fix.

### Passkey reauth flow

`/api/auth/passkey/reauth/options`:
- Same treatment as post-login authenticate. User is signed in; credentials list available.

### Discoverable signin (UNCHANGED)

`/api/auth/passkey/options`:
- Continues to send `prfSalt = derivePrfSalt()` (v1) only. No evalByCredential.
- v2-only credentials fail PRF unlock here. Documented behavior change in CHANGELOG (C10).

### Browser client (F4 / F5 fix)

`src/lib/auth/webauthn/webauthn-client.ts`:

```ts
export async function startPasskeyAuthentication(
  optionsJSON: Record<string, unknown>,
  prfSalt?: string, // hex — top-level eval (legacy or mixed v1 fallback)
  evalByCredential?: Record<string, string>, // credId base64url → salt hex
): Promise<PasskeyAuthenticationResult>
```

If `optionsJSON.extensions.prf` is already present (server-built — recommended), use it as-is. Otherwise (legacy callers), construct from `prfSalt` / `evalByCredential` parameters as a fallback. This dual-source design lets both server-side and client-side construction co-exist during the migration.

`startPasskeyRegistration` (unchanged signature): the v2 salt is delivered via the top-level `prfSalt` parameter (registration-time PRF eval uses a single salt for the new credential).

### Migration script (read-only diagnostic)

`scripts/migrate-prf-per-credential-salt.sh`:

```bash
#!/usr/bin/env bash
# Read-only diagnostic for A02-8 PRF per-credential salt rollout.
# Reports v1 (NULL prfSalt) vs v2 (non-NULL prfSalt) credential counts.
# Does NOT modify any data. Idempotent.
set -euo pipefail
: "${MIGRATION_DATABASE_URL:?required}"
psql "$MIGRATION_DATABASE_URL" -At <<'SQL'
SELECT
  COUNT(*) FILTER (WHERE prf_supported AND prf_salt IS NULL) AS v1_count,
  COUNT(*) FILTER (WHERE prf_supported AND prf_salt IS NOT NULL) AS v2_count,
  COUNT(*) FILTER (WHERE prf_supported) AS prf_enabled_total
FROM webauthn_credentials;
SQL
```

Test: assert (i) stdout matches expected count format, (ii) before/after DB state is byte-identical (`pg_dump | sha256sum` snapshot), (iii) script source contains no `UPDATE|INSERT|DELETE|TRUNCATE` tokens (regex grep enforced by static-check) — T8 fix.

## Contracts

### C1 — Schema additive: prfSalt nullable, immutable

- **Signature**: `prfSalt String? @map("prf_salt") @db.VarChar(64)`
- **Invariants**:
  - Nullable. NULL = legacy v1 credential; non-NULL = v2.
  - Populated only at INSERT time in the register/verify route.
  - **Never updated post-INSERT.** PRF rebootstrap re-wraps the vault key but does NOT change `prfSalt`. Enforced by: (a) no code path includes `prfSalt:` inside a `.update(...)` call (verified via grep), (b) static-check in `pre-pr.sh` (T12 fix).
- **Forbidden patterns**:
  - `pattern: "prfSalt:" within ".update(" — reason: prfSalt is immutable per credential`
- **Acceptance**: `npm run db:migrate` succeeds on a fresh DB; existing rows preserve NULL.

### C2 — derivePrfSaltV2 helper with input validation

- **Signature**: `derivePrfSaltV2(perCredentialSalt: string): string`
- **Invariants**:
  - Input: 64 lowercase hex chars; throws otherwise (explicit regex check before `Buffer.from(...,"hex")` to avoid silent truncation — F6).
  - Output: deterministic 64-char hex.
  - HKDF info: `"webauthn-prf-credential-v2"` (constant string, no interpolation).
  - Throws if `WEBAUTHN_PRF_SECRET` is unset (via `getPrfSecret()`).
- **Forbidden patterns**: none.
- **Acceptance**: unit tests assert: (i) deterministic output, (ii) different inputs → different outputs, (iii) throws on bad hex, (iv) `derivePrfSalt() !== derivePrfSaltV2(anyValidInput)` (info-string separation).

### C3 — buildPrfExtensions helper

- **Signature**: `buildPrfExtensions(credentials: Array<{ credentialId: string; prfSalt: string | null }>): { eval?: { first: string }; evalByCredential?: Record<string, { first: string }> } | null`
- **Invariants**:
  - Returns `null` if PRF is disabled (WEBAUTHN_PRF_SECRET unset).
  - Three cases:
    - All v1 → `{ eval: { first: v1 } }`
    - All v2 → `{ evalByCredential: { ... } }` (no top-level eval)
    - Mixed → both fields
  - `evalByCredential` keys are credential IDs as stored (base64url; F5 spec compliance).
- **Acceptance**: unit tests cover all three cases.

### C4 — Register options atomic challenge+salt cache

- **Signature**: `POST /api/webauthn/register/options` response unchanged at the field level; `prfSalt` value is now `derivePrfSaltV2(perCredentialSalt)`.
- **Invariants**:
  - Redis key `webauthn:challenge:register:${userId}` stores JSON `{ challenge: string, prfSalt: string | null }`. TTL unchanged (`CHALLENGE_TTL_SECONDS`).
  - `perCredentialSalt` is `randomBytes(32).toString("hex")`.
  - If `WEBAUTHN_PRF_SECRET` is unset: `prfSalt` field of the envelope is `null`, response `prfSalt: null`, `prfSupported: false`.
  - **The challenge and the per-cred salt are bound atomically**: a concurrent options request overwrites the entire envelope. The first tab's verify will (a) read the SECOND tab's challenge → WebAuthn verification fails (challenge mismatch) → no row created. The race is detectable and fails safely (S1/F7 fix).
- **Forbidden patterns**:
  - `pattern: "webauthn:pending-prf-salt:" — reason: salt is now part of the existing challenge key envelope; separate key is the broken design from plan v1`
- **Acceptance**: integration test seeds Redis with the JSON envelope; assert verify reads it correctly. Race test: simulate two options requests, verify the second's salt persists and the first's verify fails (T6 fix).

### C5 — Register verify persists prfSalt from Redis envelope

- **Signature**: route extracts `{ challenge, prfSalt: perCredentialSalt }` from the parsed envelope; persists `prfSalt` on the new credential row.
- **Invariants**:
  - Validate `perCredentialSalt` matches `PER_CRED_SALT_HEX_RE` before persisting (S4 fix — defense against tampered Redis values).
  - On any verify failure path (parse error, RLS denied, verifyRegistration throws): the `redis.getdel` already consumed the envelope (one-shot). User retries via a fresh register/options call.
  - The `redis.getdel` runs at the top of the route — before verify — so cleanup is implicit (S2 fix).
- **Forbidden patterns**:
  - `pattern: "redis.get(.webauthn:challenge:register" — reason: use getdel for one-shot consume`
- **Acceptance**: test asserts `prfSalt` persisted matches the cached value; test asserts post-verify Redis state is empty (getdel one-shot).

### C6 — buildPrfExtensions used by every PRF-options route

- **Routes**:
  - `POST /api/auth/passkey/options/email` — F8 in route.ts adds `prfSalt` to the select; calls `buildPrfExtensions(credentials)`; merges result into `options.extensions.prf`.
  - `POST /api/webauthn/authenticate/options` — F1 fix: same pattern.
  - `POST /api/webauthn/credentials/[id]/prf/options` — F2 fix: single-credential `buildPrfExtensions([{ credentialId, prfSalt }])`.
  - `POST /api/auth/passkey/reauth/options` — same pattern.
- **Invariants**:
  - Every route's Prisma query selects `prfSalt`.
  - The response `prfSalt` field (top-level) is preserved for v1 fallback only when `eval` is present in the buildPrfExtensions result.
  - When `evalByCredential` is present, the server-side options object's `extensions.prf` carries the per-credential salts.
- **Forbidden patterns**:
  - `pattern: "derivePrfSalt()" inside option-building paths for KNOWN-credential routes — reason: those routes must use buildPrfExtensions (which calls derivePrfSalt internally only for v1 fallback)`
- **Acceptance**: tests cover all-v1, all-v2, mixed for each of the four routes (T4 fix); legacy NULL-prfSalt credentials still unlock (T5 fix).

### C7 — Discoverable signin unchanged

- **Signature**: `POST /api/auth/passkey/options` continues to send `prfSalt = derivePrfSalt()` (v1).
- **Acceptance**: existing tests pass without modification.

### C8 — Browser client supports server-built extensions + client-built fallback

- **Signature**: `startPasskeyAuthentication(optionsJSON, prfSalt?, evalByCredential?)`.
- **Invariants**:
  - If `optionsJSON.extensions.prf` is present (server-built), pass through unchanged.
  - Else, if `prfSalt` or `evalByCredential` is provided, build the extensions client-side.
  - Backward-compatible: callers that don't pass the third arg get today's v1 behavior.
- **Forbidden patterns**: none.
- **Acceptance**: client unit tests cover three cases (T11 fix):
  - server-built extensions present → pass through
  - only `prfSalt` param → top-level eval only
  - only `evalByCredential` param → no top-level eval
  - both present → both forwarded

### C9 — Migration script read-only

- **Signature**: `scripts/migrate-prf-per-credential-salt.sh`.
- **Invariants**:
  - Read-only (`SELECT` only). No `UPDATE/INSERT/DELETE/TRUNCATE` tokens in source.
  - Idempotent.
  - Exit code: 0 on success; non-zero on connection error (F10 fix — wording corrected).
- **Acceptance**: integration test snapshots DB before+after script run; assert SHA-256 identical AND stdout includes the count line. Static-check: grep script source for forbidden SQL verbs (T8 fix).

### C10 — Threat-model posture + behavior change documented

- **Invariants** (S3 / S8 fixes):
  - Per-credential salt narrows the forward-secrecy window only when `WEBAUTHN_PRF_SECRET` leaks but the DB does not.
  - Salt secrecy alone does not crack a wrap — also requires the authenticator hardware OR a captured PRF output.
  - `WEBAUTHN_PRF_SECRET` rotation properties are unchanged from v1 (a rotation invalidates every v2 wrap simultaneously, same as v1).
  - Discoverable signin behavior change: v2 credentials cannot PRF-auto-unlock via discoverable signin; user falls back to passphrase. **CHANGELOG entry mandatory.**
- **Acceptance**: documentation review of CHANGELOG, plan, and review log. No code test.

### Consumer-flow walkthroughs

#### Register (new v2 credential)
1. Browser → `/api/webauthn/register/options` with userId.
2. Server: `perCredentialSalt = randomBytes(32)`. Cache `{ challenge, prfSalt: perCredentialSalt }` in Redis. Compute `prfSalt = derivePrfSaltV2(perCredentialSalt)`. Return `{ options, prfSalt, prfSupported: true }`.
3. Browser → `navigator.credentials.create({ extensions: { prf: { eval: { first: <prfSalt as Uint8Array> } } } })`. Authenticator returns PRF output. Browser wraps vault secret key with it.
4. Browser → `/api/webauthn/register/verify` with response + wrap fields.
5. Server: `getdel` returns the envelope. Parse. Verify with `challenge`. On success: validate `perCredentialSalt` matches regex, persist `webauthn_credentials` row with `prfSalt = perCredentialSalt`.

#### Email signin (mixed v1/v2)
1. Browser → `/api/auth/passkey/options/email` with email.
2. Server looks up user's credentials with `prfSalt` selected. `buildPrfExtensions` returns `{ eval: { first: v1 }, evalByCredential: { credIdV2: { first: v2 } } }`. Server merges into `options.extensions.prf` and returns.
3. Browser → `navigator.credentials.get(options)`. Authenticator picks a credential, computes PRF using the salt that applies (per-cred override if present; else fall through to eval).
4. Browser → `/api/auth/passkey/verify` with response + PRF output. Server verifies. Browser unwraps vault key.

#### Post-login PRF unlock
- Same as email signin but the route is `/api/webauthn/authenticate/options` (signed-in user, no email needed).

#### PRF rebootstrap (existing v2 credential)
1. Browser → `/api/webauthn/credentials/[id]/prf/options`.
2. Server looks up the single credential. `buildPrfExtensions([{credentialId, prfSalt}])` → `{ evalByCredential: { <credId>: { first: <v2 salt> } } }`.
3. Browser → ceremony → new wrap.
4. Server updates only the wrap fields (`prfEncryptedSecretKey/Iv/AuthTag`); `prfSalt` is unchanged (immutable per C1).

#### Discoverable signin (v1 credential)
- Server sends `{ prf: { eval: { first: v1 } } }`. Authenticator finds the v1 cred, PRF output matches the v1 wrap. Unlock works.

#### Discoverable signin (v2 credential)
- Server sends `{ prf: { eval: { first: v1 } } }`. Authenticator finds the v2 cred, PRF output is computed from the wrong salt → unwrap fails → user falls back to passphrase. **Documented behavior change.**

## Testing strategy

### Unit

- `webauthn-server.test.ts`:
  - `describe("derivePrfSaltV2")` — co-located with existing v1 block (T15). Cases: deterministic, different inputs → different outputs, throws on bad hex (`"nothex"`, `"a".repeat(63)`, `"A".repeat(64)` uppercase), throws when PRF_SECRET unset.
  - `describe("buildPrfExtensions")` — all-v1 / all-v2 / mixed / PRF disabled (null result).
- `register/options/route.test.ts`:
  - Mock surface includes `derivePrfSaltV2` typed as `Mock<typeof derivePrfSaltV2>` (T10).
  - Asserts Redis is called with `webauthn:challenge:register:${userId}` and the value is a JSON envelope with both `challenge` and `prfSalt` fields.
  - Asserts `derivePrfSaltV2` was called with EXACTLY the cached salt (RT5 fix — T7).
  - Key-routing mock for Redis: `mockRedis.set` captures the JSON to assert structure (T1 fix).
- `register/verify/route.test.ts`:
  - Mock surface includes `derivePrfSaltV2`. `mockVerifyRegistration` typed as `Mock<typeof verifyRegistration>` (C21 pattern).
  - `mockRedis.getdel` returns the JSON envelope; asserts route parses it, validates the regex, persists `prfSalt`.
  - Race test (T6): two `mockRedis.getdel` calls — first returns envelope, second returns null. Assert second verify fails with VALIDATION_ERROR.
- `passkey/options/email/route.test.ts`, `webauthn/authenticate/options/route.test.ts`, `webauthn/credentials/[id]/prf/options/route.test.ts`, `passkey/reauth/options/route.test.ts`:
  - Mock surface includes `buildPrfExtensions`. Tests cover all-v1, all-v2, mixed for each route.
  - **Legacy unlock test (T5)**: with `prfSalt = null` credential in the mock findMany result, assert `options.extensions.prf.eval` is set (v1 fallback) and `evalByCredential` is absent. CRITICAL for backward compat.
- `webauthn-client.test.ts` (browser):
  - `startPasskeyAuthentication` test cases: server-built `extensions.prf` passthrough; only `prfSalt` param; only `evalByCredential` param; both present.

### Test files updated (R19 / T3 / T14 — explicit checklist)

| Test file | Action |
|-----------|--------|
| `src/app/api/webauthn/register/options/route.test.ts` | ADD `derivePrfSaltV2` to mock surface |
| `src/app/api/webauthn/register/verify/route.test.ts` | ADD `derivePrfSaltV2` to mock surface |
| `src/app/api/auth/passkey/options/email/route.test.ts` | REPLACE `derivePrfSalt: () => "a".repeat(64)` with mocked `buildPrfExtensions` |
| `src/app/api/webauthn/authenticate/options/route.test.ts` | REPLACE `derivePrfSalt` mock with `buildPrfExtensions` mock |
| `src/app/api/webauthn/credentials/[id]/prf/options/route.test.ts` | REPLACE `derivePrfSalt` mock with `buildPrfExtensions` mock |
| `src/app/api/auth/passkey/reauth/options/route.test.ts` | REPLACE `derivePrfSalt` mock with `buildPrfExtensions` mock |
| `src/app/api/auth/passkey/options/route.test.ts` (discoverable) | **DO NOT modify** — discoverable keeps v1 |
| `src/lib/auth/webauthn/webauthn-client.test.ts` | ADD evalByCredential test cases |
| `src/lib/auth/webauthn/webauthn-server.test.ts` | ADD derivePrfSaltV2 and buildPrfExtensions describes |

### Integration (real DB)

- Seed: a v1 credential (NULL prfSalt) + a v2 credential (non-NULL prfSalt) for the same user.
- Test `/api/auth/passkey/options/email` returns mixed-mode response.
- Test `/api/webauthn/authenticate/options` for the same user returns mixed-mode response.
- Schema migration: apply `ALTER TABLE` to a snapshotted dev DB; assert no row data lost.

### Manual smoke test (T9 fix — concrete + executable)

`docs/archive/review/a02-8-prf-per-credential-salt-manual-test.md`:

```
Pre-conditions:
- npm run docker:up; npm run dev
- Dev DB has at least one existing PRF-enabled credential (`prfSupported = TRUE`, `prfSalt IS NULL`)
- Snapshot pre-state:
    docker compose exec db psql -U passwd_user -d passwd_sso -c \
      "SELECT \"credentialId\", \"prfSalt\" IS NULL AS is_v1, counter FROM webauthn_credentials;"

Step 1: Sign in via email with the existing v1 passkey
  Expected: vault auto-unlocks (PRF via v1 RP-global salt)
  Verify via DevTools: response.options.extensions.prf has eval.first only (no evalByCredential)

Step 2: Lock the vault. In-app re-unlock via passkey (post-login PRF)
  Expected: vault unlocks
  Verify: response from /api/webauthn/authenticate/options has eval.first only

Step 3: Register a NEW passkey from /settings/security
  Expected: DB row inserted with prfSalt non-NULL
  Verify: psql query shows new row has prfSalt IS NOT NULL

Step 4: Sign out, sign in via email — pick the NEW passkey
  Expected: vault auto-unlocks
  Verify: DevTools shows response.options.extensions.prf has evalByCredential (and possibly eval.first if mixed)

Step 5: Lock vault, in-app re-unlock via the NEW passkey
  Expected: vault unlocks
  Verify: response.options.extensions.prf has evalByCredential keyed by the new cred ID

Step 6: Discoverable signin with the NEW passkey
  Expected: PRF auto-unlock FAILS, user is prompted for passphrase
  Verify: response.options.extensions.prf has eval.first (v1) only; vault stays locked after credential select

Step 7: Discoverable signin with the OLD v1 passkey
  Expected: vault auto-unlocks (legacy v1 path still works)

Step 8: PRF rebootstrap (settings → security → "Test" button on the v2 credential)
  Expected: test ceremony succeeds
  Verify: response.options.extensions.prf has evalByCredential keyed by that cred

Step 9: Run the migration diagnostic script
  Expected: stdout shows v1_count / v2_count / prf_enabled_total
  Verify: DB row counts UNCHANGED before+after script

Rollback: git revert <A02-8 commit-sha> if any step fails BEFORE deploy.
```

### Pre-PR

- `bash scripts/pre-pr.sh` 20/20 PASS
- `npm run db:migrate` on dev DB confirms schema migrates without data loss
- Manual smoke test all 9 steps checked off

## Considerations & constraints

### Why v2 only for known-credential paths?

User direction (2026-05-23). The plan v1 (email-only) under-scoped because it missed three additional known-credential paths (post-login unlock / rebootstrap / test). v2 plan covers all known-credential paths; discoverable signin alone keeps v1.

### Why not automatic re-wrap of v1 credentials?

Re-wrapping requires the user's vault secret key (only in browser memory). Server cannot do it. Future enhancement: user-triggered "rotate passkey PRF binding" button. Until then, v1 credentials coexist with v2; users with mixed credentials are protected at the WEAKER of the two (v1 forward-secrecy posture).

### Race condition mitigation (S1/F7)

Plan v1 used a separate Redis key (`webauthn:pending-prf-salt:${userId}`) that could be overwritten by a concurrent request, silently bricking the first tab's credential. Plan v2 ties the salt into the existing challenge key envelope. Race outcome: the first tab's verify reads the SECOND tab's challenge, WebAuthn verification fails (challenge mismatch), no credential row is created, user retries. **No silent brick.**

### `WEBAUTHN_PRF_SECRET` rotation (S8)

v2 wraps are bound to `HKDF(secret, perCredentialSalt, info)`. A secret rotation invalidates every v2 wrap simultaneously — same as v1. Per-credential salt does NOT make rotation safer. Document explicitly so operators don't misread the forward-secrecy framing.

### Mixed-credential user posture (S6)

A user with one v1 cred + one v2 cred is protected at the WEAKER of the two. Per-cred salt benefit is realized only when the user removes the v1 cred or re-registers it. Future enhancement: UI prompt to upgrade legacy credentials. Tracked as out-of-scope follow-up.

### Migration window (S2)

A user with an in-flight register/options request started before A02-8 deploys and verifies after A02-8 lands: the old Redis value is a plain string (challenge), not JSON. `JSON.parse` throws → verify fails with VALIDATION_ERROR. User retries. Acceptable (300s TTL window during a deploy; trivially recoverable).

### Out of scope

- Automatic re-wrap of v1 credentials
- WEBAUTHN_PRF_SECRET rotation flow (a separate task)
- Passkey E2E specs (no passkey E2E exists today — separate follow-up `c21-followup-e2e`)
- UI prompt to upgrade legacy credentials to v2

## User operation scenarios

- **Brand new user**: registers passkey → v2 prfSalt persisted → all flows (email signin, post-login unlock, rebootstrap, test) use evalByCredential → PRF auto-unlock works everywhere except discoverable signin.
- **Existing user, v1 passkey only**: nothing changes. Every flow uses v1 RP-global salt. All unlocks continue to work.
- **Existing user adds a second v2 passkey**: email signin + post-login unlock return mixed-mode extensions; both creds unlock correctly. Discoverable signin with the new v2 cred → passphrase prompt.
- **User uses only discoverable signin habitually + registers a v2 cred**: vault auto-unlock no longer works for the new cred via discoverable. CHANGELOG warns the user. Recommended path: sign in via email instead.
- **Operator runs the migration diagnostic**: sees `v1_count`/`v2_count`/`prf_enabled_total`. No DB writes.

## Go/No-Go Gate

| ID  | Subject                                                       | Status |
|-----|---------------------------------------------------------------|--------|
| C1  | Schema additive: prfSalt nullable + immutable                 | locked |
| C2  | derivePrfSaltV2 helper with input validation                  | locked |
| C3  | buildPrfExtensions helper (all-v1 / all-v2 / mixed)           | locked |
| C4  | Register options atomic challenge+salt JSON envelope          | locked |
| C5  | Register verify persists prfSalt from envelope                | locked |
| C6  | Every PRF-options route uses buildPrfExtensions               | locked |
| C7  | Discoverable signin unchanged (v1)                            | locked |
| C8  | Browser client supports server-built + client-built extensions | locked |
| C9  | Migration script read-only diagnostic                         | locked |
| C10 | Threat-model posture + behavior change documented             | locked |
