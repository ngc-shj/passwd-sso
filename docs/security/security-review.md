# Security Review

Last updated: 2026-04-12
Branch baseline: `main` (includes merged fixes from `fix/security-review-proxy-import`, `feat/tenant-team-scim-spec`, and the bridge-code exchange flow from `feature/extension-bridge-code-exchange`)

## 1. Authentication / Authorization Boundary

### Scope checked
- Proxy-level route gating (session vs Bearer bypass)
- API-level auth fallback (`authOrToken`)
- Extension token validation and scope enforcement
- Extension token issue/refresh/revoke route boundaries

### Checklist and result

1. Proxy only bypasses Bearer for intended routes  
Status: `PASS`  
Evidence:
- `src/proxy.ts:64` allowlist includes:
  - `API_PATH.PASSWORDS`
  - `API_PATH.VAULT_UNLOCK_DATA`
  - `API_PATH.EXTENSION_TOKEN`
  - `API_PATH.EXTENSION_TOKEN_REFRESH`
- `src/proxy.ts:73` exact-match restriction for extension token endpoints prevents unintended child-path bypass.
- `src/__tests__/proxy.test.ts:68` / `src/__tests__/proxy.test.ts:122` verify refresh/revoke bypass and unknown child path non-bypass.

2. Protected APIs still require session when not in Bearer allowlist  
Status: `PASS`  
Evidence:
- `src/proxy.ts:89` protected path block includes passwords/tags/orgs/audit/share/emergency/extension.
- `src/__tests__/proxy.test.ts:77` and `src/__tests__/proxy.test.ts:91` verify non-allowlisted Bearer paths return `401`.

3. Bearer token is validated server-side (not trusted at proxy)  
Status: `PASS`  
Evidence:
- `src/proxy.ts:62` note and behavior: proxy bypass is only pass-through.
- `src/lib/extension-token.ts:66` validates token hash, revocation, expiry.

4. Scope is enforced for token-based access  
Status: `PASS`  
Evidence:
- `src/lib/auth-or-token.ts:40` enforces `requiredScope` for token path.
- Password list endpoint requires `passwords:read`: `src/app/api/passwords/route.ts:15`.
- Vault unlock data endpoint requires `vault:unlock-data`: `src/app/api/vault/unlock/data/route.ts:16`.

5. Token lifecycle boundaries are explicit  
Status: `PASS`  
Evidence:
- Issue (legacy direct) requires Auth.js session: `src/app/api/extension/token/route.ts`.
- Issue (bridge code) requires Auth.js session + Origin check: `src/app/api/extension/bridge-code/route.ts`.
- Exchange consumes a one-time, server-side, atomically-claimed code (no session): `src/app/api/extension/token/exchange/route.ts`.
- Revoke requires valid Bearer token: `src/app/api/extension/token/route.ts` (DELETE handler).
- Refresh requires valid Bearer token + active DB session: `src/app/api/extension/token/refresh/route.ts`.

6. Bridge code exchange enforces server-side identity resolution  
Status: `PASS`  
Evidence:
- `userId`, `tenantId`, `scope` are read from the consumed `ExtensionBridgeCode` row, never from request body — see `src/app/api/extension/token/exchange/route.ts`.
- Atomic single-use enforcement via `updateMany({ where: { codeHash, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } })` returning `count === 0` on replay — same pattern as the existing optimistic-lock pattern in `src/app/api/extension/token/refresh/route.ts`.
- Failure paths (unknown code, replay, malformed body) log via pino without `logAudit` because no resolvable user/tenant is available.
- See `docs/architecture/extension-token-bridge.md` for the full threat-model write-up.

### Notes / residual risk
- `authOrToken` prioritizes session over token (`src/lib/auth-or-token.ts:30`).  
  This is intentional (session = full app auth), but should remain a documented policy choice.
- Proxy session cache is process-memory (`src/proxy.ts:17`).  
  Security impact is low here; test impact was handled by using unique cookies in proxy tests.

### Conclusion (Section 1)
- No blocking issue found in auth/authz boundary after current fixes.
- Current implementation matches intended model: proxy pass-through for limited Bearer routes + strict route-level token validation.

## 2. Token Lifecycle / Session Persistence

### Scope checked
- Extension token issue/refresh/revoke flow
- Expiry alarm and retry behavior
- Local persistence semantics (`chrome.storage.session`)

### Checklist and result

1. Expired token is invalidated locally  
Status: `PASS`  
Evidence:
- `extension/src/background/index.ts:271` (`ALARM_TOKEN_TTL`) calls `clearToken()`.
- `extension/src/background/index.ts:719` and `extension/src/background/index.ts:735` clear on access if `expiresAt` is past.

2. Refresh runs before expiry and handles transient/permanent failures  
Status: `PASS`  
Evidence:
- `extension/src/background/index.ts:157` schedules refresh at `expiresAt - REFRESH_BUFFER_MS`.
- `extension/src/background/index.ts:198` clears token on `401/403/404`.
- `extension/src/background/index.ts:202` and `extension/src/background/index.ts:210` retry 1 minute later for transient/network failures.

3. Revoke is executed on explicit clear/logout path  
Status: `PASS`  
Evidence:
- `extension/src/background/index.ts:726` (`CLEAR_TOKEN`) calls `revokeCurrentTokenOnServer()`.
- `extension/src/background/index.ts:229` uses `DELETE /api/extension/token` with Bearer token.

4. Persistence behavior is explicit and bounded  
Status: `PASS (design-dependent)`  
Evidence:
- `extension/src/lib/session-storage.ts:2` documents `chrome.storage.session` usage.
- `extension/src/lib/session-storage.ts:42` clears stored state on clear.
- `extension/src/background/index.ts:105` persists token + `vaultSecretKey` for SW restart recovery.
- `extension/src/background/index.ts:49` sets session storage access level to `TRUSTED_CONTEXTS` (best-effort hardening).

5. Vault unlocked state is not carried across token rotation  
Status: `PASS`  
Evidence:
- `extension/src/background/index.ts:710` forces `clearVault()` when `SET_TOKEN` receives a different token value.
- `extension/src/__tests__/background.test.ts:211` verifies relock on token change.

### Notes / residual risk
- Sensitive session fields (`token`, `vaultSecretKey`) are encrypted with an ephemeral AES-256-GCM key before being persisted to `chrome.storage.session` (`extension/src/lib/session-crypto.ts`, `extension/src/lib/session-storage.ts`).
  - The wrapping key is generated via `crypto.subtle.generateKey()` with `extractable: false` and held only in memory.
  - On service worker restart, the ephemeral key is lost, rendering stored ciphertext undecryptable. This forces re-authentication rather than allowing silent secret recovery.
  - `chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })` further restricts access to trusted extension contexts.
- This is a deliberate UX/security trade-off: secrets survive transient SW idle shutdowns (where the key remains in memory) but are irrecoverable after a full restart.
  **Decision:** keep `chrome.storage.session` with envelope encryption for extension `vaultSecretKey` to preserve UX.

### Conclusion (Section 2)
- No immediate logic bug found.
- Current implementation is consistent with the chosen model: envelope-encrypted token/session continuity across SW idle shutdowns, with forced re-authentication after full restarts.

## 3. Input / Metadata Sanitization

### Scope checked
- Import-origin filename handling written into audit metadata
- Validation order and fallback behavior

### Checklist and result

1. Filename metadata is sanitized before audit persistence  
Status: `PASS`  
Evidence:
- `src/app/api/passwords/route.ts:145` strips control chars and null bytes.
- `src/app/api/passwords/route.ts:148` replaces `/` and `\\` with `_`.
- `src/app/api/passwords/route.ts:150` truncates to 255.

2. Sanitization behavior is tested with adversarial inputs  
Status: `PASS`  
Evidence:
- `src/app/api/passwords/route.test.ts:518` control/null-byte case.
- `src/app/api/passwords/route.test.ts:554` empty-after-sanitize case.
- `src/app/api/passwords/route.test.ts:591` max-length truncation case.

### Notes / residual risk
- Sanitization currently applies to import filename metadata path only.
- If other user-provided header fields are added in future audit metadata, same normalization should be reused.

### Conclusion (Section 3)
- Current import filename metadata handling is robust enough for audit display/log storage.

## 4. Cryptography / Key Handling

### Scope checked
- KDF parameters and key hierarchy
- AAD binding
- Runtime zeroization behavior

### Checklist and result

1. KDF and key hierarchy are explicit and domain-separated  
Status: `PASS`  
Evidence:
- `src/lib/crypto-client.ts:12` PBKDF2 iterations = `600_000`.
- `src/lib/crypto-client.ts:15` and `src/lib/crypto-client.ts:16` distinct HKDF info labels.
- `src/lib/crypto-client.ts:75` and `src/lib/crypto-client.ts:133` separation wrapping/encryption/auth usage.

2. Entry ciphertext is context-bound with AAD  
Status: `PASS`  
Evidence:
- `src/lib/crypto-aad.ts:98` personal AAD builder.
- `src/lib/crypto-aad.ts:111` org AAD builder.
- `src/lib/crypto-aad.ts:124` attachment AAD builder.

3. Secret material is zeroized in key paths  
Status: `PASS (partial)`  
Evidence:
- Web app lock clears `secretKeyRef`: `src/lib/vault-context.tsx:143`.
- Web app unload cleanup: `src/lib/vault-context.tsx:280`.
- Extension unlock zeroes temporary secret: `extension/src/background/index.ts:798`.

### Notes / residual risk
- Extension `vaultSecretKey` is held in memory and persisted to `chrome.storage.session` via envelope encryption (AES-256-GCM with a non-extractable ephemeral key; see Section 2 notes).
  Plaintext secret is never written to storage. The residual risk is limited to in-memory exposure during an active session.

### Conclusion (Section 4)
- Crypto primitives and AAD usage are solid.
- Extension vault secret persistence uses envelope encryption; residual risk is limited to in-memory exposure.

## 5. Audit Log Integrity / Traceability

### Scope checked
- Import/export summary actions
- Parent-child linkage for bulk/import-derived entry actions
- Logging robustness

### Checklist and result

1. Import summary event is recorded explicitly  
Status: `PASS`  
Evidence:
- `src/app/api/audit-logs/import/route.ts:40` logs `ENTRY_IMPORT`.
- Metadata includes requested/success/failed counts (`src/app/api/audit-logs/import/route.ts:43`).

2. Entry-level logs from import include parent action marker  
Status: `PASS`  
Evidence:
- `src/app/api/passwords/route.ts:156` sets `parentAction: ENTRY_IMPORT` on import-derived `ENTRY_CREATE`.

3. Audit write failures do not break primary operation  
Status: `PASS`  
Evidence:
- `src/lib/audit/audit.ts` writes audit events to the durable `audit_outbox` Postgres table inside the same DB transaction as the originating business write, so commit atomicity guarantees no audit loss for successfully committed operations.
- A separate `audit-outbox-worker` process (`src/workers/audit-outbox-worker.ts`) drains pending rows with exponential backoff capped at `max_attempts` (default 8). Permanently failed rows are dead-lettered both as an `AUDIT_OUTBOX_DEAD_LETTER` audit row (via `writeDirectAuditLog()`) and via the pino dead-letter logger (`_logType: "audit-dead-letter"`) for external alerting.
- Tamper-evident hash chaining (`src/lib/audit-chain.ts`, schema in `prisma/migrations/20260413110000_add_audit_chain/`) protects committed `audit_logs` rows from undetected modification or deletion. The verify endpoint `/api/maintenance/audit-chain-verify` recomputes the chain and reports breaks.
- External sink delivery is pluggable via the `AuditDeliverer` interface in `src/workers/audit-delivery.ts` (current concrete deliverers: webhook / SIEM HEC (Splunk HTTP Event Collector–compatible protocol; vendor-neutral) / S3-object).

### Notes / residual risk
- AUDIT_OUTBOX_DEAD_LETTER metadata includes a 256-char truncated `lastError` from the failing write (`src/workers/audit-outbox-worker.ts:451`); this is intended for operator diagnostics and bypasses the standard `METADATA_BLOCKLIST`. Adding blocklist scrubbing to `lastError` is tracked as a follow-up.
- Further compliance-grade hardening (e.g., external WORM-backed sink) is not implemented; the existing AuditDeliverer interface is the integration seam if needed.

### Conclusion (Section 5)
- Current audit model is a durable transactional outbox combined with a tamper-evident hash chain on `audit_logs`, providing atomicity with the business write and detection of post-commit modification.
- Further compliance-grade hardening (e.g., WORM-backed external sinks) is delegated to operators via the `AuditDeliverer` integration seam rather than implemented in-app.

## 6. Test Coverage Review (Current Security Findings)

### Result summary
- Section 1/2/3 findings are now covered with targeted tests.
- No immediate critical gap remains for the issues raised in this review cycle.
- Section 7 (tenant/RLS) added 2026-02-27 with full review coverage.

### Covered by tests
- Proxy Bearer bypass scope and non-bypass behavior: `src/__tests__/proxy.test.ts`.
- Import filename sanitization path: `src/app/api/passwords/route.test.ts`.
- Extension refresh failure/retry branches (`429`/`5xx`): `extension/src/__tests__/background.test.ts`.
- Extension `CLEAR_TOKEN` revoke + local clear flow: `extension/src/__tests__/background.test.ts`.
- Exact-match restriction regression for extension token child paths: `src/__tests__/proxy.test.ts`.

### Remaining recommended additions (non-blocking)
- None for the findings in this review cycle.

### Final conclusion
- Current state is acceptable for continuing development.
- `vaultSecretKey` persistence policy is fixed: keep `chrome.storage.session` for extension UX.
- All 7 sections PASS (Section 7 added 2026-02-27).

## 7. Multi-Tenant Isolation / Row Level Security (2026-02-27)

### Scope checked
- FORCE ROW LEVEL SECURITY on all tenant-scoped tables
- Tenant context propagation (`SET LOCAL app.tenant_id`)
- `withBypassRls` allowlist enforcement
- IdP claim sanitization and tenant lookup
- Bootstrap tenant migration

### Checklist and result

1. FORCE RLS applied to all 28 tenant-scoped tables
Status: `PASS`
Evidence:
- Migration applies `ALTER TABLE ... FORCE ROW LEVEL SECURITY` to all 39 tables.
- `scripts/checks/check-bypass-rls.mjs` CI guard enforces allowlist (25 files) for `withBypassRls` usage.
- `scripts/checks/check-team-auth-rls.mjs` CI guard prevents nested team-auth under RLS wrappers.

2. Tenant context is set via session-local variable
Status: `PASS`
Evidence:
- `src/lib/tenant-rls.ts` uses `SET LOCAL app.tenant_id` within transaction scope.
- `src/lib/prisma.ts` Proxy (L143-153) correctly handles nested `$transaction` by reusing active RLS-scoped tx.

3. IdP claim values are sanitized before use as tenant identifiers
Status: `PASS`
Evidence:
- `src/lib/tenant-claim.ts` strips C0/C1/DEL control characters (`[\x00-\x1f\x7f-\x9f]`).
- Length limit: 255 characters max.
- Whitespace-only values rejected.
- Non-string types rejected.
- Reserved slug prefixes (`bootstrap-`, `u-`) get `t-` prepended.

4. Tenant lookup uses `externalId` (not user-controlled `id`)
Status: `PASS`
Evidence:
- `src/auth.ts` uses `where: { externalId: tenantClaim }` for tenant lookup/creation.
- `externalId` is `@unique @db.VarChar(255)` with dedicated index.
- P2002 (unique constraint) collision handled with retry + random suffix fallback.

5. Bootstrap tenant migration is complete and uses `isBootstrap` flag
Status: `PASS`
Evidence:
- `src/auth.ts` checks `existingTenant?.isBootstrap` (not slug prefix).
- Bootstrap migration covers all 15 tenant-scoped data tables.
- `src/lib/auth-adapter.ts` sets `isBootstrap: true` on bootstrap tenant creation.

### Notes / residual risk
- `withBypassRls` is used in 25 files (allowlisted in `scripts/checks/check-bypass-rls.mjs`). Each bypasses RLS intentionally for cross-tenant operations (audit writes, tenant resolution, admin key rotation, passkey sign-in, etc.).
- `tenants` table itself has no RLS (intentional: it is the tenant resolution entry point).
- Bootstrap tenant migration assumes single-user tenants. Multi-user bootstrap tenants are not supported.

### Conclusion (Section 7)
- Multi-tenant isolation is enforced at DB level via FORCE RLS with CI guard scripts.
- IdP claim sanitization prevents injection and spoofing vectors.
- No blocking issue found.
