# Security Review

Last updated: 2026-02-14
Branch baseline: `main` (includes merged fixes from `fix/security-review-proxy-import`)

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
- Issue requires Auth.js session: `src/app/api/extension/token/route.ts:26`.
- Revoke requires valid Bearer token: `src/app/api/extension/token/route.ts:83`.
- Refresh requires valid Bearer token + active DB session: `src/app/api/extension/token/refresh/route.ts:22` and `src/app/api/extension/token/refresh/route.ts:41`.

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
- `vaultSecretKey` is persisted in `chrome.storage.session` (`extension/src/lib/session-storage.ts:12`).  
  This is a deliberate UX/security trade-off (survive MV3 SW restarts).  
  **Decision:** keep `chrome.storage.session` persistence for extension `vaultSecretKey` to preserve UX.
  Security controls remain: browser-session scoped storage, token TTL/refresh, explicit lock/clear flows.

### Conclusion (Section 2)
- No immediate logic bug found.
- Current implementation is consistent with the chosen model: token/session continuity across SW restarts.

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
- Extension keeps `vaultSecretKey` hex in memory and session storage (`extension/src/background/index.ts:39`, `extension/src/background/index.ts:127`).  
  This is the highest-sensitivity residual risk in current design.

### Conclusion (Section 4)
- Crypto primitives and AAD usage are solid.
- Main remaining risk is persistence/handling policy for extension vault secret continuity.

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
- `src/lib/audit.ts:57` catches DB write errors by design (fire-and-forget).

### Notes / residual risk
- Fire-and-forget means potential audit loss under DB outage.
- If strict compliance is required, move to durable queue/transactional outbox.

### Conclusion (Section 5)
- Current audit model is consistent with availability-first design.
- Compliance-hardening would require architectural change, not patch-level fixes.

## 6. Test Coverage Review (Current Security Findings)

### Result summary
- Section 1/2/3 findings are now covered with targeted tests.
- No immediate critical gap remains for the issues raised in this review cycle.

### Covered by tests
- Proxy Bearer bypass scope and non-bypass behavior: `src/__tests__/proxy.test.ts`.
- Import filename sanitization path: `src/app/api/passwords/route.test.ts`.

### Remaining recommended additions (non-blocking)
1. Add a direct test for extension token refresh path failure branches (429/5xx retry semantics).
2. Add integration test asserting `CLEAR_TOKEN` triggers revoke + local clear (background message flow).
3. Add regression test for exact-match restriction on extension token child paths across future route additions.

### Final conclusion
- Current state is acceptable for continuing development.
- `vaultSecretKey` persistence policy is fixed: keep `chrome.storage.session` for extension UX.
