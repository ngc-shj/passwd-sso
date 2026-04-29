# Plan: Verifier pepper dual-version support

Slug: `verifier-pepper-dual-version`
Branch: `feature/verifier-pepper-dual-version`
Source: PR #413 deferred item `#5b` — runbook gap closed in [pepper-rotation-runbook.md §"Known gaps in the current code"](pepper-rotation-runbook.md).

## Project context

- **Type**: web app (Next.js 16, App Router) + Postgres backing store, multi-tenant
- **Test infrastructure**: unit + integration (vitest, real Postgres via `npm run test:integration`) + E2E (Playwright) + CI/CD (`scripts/pre-pr.sh`)

This is a security-sensitive change to the server-side passphrase verifier and access-password hashing path. All findings under "automated test coverage" are in scope (Critical/Major allowed).

## Objective

Wire `version` through `hmacVerifier()` / `verifyPassphraseVerifier()` and their callers so the server can verify a stored HMAC against an older pepper version while writing new HMACs under the current pepper. This is the prerequisite for the runbook's Mode A non-disruptive rotation. **Without this change, hot pepper rotation locks out every user.**

Out of scope (separate follow-up PRs, tracked in runbook §"Open follow-ups"):
- The `scripts/rotate-verifier-pepper.sh` rotation automation
- Mode A operational dry-run on staging / production
- `VERIFIER_PEPPER_ROTATE_*` audit-action emit sites (constants are added now; emit comes with the rotation script)

## Requirements

### Functional

1. **F-Verify-Old**: A user whose `passphraseVerifierVersion = 1` MUST verify successfully against pepper version 1, even when current code-level `VERIFIER_VERSION = 2`.
2. **F-Write-Current**: Every write site (setup / unlock backfill / change-passphrase / rotate-key / recovery-key/{generate,recover}) MUST write `passphraseVerifierHmac` and `passphraseVerifierVersion` under the current pepper version.
3. **F-Recovery-Verify**: Recovery-key verify uses `recoveryVerifierHmac` — its version MUST be tracked symmetrically with `passphraseVerifierVersion` (new column `recoveryVerifierVersion`).
4. **F-Share-AccessPassword**: `PasswordShare.accessPasswordHash` (used by Send and ShareLink) MUST track its pepper version (new column `accessPasswordHashVersion`) so existing shares created under pepper N still verify after rotation to N+1.
5. **F-Opportunistic-Migrate**: On successful unlock, if the user's stored `passphraseVerifierVersion` differs from the current `VERIFIER_VERSION`, the verifier MUST be re-HMACed and persisted under the current pepper version. (Hot path; other verify flows do not migrate.)
6. **F-Remove-VersionGate**: The current `VERIFIER_VERSION_UNSUPPORTED` 409 in change-passphrase and recovery-key/generate is itself the lockout source — REMOVE it and rely on dual-version verify.
7. **F-EnvKeyProvider-Versioned**: `EnvKeyProvider.getVerifierPepper(version)` reads `VERIFIER_PEPPER_KEY_V<n>` for `n ≥ 2`, falling back to `VERIFIER_PEPPER_KEY` for `n = 1`. Cloud providers use `resolveSecretName(name, version)` (already plumbed in `BaseCloudKeyProvider`).
8. **F-Audit-Constants**: Add `VERIFIER_PEPPER_ROTATE_BEGIN`, `VERIFIER_PEPPER_ROTATE_COMPLETE`, `VERIFIER_PEPPER_ROTATE_ROLLBACK`, `VERIFIER_PEPPER_MISSING` audit actions to BOTH `prisma/schema.prisma` (`AuditAction` enum) AND `src/lib/constants/audit/audit.ts`. Register in audit-action group definitions, `AUDIT_ACTION_VALUES`, and i18n labels (R12).

### Non-functional

- **NF-Backwards-Compat**: All existing rows continue to verify (default `version = 1`). No data migration required beyond the schema-additive default columns.
- **NF-No-Plaintext-Pepper-In-Logs**: Pepper bytes never appear in logs, error messages, or audit metadata.
- **NF-Timing-Safe**: All comparisons remain `timingSafeEqual` (RS1).
- **NF-Fail-Closed-On-Missing-Version**: If `VERIFIER_PEPPER_KEY_V<n>` is missing for a stored version `n`, verify returns `false` (not 500). Audit emits the missing-version event so operators see the gap.
- **NF-No-Client-Bundle-Pollution**: `VERIFIER_VERSION` is server-only by convention + code review — moving it from `crypto-client.ts` to `verifier-version.ts` prevents accidental client import via the file-naming + top-of-file comment. Bundler-level enforcement (`server-only` package) is intentionally out of scope; see §"Server-only enforcement for verifier-version.ts" for rationale.

## Technical approach

### Existing surface (not new modules)

This PR MODIFIES the existing `src/lib/crypto/crypto-server.ts` — it does NOT create a new HMAC helper module. `hmacVerifier` and `verifyPassphraseVerifier` already exist there ([crypto-server.ts:255-291](../../../src/lib/crypto/crypto-server.ts#L255-L291)) and are the only HMAC-pepper helpers in the codebase. `VERIFIER_VERSION` is the single source of truth — currently in `crypto-client.ts:20`, this PR relocates it to a server-only module so it cannot be bundled into the browser.

Codebase grep evidence (run during plan drafting):
- `verifyPassphraseVerifier` consumers (verify side): 4 — `change-passphrase`, `recovery-key/{generate,recover}`, `travel-mode/disable` (all in `src/app/api/`)
- `verifyAccessPassword` consumers: 1 — `share-links/verify-access`
- `hmacVerifier` consumers (write side): 6 — `setup`, `unlock` (backfill), `change-passphrase`, `rotate-key`, `recovery-key/{generate,recover}`
- `hashAccessPassword` consumers (write side): 3 — `sends/route.ts`, `sends/file/route.ts`, `share-links/route.ts`

No background workers, CLI subcommands, admin APIs in the verify/write helper paths. One additional direct-column-write site exists (`src/lib/vault/vault-reset.ts:81` hardcodes `passphraseVerifierVersion: 1`; line 87 sets `recoveryVerifierHmac: null` but does NOT yet reset `recoveryVerifierVersion` because the column does not exist pre-PR) — this site does NOT call the helpers but writes the column directly when wiping a user's verifier as part of vault reset. The grep in Step 1 covers BOTH patterns (helper calls + direct column writes) to surface any new sites.

### Code-level

#### Verifier API shape

```ts
// src/lib/crypto/verifier-version.ts (NEW server-only module)
// VERIFIER_VERSION is intentionally server-only — do not add to CRYPTO_CONSTANTS or any client-imported export.
export const VERIFIER_VERSION = 1;  // moved from crypto-client.ts

// Test seam: production reads the constant; tests can override via env (NODE_ENV='test' only).
export function getCurrentVerifierVersion(): number {
  if (process.env.NODE_ENV === "test") {
    const override = process.env.INTERNAL_TEST_VERIFIER_VERSION;
    if (override) {
      const n = parseInt(override, 10);
      if (Number.isInteger(n) && n >= 1) return n;
    }
  }
  return VERIFIER_VERSION;
}

// crypto-server.ts (existing module — modify in place, NOT a new file)
export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "WRONG_PASSPHRASE" | "MISSING_PEPPER_VERSION" };

export function hmacVerifier(
  verifierHashHex: string,
  version: number = getCurrentVerifierVersion(),  // explicit, defaults to current
): string;

export function verifyPassphraseVerifier(
  clientVerifierHash: string,
  storedHmacHex: string,
  storedVersion: number,  // REQUIRED — caller must read from DB
): VerifyResult;

export function hashAccessPassword(
  password: string,
  version: number = getCurrentVerifierVersion(),
): { hash: string; version: number };

export function verifyAccessPassword(
  password: string,
  storedHash: string,
  storedVersion: number,  // REQUIRED
): VerifyResult;
```

**Why required, not optional, on verify**: every verify caller already reads the User/Share row. Making `storedVersion` required surfaces missed call sites at compile time. Optional with default would silently misverify after rotation if a caller forgets to pass it.

**Why default-on-write**: write sites always want "current". Forcing every caller to pass `VERIFIER_VERSION` is line-noise.

**Why discriminated union, not boolean**: `MISSING_PEPPER_VERSION` (operator config gap) must be distinguishable from `WRONG_PASSPHRASE` at the route boundary so the route can emit `VERIFIER_PEPPER_MISSING` audit. Both `verifyPassphraseVerifier` and `verifyAccessPassword` return the same shape so wrappers don't collapse the signal.

**Why `getCurrentVerifierVersion()` instead of constant inline**: tests need to simulate version transition without monkey-patching a `const` export. The `NODE_ENV === 'test'` gate prevents accidental production override.

#### Pepper resolution

```ts
// EnvKeyProvider — getKeySync dispatch must forward version (currently does not)
getKeySync(name: KeyName, version?: number): Buffer {
  switch (name) {
    case "share-master":     return this.getShareMasterKey(version ?? 1);
    case "verifier-pepper":  return this.getVerifierPepper(version ?? 1);  // ← forward version
    // ... other cases unchanged
  }
}

private getVerifierPepper(version: number): Buffer {
  const envName = version === 1 ? "VERIFIER_PEPPER_KEY" : `VERIFIER_PEPPER_KEY_V${version}`;
  // V1 also falls back to VERIFIER_PEPPER_KEY (matches existing behavior)
  // For version >= 2: NO dev fallback — must throw if env var unset (no silent SHARE_MASTER_KEY-derived pepper)
  // V1 dev fallback (existing behavior) is retained ONLY for version === 1
}
```

Cloud providers (`aws-sm`, `gcp-sm`, `azure-kv`) reuse the existing `resolveSecretName(name, version)` which appends `-v<n>` to secret names — no provider-specific change needed beyond passing `version` through `getKeySync`. `BaseCloudKeyProvider.getKeySync` already keys cache by `(name, version)` (see `buildCacheKey`).

**`validateKeys()` startup enforcement** (closes runbook §"Pre-rotation checklist" gap):

- `EnvKeyProvider.validateKeys()` MUST call `getVerifierPepper(VERIFIER_VERSION)` unconditionally when `NODE_ENV === 'production'` — abort startup if missing. Current code only validates when `process.env.VERIFIER_PEPPER_KEY` is set; this PR closes that gap.
- `EnvKeyProvider.validateKeys()` MUST also probe each `VERIFIER_PEPPER_KEY_V<n>` env var that IS configured (loop n=2..100; for each present env var, validate hex format). Absent V<n> env vars are NOT probed — only configured-but-invalid ones throw.
- `BaseCloudKeyProvider.validateKeys()` already probes `verifier-pepper` at startup (line 102-105). Unchanged behavior — fetch fails → startup aborts.

#### Schema additions (additive-only, R24-compliant)

```prisma
model User {
  // existing columns ...
  passphraseVerifierVersion Int @default(1) @map("passphrase_verifier_version")  // already exists
  recoveryVerifierVersion   Int @default(1) @map("recovery_verifier_version")    // NEW
}

model PasswordShare {
  // existing columns ...
  accessPasswordHashVersion Int @default(1) @map("access_password_hash_version") // NEW
}
```

Both new columns default to 1, NOT NULL. R24 split: this is purely additive (defaulted), no flip step needed.

#### Opportunistic re-HMAC

Only `unlock` route does this, in the existing backfill block:

```ts
// src/app/api/vault/unlock/route.ts (extend existing block)
if (verifierHash && (
    user.passphraseVerifierHmac === null ||
    user.passphraseVerifierVersion !== VERIFIER_VERSION
)) {
  await prisma.user.updateMany({
    where: { id: session.user.id },
    data: {
      passphraseVerifierHmac: hmacVerifier(verifierHash),  // current version
      passphraseVerifierVersion: VERIFIER_VERSION,
    },
  });
}
```

`updateMany` with id-only WHERE preserves the existing idempotency. The previous `passphraseVerifierHmac: null` check is folded into the new condition.

Other verify paths (change-passphrase, recovery-key/recover, travel-mode/disable, share-links/verify-access) do NOT re-HMAC. Rationale: they are infrequent compared to unlock; adding writes there is unnecessary and expands the audit surface.

### Migration plan

```
prisma/migrations/<timestamp>_verifier_pepper_dual_version/migration.sql
  ALTER TABLE users
    ADD COLUMN recovery_verifier_version INT NOT NULL DEFAULT 1;
  ALTER TABLE password_shares
    ADD COLUMN access_password_hash_version INT NOT NULL DEFAULT 1;
```

No data migration. `passphraseVerifierVersion` already exists on `users` with default 1.

## Implementation steps

1. **Re-grep verify/write call sites** (defensive, before code edits):

   ```bash
   # Pattern A: hmacVerifier / verifyPassphraseVerifier / verifyAccessPassword / hashAccessPassword consumers
   grep -rnE "verifyPassphraseVerifier|verifyAccessPassword|hmacVerifier|hashAccessPassword" src/ \
     | grep -v "\.test\." \
     | grep -v "src/lib/crypto/crypto-server.ts"

   # Pattern B: direct passphraseVerifierVersion / recoveryVerifierVersion / accessPasswordHashVersion writes (NOT covered by Pattern A)
   grep -rnE "passphraseVerifierVersion|recoveryVerifierVersion|accessPasswordHashVersion" src/ \
     | grep -v "\.test\."
   ```

   Expected: Pattern A returns 14 call sites (4 + 1 + 6 + 3). Pattern B includes Pattern A sites PLUS direct writes — known site is `src/lib/vault/vault-reset.ts:81` (hardcodes `passphraseVerifierVersion: 1`; null verifier means version is irrelevant until next setup, but for cleanliness change to `VERIFIER_VERSION`). **Also extend `vault-reset.ts` to reset `recoveryVerifierVersion: VERIFIER_VERSION`** alongside the existing `recoveryVerifierHmac: null` write so the column does not retain a stale value after a reset. If grep returns sites not listed here, add them to the implementation list before proceeding.

2. **Create `src/lib/crypto/verifier-version.ts`** as a NEW server-only module containing:
   - `export const VERIFIER_VERSION = 1`
   - `export function getCurrentVerifierVersion(): number` (with the `NODE_ENV === 'test'` env override seam shown in §Verifier API shape)
   - Top-of-file comment: `// VERIFIER_VERSION is intentionally server-only — do not add to CRYPTO_CONSTANTS or any client-imported export.`

   Then:
   - Remove `VERIFIER_VERSION` from `src/lib/crypto/crypto-client.ts` (line 20)
   - Add a comment at that location: `// VERIFIER_VERSION lives in @/lib/crypto/verifier-version (server-only); intentionally NOT exported from this client module.`
   - Update existing imports (5 files): `vault/setup`, `vault/unlock`, `vault/change-passphrase`, `vault/rotate-key`, `vault/recovery-key/generate` — change to `import { VERIFIER_VERSION } from "@/lib/crypto/verifier-version"`.
   - **Add NEW import** in `vault/recovery-key/recover/route.ts` — currently has no `VERIFIER_VERSION` import; Step 6 `handleReset` writes `passphraseVerifierVersion: VERIFIER_VERSION` and `recoveryVerifierVersion: VERIFIER_VERSION` so the import is required (closes round-3 F12).
   - **Add NEW import** in `src/lib/vault/vault-reset.ts` — Step 1 Pattern B note replaces hardcoded `1` with `VERIFIER_VERSION` (also writes `recoveryVerifierVersion`).
   - Run final grep to confirm zero `from "@/lib/crypto/crypto-client"` imports name `VERIFIER_VERSION`. (R10: no circular import — `crypto-client.ts` does not import from server.)
   - **Test mock declaration update**: `change-passphrase/route.test.ts:23` and `recovery-key/generate/route.test.ts:24` currently `vi.mock("@/lib/crypto/crypto-client", () => ({ VERIFIER_VERSION: 1 }))`. **DELETE** the existing `vi.mock("@/lib/crypto/crypto-client", ...)` line and **ADD** `vi.mock("@/lib/crypto/verifier-version", () => ({ VERIFIER_VERSION: 1, getCurrentVerifierVersion: () => 1 }))`. Leaving both is dead code that masks future re-introduction of `VERIFIER_VERSION` into `crypto-client` (closes round-3 T15).

3. **Extend `KeyProvider.getKeySync` plumbing** for verifier-pepper:
   - `EnvKeyProvider.getKeySync` — UPDATE the `verifier-pepper` switch arm to forward `version`: `case "verifier-pepper": return this.getVerifierPepper(version ?? 1);`
   - `EnvKeyProvider.getVerifierPepper(version: number)` — read `VERIFIER_PEPPER_KEY_V<n>` for n ≥ 2 (no dev fallback for n ≥ 2 — must throw if env var unset), fall back to `VERIFIER_PEPPER_KEY` for n = 1
   - `EnvKeyProvider.validateKeys()` — when `NODE_ENV === 'production'`, MUST call `getVerifierPepper(VERIFIER_VERSION)` unconditionally (closes the existing `if (process.env.VERIFIER_PEPPER_KEY)` permissive gate at `env-provider.ts:46`). ALSO validate configured `VERIFIER_PEPPER_KEY_V<n>` env vars (loop V2..V100; validate ONLY when present)
   - `BaseCloudKeyProvider.validateKeys()` (line 97-109) — change the `verifier-pepper` probe from version-less to versioned: replace `keysToValidate.push({ name: "verifier-pepper" })` with `keysToValidate.push({ name: "verifier-pepper", version: VERIFIER_VERSION })`.
   - **`BaseCloudKeyProvider.resolveSecretName` V1 backward-compat shim** (closes round-3 finding F10): existing cloud-provider deployments have their pepper stored as bare `verifier-pepper` secret name (no `-v1` suffix), because verifier-pepper has historically never been version-aware. Naively passing `version=1` would resolve to `verifier-pepper-v1` and lock out every cloud-deployed user. Add a special case in `resolveSecretName` ONLY for verifier-pepper:
     ```ts
     protected resolveSecretName(name: KeyName, version?: number): string {
       const envVar = this.secretNameEnvMap[name];
       const customName = process.env[envVar];
       const baseName = customName || this.defaultSecretNames[name];
       // V1 backward-compat: verifier-pepper was historically unversioned in cloud deployments.
       // share-master has always been versioned (bumped via SHARE_MASTER_KEY_CURRENT_VERSION), so it does NOT take this fallback.
       // WARNING: this shim is BY-NAME, not by a generic flag. If a new KeyName is added that
       // historically had no versioned suffix in cloud deployments, ADD ANOTHER EXCEPTION HERE.
       // Do NOT generalize into a flag without auditing every existing cloud deployment's secret naming.
       const isVerifierPepperV1 = name === "verifier-pepper" && version === 1;
       return version != null && !isVerifierPepperV1 ? `${baseName}-v${version}` : baseName;
     }
     ```
     For V2+, the suffix `-v2`, `-v3`, ... is used as expected. Operators rotating from V1 to V2 must store the V2 pepper at `{baseName}-v2` (e.g., `verifier-pepper-v2` in AWS Secrets Manager). The bare-name secret remains valid for V1.
   - Cloud providers already pass `version` through; confirm by reading `aws-sm-provider.ts` `fetchSecret` and verifying `resolveSecretName(name, version)` is called

4. **Update `crypto-server.ts`** (existing module — modify in place):
   - Export type `VerifyResult = { ok: true } | { ok: false; reason: 'WRONG_PASSPHRASE' | 'MISSING_PEPPER_VERSION' }`
   - Add `version: number = getCurrentVerifierVersion()` parameter to `hmacVerifier(hash, version)` — defaults to current
   - Change `verifyPassphraseVerifier(client, stored, storedVersion: number): VerifyResult` — `storedVersion` REQUIRED, return type changes from `boolean` to `VerifyResult`. On caught `Error` from `getVerifierPepper(storedVersion)` → return `{ ok: false, reason: 'MISSING_PEPPER_VERSION' }`. On HMAC mismatch → `{ ok: false, reason: 'WRONG_PASSPHRASE' }`. On match → `{ ok: true }`.
   - Change `hashAccessPassword(password, version: number = getCurrentVerifierVersion()): { hash: string; version: number }` — return shape changes from `string` to object with version
   - Change `verifyAccessPassword(password, storedHash, storedVersion: number): VerifyResult` — `storedVersion` REQUIRED, return type changes (parallel to `verifyPassphraseVerifier`)

5. **Schema migration**:
   - Add `recoveryVerifierVersion Int @default(1)` to User
   - Add `accessPasswordHashVersion Int @default(1)` to PasswordShare
   - Generate Prisma migration; run `npm run db:migrate` against dev DB to verify

6. **Update each route consumer**. At every verify call site, change from boolean-pattern `if (!verifyPassphraseVerifier(...))` to discriminated-union pattern:

   ```ts
   const r = verifyPassphraseVerifier(client, stored, storedVersion);
   if (!r.ok) {
     if (r.reason === "MISSING_PEPPER_VERSION") {
       // ALWAYS use tenantAuditBase for VERIFIER_PEPPER_MISSING (TENANT scope)
       // — this is an operator-visibility signal, not user-personal. See §"Audit scope".
       await logAuditAsync({
         ...tenantAuditBase(request, session.user.id, user.tenantId),
         action: AUDIT_ACTION.VERIFIER_PEPPER_MISSING,
         metadata: { storedVersion },
       });
     }
     return errorResponse(API_ERROR.INVALID_PASSPHRASE, 401);
   }
   ```

   Routes must add `tenantId: true` to their User SELECT to enable this `tenantAuditBase` call. This is in addition to the per-route SELECT extensions for the version columns.

   Per-route changes (9 routes — note recovery/recover has TWO call sites):

   - **`vault/setup`** — write `passphraseVerifierVersion: VERIFIER_VERSION` (no `hmacVerifier` call change — defaults to current). No verify call.
   - **`vault/unlock`** — Add `passphraseVerifierVersion: true` to existing SELECT (line 65-74). Then extend backfill `updateMany` block:
     ```ts
     if (verifierHash && (
         user.passphraseVerifierHmac === null ||
         user.passphraseVerifierVersion !== VERIFIER_VERSION
     )) {
       await prisma.user.updateMany({
         where: { id: session.user.id },
         data: {
           passphraseVerifierHmac: hmacVerifier(verifierHash),  // current pepper
           passphraseVerifierVersion: VERIFIER_VERSION,
         },
       });
     }
     ```
     `updateMany` with id-only WHERE preserves idempotency; the JS-level check is fine because re-HMAC under the same pepper produces the same value (so concurrent double-write is harmless).
   - **`vault/change-passphrase`** — Add `passphraseVerifierVersion: true` to existing SELECT. REMOVE the `VERIFIER_VERSION_UNSUPPORTED` 409 gate at line 79-81. Pass `user.passphraseVerifierVersion` to `verifyPassphraseVerifier`. On reset write `passphraseVerifierVersion: VERIFIER_VERSION`.
   - **`vault/rotate-key`** — Already passes `passphraseVerifierVersion: VERIFIER_VERSION` at line 256 inside the conditional spread — preserve. No verify call (rotate-key is session-auth only). No SELECT changes required.
   - **`vault/recovery-key/generate`** — Add `passphraseVerifierVersion: true` to existing SELECT. REMOVE the `VERIFIER_VERSION_UNSUPPORTED` 409 gate at line 86-91. Pass stored version to `verifyPassphraseVerifier`. On write add `recoveryVerifierVersion: VERIFIER_VERSION`.
   - **`vault/recovery-key/recover`** — TWO call sites in this route:
     - `handleVerify`: add `recoveryVerifierVersion: true` to SELECT (line 90-101). Pass to `verifyHmac`. **Update signature** from `handleVerify(data, userId)` to `handleVerify(data, userId, request: NextRequest)` so the audit-emit path (on `MISSING_PEPPER_VERSION`) has access to `request` for `personalAuditBase(request, userId)`. Update the call site at the dispatcher (line 75) accordingly. (closes round-3 F13)
     - `handleReset`: add `recoveryVerifierVersion: true` to SELECT (line 133-141). Pass to `verifyHmac`. Add `passphraseVerifierVersion: VERIFIER_VERSION` AND `recoveryVerifierVersion: VERIFIER_VERSION` to the update payload.
   - **`travel-mode/disable`** — Add `passphraseVerifierVersion: true` to existing SELECT (line 47-50). Pass to `verifyPassphraseVerifier`.
   - **`share-links/verify-access`** — Add `accessPasswordHashVersion: true` to the share row SELECT. Pass to `verifyAccessPassword`. On `MISSING_PEPPER_VERSION` emit `VERIFIER_PEPPER_MISSING` audit using `tenantAuditBase(req, ANONYMOUS_ACTOR_ID, share.tenantId)` with `actorType: ACTOR_TYPE.ANONYMOUS` (consistent with existing audit calls at lines 73-80 of this route — this is an unauthenticated route, NOT `personalAuditBase`).

7. **Update the 3 share-creation routes** to write `accessPasswordHashVersion`. At each site, replace:

   ```ts
   let accessPasswordHash: string | null = null;
   if (requirePassword) accessPasswordHash = hashAccessPassword(p);
   await prisma.passwordShare.create({ data: { accessPasswordHash, /* ... */ } });
   ```

   with:

   ```ts
   let accessPasswordHash: string | null = null;
   let accessPasswordHashVersion: number = VERIFIER_VERSION;
   if (requirePassword) {
     const r = hashAccessPassword(p);
     accessPasswordHash = r.hash;
     accessPasswordHashVersion = r.version;
   }
   await prisma.passwordShare.create({ data: { accessPasswordHash, accessPasswordHashVersion, /* ... */ } });
   ```

   Sites:
   - `src/app/api/sends/route.ts` (line 50-54 + create)
   - `src/app/api/sends/file/route.ts` (line 134-137 + create)
   - `src/app/api/share-links/route.ts` (line 151-154 + create)

8. **Audit action constants** (R12):
   - **Prisma schema enum**: Add `VERIFIER_PEPPER_ROTATE_BEGIN`, `VERIFIER_PEPPER_ROTATE_COMPLETE`, `VERIFIER_PEPPER_ROTATE_ROLLBACK`, `VERIFIER_PEPPER_MISSING` to `prisma/schema.prisma` `AuditAction` enum (around line 800-942). The TS `AUDIT_ACTION` constant uses `as const satisfies Record<AuditAction, AuditAction>` — adding to TS without the schema produces a compile error.
   - **Generate Prisma migration** for the enum (`npx prisma migrate dev --create-only` and review).
   - **TS constant**: Add the 4 actions to `src/lib/constants/audit/audit.ts`.
   - **`AUDIT_ACTION_VALUES` array**: Add the 4 actions (the existing `audit.test.ts` test "every action belongs to at least one scope group" enforces this).
   - **Group placement**:
     - `VERIFIER_PEPPER_MISSING` → `AUDIT_ACTION_GROUPS_TENANT[ADMIN]` ONLY (operator config-gap signal; not a user-relevant event — see §"Audit scope for VERIFIER_PEPPER_MISSING" for rationale)
     - `VERIFIER_PEPPER_ROTATE_BEGIN` / `_COMPLETE` / `_ROLLBACK` → `AUDIT_ACTION_GROUPS_TENANT[ADMIN]` only (operator-level rotation events; not personal-scope)
   - **i18n labels** in `messages/en/AuditLog.json` AND `messages/ja/AuditLog.json` for all 4 actions (the `audit-i18n-coverage.test.ts` enforces this).
   - **UI label maps**: search for tenant audit-log filter category UI components; add only if the category set explicitly enumerates per-action labels.
   - **`METADATA_BLOCKLIST` update** in `src/lib/audit/audit-logger.ts` (line 22-41): add `"storedVersion"` so it's stripped at write time from `audit_outbox.payload` (and consequently never reaches `audit_logs.metadata`). Per closed F11/S15, this strips from BOTH personal AND tenant log paths — operators see the action name `VERIFIER_PEPPER_MISSING` but not the specific stored version. Operators can query the affected user's `passphraseVerifierVersion` column directly in DB for specific diagnosis.

9. **Remove obsolete UI dialog branch**:
   - `src/components/vault/change-passphrase-dialog.tsx:80` — the `VERIFIER_VERSION_UNSUPPORTED` branch is now dead code (server no longer returns this error). Delete the branch and the corresponding i18n key from messages files.
   - Sweep `src/lib/http/api-error-codes.ts:34,216` for the now-unused enum entry; remove it.

10. **Update tests** — concrete per-file changes:

    **a. Unit: `src/lib/crypto/crypto-server.test.ts`** — first UPDATE existing tests (closes round-3 T17), then ADD new ones.
    - **UPDATE existing `verifyPassphraseVerifier` tests** (lines 457-504): change all 2-arg calls to 3-arg with `storedVersion: 1`. Convert assertions per their semantic intent (closes round-4 T21):
      - `toBe(true)` → `toEqual({ ok: true })`
      - `toBe(false)` for verifier-hash mismatch → `toEqual({ ok: false, reason: 'WRONG_PASSPHRASE' })`
      - `toBe(false)` for invalid hex / corrupted stored / pepper-fetch-failure (line 490-504 test "returns false on pepper failure") → `toEqual({ ok: false, reason: 'MISSING_PEPPER_VERSION' })` — NOT `WRONG_PASSPHRASE`. The discriminated union exists precisely to distinguish these two cases; the test must enforce the distinction.
    - **UPDATE existing `hashAccessPassword` / `verifyAccessPassword` tests** (lines 522-553): destructure `const { hash } = hashAccessPassword(pw)` instead of `const hash = hashAccessPassword(pw)`; pass `hash` (not the object) to `verifyAccessPassword(pw, hash, 1)`. Update return-shape assertions from boolean to `VerifyResult`.
    - ADD: `hmacVerifier(hash, version=2)` round-trip with stub `VERIFIER_PEPPER_KEY_V2`
    - ADD: `verifyPassphraseVerifier(client, stored, storedVersion=1)` returns `{ ok: true }` for matching V1 stored
    - ADD: `verifyPassphraseVerifier(...)` returns `{ ok: false, reason: 'WRONG_PASSPHRASE' }` for mismatch
    - ADD: `verifyPassphraseVerifier(...)` returns `{ ok: false, reason: 'MISSING_PEPPER_VERSION' }` when stored version's pepper not configured
    - ADD: same matrix for `verifyAccessPassword`

    **a2. Unit: NEW `src/lib/crypto/verifier-version.test.ts`** (covers the new module independently):
    - `getCurrentVerifierVersion()` returns `VERIFIER_VERSION` when no env override set
    - `getCurrentVerifierVersion()` honors `INTERNAL_TEST_VERIFIER_VERSION=2` when `NODE_ENV === 'test'` (return 2)
    - `getCurrentVerifierVersion()` IGNORES `INTERNAL_TEST_VERIFIER_VERSION` when `NODE_ENV === 'production'` (negative test — proves the seam is gated, not a production backdoor)
    - `getCurrentVerifierVersion()` IGNORES non-integer / non-positive override values (e.g. "abc", "0", "-1")

    **b. Unit: `src/lib/key-provider/env-provider.test.ts`** — first AUDIT then ADD.
    - **AUDIT existing `validateKeys` tests** (lines 212-239) for regression risk (closes round-3 T18): after Step 3 changes `validateKeys()` to unconditionally call `getVerifierPepper(VERIFIER_VERSION)` in production, existing tests that don't stub a valid `VERIFIER_PEPPER_KEY` may unexpectedly fall back to derivation from `SHARE_MASTER_KEY_V1`. Add `vi.stubEnv("VERIFIER_PEPPER_KEY", VALID_HEX_C)` (or whichever sentinel is convention in the file) to each existing test's setup so they remain deterministic. Alternatively, stub `NODE_ENV='test'` if not already (the production-mode unconditional path is gated by `NODE_ENV === 'production'`).
    - ADD to the describe block:
      - "does NOT throw when only `VERIFIER_PEPPER_KEY` is set (V1 only — no V2 configured)"
      - "throws when `VERIFIER_PEPPER_KEY_V2` is configured but invalid (non-hex)"
      - "resolves when `VERIFIER_PEPPER_KEY_V2` is configured and valid"
      - "throws in production when `VERIFIER_PEPPER_KEY` is unset (closes permissive gate)"

    **c. Integration: NEW file `src/__tests__/db-integration/pepper-dual-version.integration.test.ts`**:
    - Stub `VERIFIER_PEPPER_KEY` (the V1 env var — note: NOT `VERIFIER_PEPPER_KEY_V1` — `EnvKeyProvider.getVerifierPepper(version=1)` falls back to bare `VERIFIER_PEPPER_KEY`) AND `VERIFIER_PEPPER_KEY_V2`
    - Use `_resetKeyProvider()` between phases (already exported at `src/lib/key-provider/index.ts:72`)
    - Use `INTERNAL_TEST_VERIFIER_VERSION` env override (the test seam) to flip current version
    - Test "user with passphraseVerifierVersion=1 unlocks under V2 → opportunistic re-HMAC migrates to V2"
    - Test "share with accessPasswordHashVersion=1 verifies after VERIFIER_VERSION bump"
    - Test "missing V2 pepper for V2-stored user returns 401 + emits VERIFIER_PEPPER_MISSING audit"
    - Cleanup: capture env state at top using `vi.stubEnv()` (auto-restores after the test), OR explicitly:
      ```ts
      const originalV1 = process.env.VERIFIER_PEPPER_KEY;
      const originalV2 = process.env.VERIFIER_PEPPER_KEY_V2;
      const originalVer = process.env.INTERNAL_TEST_VERIFIER_VERSION;
      try { /* ... */ } finally {
        if (originalV1 === undefined) delete process.env.VERIFIER_PEPPER_KEY;
        else process.env.VERIFIER_PEPPER_KEY = originalV1;
        // same for V2 and VER
        _resetKeyProvider();
      }
      ```

    **d. Existing route test updates**:
    - `change-passphrase/route.test.ts`:
      - Update `verifyPassphraseVerifier` mock signature to 3-arg: `vi.fn((client, stored, storedVersion: number) => ({ ok: client === stored }))`. Add explicit `expect(mock).toHaveBeenCalledWith(verifier, stored, 1)`.
      - Update `vi.mock("@/lib/crypto/crypto-client")` declaration → mock `@/lib/crypto/verifier-version` instead.
      - DELETE the test `"returns 409 when verifier version does not match"` (lines 119-128). Replace with positive test `"forwards user.passphraseVerifierVersion (read from DB) to verifyPassphraseVerifier"` — mock returns `passphraseVerifierVersion: 999` (a sentinel value distinct from `VERIFIER_VERSION = 1`), assert `expect(mockVerifyPassphraseVerifier).toHaveBeenCalledWith(verifier, stored, 999)`. This proves the route reads the column from DB; an implementer who hardcodes `1` fails this test.
      - Update mock returns to include `passphraseVerifierVersion: 1`.
    - `recovery-key/generate/route.test.ts`:
      - Same 3-arg mock update + assertion (sentinel-value pattern: mock returns `passphraseVerifierVersion: 999`, assert call args include `999`)
      - DELETE `"returns 409 when verifier version does not match"` (lines 108-117); replace with the sentinel-value forwarding test
      - Add `recoveryVerifierVersion: 1` to `userWithVault` mock; add `recoveryVerifierVersion: VERIFIER_VERSION` to `objectContaining` assertion in success test
    - `recovery-key/recover/route.test.ts`:
      - **UPDATE the `vi.mock("@/lib/crypto/crypto-server")` factory at line 25** (closes round-4 T19) — single module-level mock serves both `handleVerify` and `handleReset`. Change `vi.fn((client, stored) => client === stored)` to `vi.fn((client, stored, storedVersion: number) => ({ ok: client === stored }))`.
      - Add `recoveryVerifierVersion: 1` to `userWithRecovery` mock; add `tenantId: <test-tenant-uuid>` (needed for `tenantAuditBase` in MISSING_PEPPER_VERSION path)
      - **NEW test for `handleVerify` MISSING_PEPPER_VERSION audit emit** (closes round-4 T20): mock `verifyPassphraseVerifier` to return `{ ok: false, reason: 'MISSING_PEPPER_VERSION' }`; assert `logAuditAsync` called with `tenantAuditBase(...)` and `action: AUDIT_ACTION.VERIFIER_PEPPER_MISSING`.
      - Update "updates passphrase and recovery data" assertion to include `passphraseVerifierVersion: VERIFIER_VERSION` AND `recoveryVerifierVersion: VERIFIER_VERSION` in `objectContaining`
    - `travel-mode/travel-mode.test.ts`:
      - **UPDATE the `vi.fn` declaration at line 18 AND the `mockImplementation` at lines 187-189** (closes round-4 T22): both must be updated to 3-arg signature returning `{ ok: client === stored }`. Also: the `mockReturnValue(false)` calls at lines 245 and 293 must be updated to `mockReturnValue({ ok: false, reason: 'WRONG_PASSPHRASE' })`.
      - Add `passphraseVerifierVersion: 1` and `tenantId: <test-tenant>` to mock User returns; assert sentinel-value forwarding (mock `passphraseVerifierVersion: 999`, assert `verifyPassphraseVerifier` called with `999`)
    - `unlock/route.test.ts`:
      - Add `passphraseVerifierVersion: 1` to every `mockPrismaUser.findUnique` mock return (16 existing tests — sweep all of them)
      - Add new test: `"does NOT call updateMany when passphraseVerifierVersion already equals VERIFIER_VERSION"` — assert `mockPrismaUser.updateMany` not called
      - Add new test: `"calls updateMany with passphraseVerifierVersion=VERIFIER_VERSION when stored version differs"` — mock returns `passphraseVerifierVersion: 0`, assert `updateMany` called with `data.passphraseVerifierVersion === VERIFIER_VERSION`
    - `share-links/verify-access/route.test.ts`:
      - Type the `mockVerifyAccessPassword` 3-arg signature
      - **Update mock return values** (closes round-3 T16): `mockVerifyAccessPassword.mockReturnValue(true)` → `mockReturnValue({ ok: true })`; `mockReturnValue(false)` → `mockReturnValue({ ok: false, reason: 'WRONG_PASSPHRASE' })`. Without this update, every test currently asserting wrong-password behavior breaks (boolean `true` no longer satisfies `r.ok` discriminated check).
      - Add `accessPasswordHashVersion: 1` to `makeShare()` helper
      - Add explicit `expect(mockVerifyAccessPassword).toHaveBeenCalledWith(password, hash, 1)`

    **e. UPDATE existing route test files** (the test files actually live under `src/__tests__/api/`, NOT next to the route):
    - UPDATE `src/__tests__/api/sends/route.test.ts` (existing 323-line file):
      - Mock shape change: replace `hashAccessPassword: () => "hashed-access-password"` with `hashAccessPassword: () => ({ hash: "hashed-access-password", version: 1 })` (the function's return type changes from string to object per Step 4)
      - Existing `objectContaining({ accessPasswordHash: "hashed-access-password" })` assertions stay valid; ADD `accessPasswordHashVersion: 1` to the same `objectContaining` for the `requirePassword: true` success test
    - UPDATE `src/__tests__/api/share-links/route.test.ts` (existing 480+-line file): same two updates
    - UPDATE `src/__tests__/api/sends/file.test.ts` (note filename `file.test.ts`, not `file/route.test.ts`):
      - **ADD `hashAccessPassword` to the existing `vi.mock("@/lib/crypto/crypto-server", ...)` factory** (closes round-4 T23: the property is currently absent because the existing tests don't exercise the password-protected path) — `hashAccessPassword: () => ({ hash: "hashed-pw", version: 1 })`
      - ADD a new test exercising `requirePassword: true` and assert `accessPasswordHashVersion: 1` is written to `mockCreate`

    **f. R19 exact-shape sweep**: grep `toEqual\|toStrictEqual\|deepEqual` in test files that mock User or PasswordShare rows; update any exact-shape assertions to include the new version columns.

11. **Pre-PR env config**:
    - `src/lib/env-schema.ts` — add `VERIFIER_PEPPER_KEY_V2` through `V10` as `hex64.optional()` entries, parallel to the `SHARE_MASTER_KEY_V1..V10` pattern at line 123-132
    - `scripts/env-allowlist.ts` — add ONE regex entry covering V11..V100, matching the existing `SHARE_MASTER_KEY_V(1[1-9]|[2-9]\d|100)$` precedent:
      - `^VERIFIER_PEPPER_KEY_V(1[1-9]|[2-9]\d|100)$`
      - V2..V10 are NOT in the allowlist regex because they will already be declared in the Zod schema (env-schema.ts above) — adding them to the allowlist would duplicate (per closed F14: the allowlist is reserved for env vars NOT in Zod)
    - `.env.example` — add `VERIFIER_PEPPER_KEY_V2=` (commented placeholder explaining "set when rotating to version 2")
    - Run `npm run check:env-docs` to verify drift check passes

12. **Pre-PR sweep**:
    - `bash scripts/pre-pr.sh` — full pre-PR check (includes lint, typecheck, tests, env-docs drift)
    - `npx vitest run` + `npx next build` — mandatory per CLAUDE.md
    - `npm run db:migrate` against dev DB to verify the migration applies cleanly

### Test seam design

The integration test exercises a pepper-version transition without process restart. Brittleness mitigation:

- **File location**: `src/__tests__/db-integration/pepper-dual-version.integration.test.ts` (under existing `db-integration/` dir picked up by `npm run test:integration`)
- **`getCurrentVerifierVersion()` location**: `src/lib/crypto/verifier-version.ts` — server-only module; production code paths that previously read the `VERIFIER_VERSION` constant directly are NOT all converted (a partial conversion would be confusing). Only `crypto-server.ts`'s `hmacVerifier()` and `hashAccessPassword()` default values use `getCurrentVerifierVersion()`. All other reads (route handlers passing `VERIFIER_VERSION` to update payloads) continue to use the constant — they're already at the place that wants "current". The env-override only affects newly-computed HMACs/access-hashes during tests.
- Use the existing `_resetKeyProvider()` export (already in [key-provider/index.ts:72](../../../src/lib/key-provider/index.ts#L72)) to reinitialize between phases.
- Mutate `process.env.VERIFIER_PEPPER_KEY_V2` and `process.env.INTERNAL_TEST_VERIFIER_VERSION` via a **single dedicated test seam** — do NOT spread env mutations across multiple test bodies. Centralize in a `withPepperVersion(version, fn)` test helper.
- Cleanup: `try/finally` inside the helper guarantees cleanup even on assertion failure. `afterEach` belt-and-suspenders restoration.
- **Production safety**: `getCurrentVerifierVersion()` reads the env var ONLY when `NODE_ENV === 'test'`. The negative test (production NODE_ENV ignores override) lives in the NEW file `src/lib/crypto/verifier-version.test.ts` (created in Step 10a2 — co-located with the module being tested), NOT in `crypto-server.test.ts`.

This design keeps the test boundary explicit and survives parallel test runs (each test reads its own env at call time, not at module load).

### Audit emission for missing pepper version

When `verifyPassphraseVerifier` returns false because of a missing `VERIFIER_PEPPER_KEY_V<n>` for stored version `n` (distinct from "wrong passphrase"), emit an audit at the routes that call verify, NOT inside the crypto helper:

- Distinction: `verifyPassphraseVerifier` returns `{ ok: false, reason: 'WRONG_PASSPHRASE' | 'MISSING_PEPPER_VERSION' }` — currently it returns just `boolean`. Change return type accordingly.
- Routes branch: on `MISSING_PEPPER_VERSION`, emit `AUDIT_ACTION.VERIFIER_PEPPER_MISSING` (new constant) and return the user-facing `INVALID_PASSPHRASE` 401 (do not leak operator-side gap to user).
- This keeps crypto-layer free of audit dependency (R10 cycle prevention) and surfaces the operator-visible signal at the route boundary.

**Metadata privacy** (closes round-2 finding S12; corrected for round-3 finding F11/S15): the emit `metadata: { storedVersion }` MUST NOT be exposed to the personal audit-log API. `METADATA_BLOCKLIST` operates at WRITE time (called by `sanitizeMetadata` in `buildOutboxPayload` BEFORE `audit_outbox` insert) — adding a field strips it from BOTH personal and tenant logs because both endpoints read `metadata` directly from `audit_logs.metadata` with no scope-specific filter. Three options:

- (a) Add `"storedVersion"` to `METADATA_BLOCKLIST` in `src/lib/audit/audit-logger.ts`. Simple, but strips from tenant log too — operator sees only the action name `VERIFIER_PEPPER_MISSING` without the version. Operator can still cross-reference the affected user's `passphraseVerifierVersion` column in DB if a specific version diagnosis is needed.
- (b) Place `VERIFIER_PEPPER_MISSING` ONLY in `AUDIT_ACTION_GROUPS_TENANT[ADMIN]` — operator-only signal. Loses user-side diagnostic.
- (c) Read-time filter in personal audit-log serialization: pass `metadata` through `sanitizeMetadata` again at `src/app/api/audit-logs/route.ts` GET. Tenant route is unfiltered. Achieves differential visibility but adds code in two places.

**Plan picks (a)**: simplest, strictly more secure, action-name signal is sufficient for both user-side troubleshooting and operator-side detection. The plan does NOT claim differential visibility — both scopes see the action without `storedVersion`. Operators query DB directly for the specific affected user's stored version when needed.

**Audit scope for `VERIFIER_PEPPER_MISSING`** (closes round-4 F15/S18): all emit sites use `tenantAuditBase` (TENANT scope), NOT `personalAuditBase`. Rationale: this is an operator config-gap signal, not a user-relevant security event. Personal scope emits would put the action only in the affected user's personal audit log (not visible to operators in `/api/tenant/audit-logs` which filters `scope IN [TENANT, TEAM]`), making the `AUDIT_ACTION_GROUPS_TENANT[ADMIN]` group placement a dead filter. By using TENANT scope for all 6 emit sites:
- Operator sees every `VERIFIER_PEPPER_MISSING` event in the tenant audit dashboard
- User sees a generic `INVALID_PASSPHRASE` 401 — the operator gap is intentionally NOT exposed to the user

For authenticated routes, this requires the route to read `user.tenantId` (or use `session.user.tenantId` if available). For `recovery-key/recover` `handleVerify`, this means adding `tenantId: true` to the SELECT (also covered in §Step 6). For unauthenticated `share-links/verify-access`, `share.tenantId` is already in scope.

**Group placement updated** (closes round-4 F15): `VERIFIER_PEPPER_MISSING` → `AUDIT_ACTION_GROUPS_TENANT[ADMIN]` ONLY (REMOVE from `AUDIT_ACTION_GROUPS_PERSONAL[AUTH]`). Personal users do not need to see operator config-gap events; they see the resulting 401. Operators see the action via tenant audit dashboard.

Add `VERIFIER_PEPPER_MISSING` to step 8's audit constants list. Add the `METADATA_BLOCKLIST` update to step 8.

### Server-only enforcement for `verifier-version.ts`

The new module is plain TS without `node:crypto` imports. Bundler-level "server-only" guarantee requires either:
- (a) installing the `server-only` npm package (one new dependency) and adding `import "server-only";` at the top of `verifier-version.ts` — this fails Next.js compile if the module is imported from a client component
- (b) relying on convention + code review

This plan picks **(b)** — explicit comment + the fact that no client component currently imports `VERIFIER_VERSION`. The plan does NOT claim the module "cannot be bundled" (the original wording overstated the guarantee); the §NF-No-Client-Bundle-Pollution requirement is now restated as "preventing accidental client import via convention + code review, NOT via bundler enforcement". If a future PR introduces a client-side need for any version-related read, that PR may install `server-only` as a hardening follow-up.

## Testing strategy

| Layer | Coverage |
|---|---|
| Unit (`crypto-server.test.ts`) | Round-trip with explicit version, mismatched version → false, missing pepper for stored version → fail-closed (no throw) |
| Unit (`env-provider.test.ts`) | `VERIFIER_PEPPER_KEY_V2` resolves; missing `VERIFIER_PEPPER_KEY_V<n>` throws on `validateKeys()` only when configured-but-invalid; absent-and-not-configured does NOT throw at startup |
| Integration (new) | Two pepper versions side-by-side; pre-rotation user verifies under V1; opportunistic re-HMAC migrates user to V2 on unlock; legacy share with `accessPasswordHashVersion = 1` continues to verify after VERIFIER_VERSION bump |
| Integration (regression) | All 7 existing verify routes pass after schema column add |
| Route tests | Each of the 8 routes — mock returns must include the new version column and the call signature must include `storedVersion`. R19 exact-shape obligation: grep `toEqual` / `toStrictEqual` over the user-row mocks |
| E2E | No new E2E — existing vault unlock / share access tests cover the happy path |

The integration test must use a TRUE process boundary (call `_resetKeyProvider()` between phases) — not just var reassignment in the same closure (R25 angle: pepper resolution is a per-process cache, must verify cache invalidation if the test changes env between phases).

## Considerations & constraints

### Risks

- **Risk-1 (Critical)**: missed verify call site silently misverifies after rotation. **Mitigation**: making `storedVersion` REQUIRED on `verifyPassphraseVerifier` produces a TypeScript error at every call site that does not pass it. R3 propagation: enumerate all `verifyPassphraseVerifier` and `verifyAccessPassword` call sites — current count is 4 + 1 = 5 (change-passphrase, recovery-key/{generate,recover}, travel-mode/disable, share-links/verify-access).

- **Risk-2 (Major)**: opportunistic re-HMAC under the wrong pepper version (e.g., race between rotation flag and re-HMAC). **Mitigation**: the re-HMAC reads `VERIFIER_VERSION` (compile-time constant) at call time. The constant is bumped synchronously with deploy. Race window is "code that just deployed under V=2 sees a user still on V=1" — re-HMAC writes V=2, which is correct. Inverted race (V=1 code sees user on V=2) cannot happen as long as Mode A is followed (deploy code that READS both versions BEFORE bumping `VERIFIER_VERSION`).

- **Risk-3 (Major)**: missing `VERIFIER_PEPPER_KEY_V<n>` in production after rotation but before deploy. **Mitigation**: `validateKeys()` at startup probes V1..VN per-provider; absence of the current `VERIFIER_VERSION`'s pepper aborts startup. Boot-test (R32) requirement applies.

- **Risk-4 (Major)**: PasswordShare access passwords created with the OLD `hashAccessPassword(password)` API (no version stored) coexist with new ones. **Mitigation**: schema default `accessPasswordHashVersion = 1` covers all existing rows since current code uses pepper V1.

- **Risk-5 (Minor)**: removing `VERIFIER_VERSION_UNSUPPORTED` from the API contract is a breaking change for any external client that handled that 409. **Mitigation**: only the in-app UI dialog branches on this code; remove the dead branch in the same PR. Document in CHANGELOG.

- **Risk-6 (Design note — pre-existing)**: The HMAC computation has no version-binding (AAD). The MAC input is `pepper || verifierHash` only — version is stored in a separate column and consulted at verify time. **Implication**: an attacker with arbitrary DB write access can copy victim's `(passphraseVerifierHmac, passphraseVerifierVersion)` tuple to attacker's row and authenticate as victim. The `storedVersion` is DB-controlled and not attested in the HMAC bytes themselves. **Why acceptable**: DB-write-level compromise is already a full takeover (the attacker can also flip session tables, password hashes, etc.); pepper-secrecy (not HMAC structure) is the protection against version-downgrade for the threat model this PR addresses (cold DB leak). **Future hardening (out of scope)**: include `version_bytes || verifierHash` in MAC input — but this is a one-way migration: every existing HMAC must be recomputed before flip, equivalent to a full re-verify-on-unlock cycle. Documented here to anchor the design assumption for future reviewers.

### Out of scope (cite tracking)

- **OOS-1**: `scripts/rotate-verifier-pepper.sh` automation — runbook §"Open follow-ups" already tracks it. Implementing the script requires this PR's dual-version code; sequencing is rotation-script next.
- **OOS-2**: Mode A staging dry-run — requires a staging environment with KMS configured; operational, not code.
- **OOS-3**: `VERIFIER_PEPPER_ROTATE_*` audit emit sites — the constants are added now; emit sites belong to the rotation script PR.

## User operation scenarios

These exercise the boundaries that automated tests cannot cover.

### Scenario A: Pre-rotation deploy (this PR alone)

Setup: production has `VERIFIER_PEPPER_KEY` set, `VERIFIER_VERSION = 1`. Deploy this PR.

Expected:
- All existing users continue to unlock, change passphrase, generate recovery key, use recovery key, disable travel mode, access shares — no behavior change.
- New `passphraseVerifierVersion = 1` and `accessPasswordHashVersion = 1` columns are populated by default on all existing rows.
- `VERIFIER_VERSION_UNSUPPORTED` is no longer returned anywhere.

### Scenario B: Mode A rotation Day 1 (read both, write old)

Setup: Day 0 produced `VERIFIER_PEPPER_KEY_V2`. Day 1 deploys code that READS V1 and V2, but `VERIFIER_VERSION` constant remains 1 (so writes still under V1).

Expected:
- All users (all on V=1) continue to verify. No re-HMAC happens (versions match).
- `validateKeys()` at startup confirms both V1 and V2 are present.

### Scenario C: Mode A rotation Day 2+ (flip current version)

Setup: Day 2 deploys code with `VERIFIER_VERSION = 2`.

Expected:
- New user setups, change-passphrase, rotate-key, recovery-key/{generate,recover} writes go under V=2.
- Existing users on V=1 continue to verify against V=1 pepper.
- On unlock, V=1 users are opportunistically migrated to V=2.
- Existing pre-rotation shares (V=1) continue to verify; new shares write under V=2.

### Scenario D: Post-rotation verify lifecycle

Setup: 30 days after Day 2.

Expected:
- Most active users have migrated via opportunistic re-HMAC during unlock.
- Inactive users still on V=1 continue to verify.
- A `SELECT passphrase_verifier_version, COUNT(*)` shows the migration distribution.

### Scenario E: Emergency rollback (compromised V=2 case)

Setup: Day 2+ deploy is rolled back to `VERIFIER_VERSION = 1`. Code retains dual-version support.

Expected:
- Users who already migrated to V=2 continue to verify (V=2 pepper still resolves).
- Re-HMAC on unlock now writes V=1 (back-migration).
- No user is locked out — this is the rollback success criterion.

### Scenario G: Mode A two-version-live operational verification (R35 Tier-2 manual scenario)

Setup: Both `VERIFIER_PEPPER_KEY` (V1) and `VERIFIER_PEPPER_KEY_V2` configured. `VERIFIER_VERSION = 2`. Existing user has `passphraseVerifierVersion = 1` and `passphraseVerifierHmac` computed under V1 pepper.

Steps:
1. Confirm DB pre-state: `SELECT passphrase_verifier_version, passphrase_verifier_hmac FROM users WHERE id = $userId` — expect `(1, <hex>)`.
2. Sign in and unlock vault with the user's actual passphrase.
3. Confirm DB post-unlock state: re-run the SELECT — expect `(2, <new hex>)`. The new hex must differ from the pre-state hex (since V2 pepper produces different HMAC).
4. Sign out, sign in again, unlock vault — expect success (now verifying with V2 pepper, V2 stored).
5. Re-run SELECT — expect `(2, <same V2 hex as step 3>)` — no further re-HMAC.

Adversarial:
- Replay-attack negative test: capture the V1-era `verifierHash` from a prior session log; replay to `/api/vault/unlock` after the user has migrated to V2. Expect 401 — the new server-side auth-hash + lockout would catch repeated attempts; the verifier itself is just for re-HMAC bookkeeping.

### Scenario F: Missing V<n> pepper at runtime

Setup: a user is on V=2, but operator forgot to provision `VERIFIER_PEPPER_KEY_V2`.

Expected:
- `validateKeys()` aborts startup (does not allow boot to proceed without the pepper for the current version).
- If validation is bypassed (test seam), verify returns false (fail-closed) rather than 500.
- Audit emits a missing-pepper-version event so operator sees the gap.

## Adjacent considerations

- **R12 audit-action group coverage**: search `audit-actions.ts` or similar for `AUDIT_ACTION_GROUPS` arrays; ensure the three new actions are registered. Also check `messages/{en,ja}.json` for action label keys.
- **R19 mock alignment**: every test that mocks `prisma.user.findUnique` with `select.passphraseVerifierVersion` or `select.recoveryVerifierVersion` must include the new field. Same for `prisma.passwordShare.findUnique` with the new `accessPasswordHashVersion`.
- **R24 migration split**: this is additive-only with defaults — single migration is fine, no flip required.
- **R25 persist/hydrate symmetry**: the new `recoveryVerifierVersion` and `accessPasswordHashVersion` must be on both write and read paths. Schema default ensures pre-existing rows are correct.
- **R29 spec citations**: this plan does not cite external standards (RFC, NIST). N/A.
