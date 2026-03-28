# Coding Deviation Log: delegated-decryption
Created: 2026-03-28T23:15:00+09:00

## Deviations from Plan

### D-01: encryptShareData/decryptShareData → encryptServerData/decryptServerData (with AAD)

- **Plan description**: Section 2 (Redis Key Structure) specifies `encryptShareData()` / `decryptShareData()` from `src/lib/crypto-server.ts`, noting these handle `masterKeyVersion` automatically.
- **Actual implementation**: `src/lib/delegation.ts` uses `encryptServerData` / `decryptServerData` directly, with manual `getCurrentMasterKeyVersion()` / `getMasterKeyByVersion()` calls. Introduces a custom `DelegationEncryptedPayload` interface that stores `{ encrypted, masterKeyVersion }` as JSON in Redis.
- **Reason**: `encryptShareData` / `decryptShareData` do not accept an AAD parameter. AAD binding (binding ciphertext to its Redis key path) is required by the security design to prevent ciphertext relocation attacks. This deviation was pre-identified in the plan's "Deviation Note" (Batch 1 checklist).
- **Impact scope**: `src/lib/delegation.ts` — `encryptDelegationEntry`, `decryptDelegationEntry`, `storeDelegationEntries`, `fetchDelegationEntry`. Also `src/lib/delegation.test.ts` tests the custom wrapper rather than `encryptShareData`.

---

### D-02: sendBeacon → fetch with keepalive

- **Plan description**: Section 7 (Vault Lock Integration) text in the "Modified files" list (`vault-context.tsx`) originally referenced `sendBeacon`. The plan body already corrected this in Section 7, explicitly stating `fetch('/api/vault/delegation', { method: 'DELETE', keepalive: true })` and noting `sendBeacon` is NOT suitable.
- **Actual implementation**: `src/lib/vault-context.tsx` uses `fetch("/api/vault/delegation", { method: "DELETE", keepalive: true })` in both `lock()` (line 191) and the `pagehide` handler (line 212).
- **Reason**: `sendBeacon` only supports POST and `text/plain` content-type; it cannot send DELETE or include auth cookies. The plan body already documented this and updated the approach. The "Modified files" list was stale.
- **Impact scope**: `src/lib/vault-context.tsx` only. Behavior is consistent with the intent.

---

### D-03: useToast → sonner toast

- **Plan description**: The plan does not explicitly name which toast library to use; the broader codebase convention at the time of writing referenced `useToast` from shadcn/ui.
- **Actual implementation**: `src/components/settings/delegation-manager.tsx` imports `{ toast } from "sonner"` (line 18), consistent with the `sonner` adoption used throughout recent components.
- **Reason**: The project has standardized on `sonner` for toast notifications. Using `useToast` would have been a regression.
- **Impact scope**: `src/components/settings/delegation-manager.tsx` — `toast.success(t("revoked"))` and `toast.success(t("revokedAll"))`.

---

### D-04: Alert/AlertDescription → div-based banner

- **Plan description**: Plan section 9 references a `DelegationRevokeBanner` but does not specify the internal markup. The broader pattern referenced is "after RecoveryKeyBanner".
- **Actual implementation**: `src/components/vault/delegation-revoke-banner.tsx` uses a plain `<div>` with Tailwind amber styling (`border-amber-500/30 bg-amber-500/10`) and a `<Shield>` icon from lucide-react. This matches `RecoveryKeyBanner`'s existing div-based pattern rather than importing `Alert`/`AlertDescription` shadcn/ui components.
- **Reason**: Consistency with `RecoveryKeyBanner` which also uses a div-based amber banner. Using `Alert` would have introduced visual inconsistency.
- **Impact scope**: `src/components/vault/delegation-revoke-banner.tsx` — presentational only.

---

### D-05: resolveUserTenantId instead of session.user.tenantId

- **Plan description**: Plan section 4 specifies verifying `mcpTokenId` belongs to "user's tenant" but does not specify how tenantId is obtained.
- **Actual implementation**: Both `src/app/api/vault/delegation/route.ts` (POST and DELETE handlers) and `src/app/api/vault/delegation/[id]/route.ts` call `resolveUserTenantId(userId)` rather than reading `session.user.tenantId` directly.
- **Reason**: `session.user.tenantId` may be undefined or stale. `resolveUserTenantId` performs a fresh DB lookup with RLS bypass, consistent with how other vault-adjacent routes (e.g., `rotate-key`) resolve tenancy.
- **Impact scope**: Both delegation route handlers.

---

### D-06: i18n files — messages/en/MachineIdentity.json (not messages/en.json)

- **Plan description**: Section 10 and the "Modified files" list specify `messages/en.json` and `messages/ja.json` as the target files for delegation UI strings.
- **Actual implementation**: Delegation strings were added under `"delegation"` key inside `messages/en/MachineIdentity.json` and `messages/ja/MachineIdentity.json`. The project had already migrated to per-namespace JSON files under `messages/en/` (not the monolithic `messages/en.json`).
- **Reason**: The project uses per-namespace split JSON files (e.g., `messages/en/AuditLog.json`, `messages/en/MachineIdentity.json`). Adding keys to the non-existent `messages/en.json` would have been incorrect.
- **Impact scope**: `messages/en/MachineIdentity.json`, `messages/ja/MachineIdentity.json`. The i18n namespace used in components is `useTranslations("MachineIdentity.delegation")`.

---

### D-07: CreateDelegationDialog — deferred (not implemented)

- **Plan description**: Section 9 lists `CreateDelegationDialog` as a required UI component (Settings → Developer tab, dialog opened from DelegationManager with MCP token selector, entry selector, and TTL picker).
- **Actual implementation**: `CreateDelegationDialog` was not created. `DelegationManager` shows a "New Delegation" i18n key (`t("newDelegation")`) in the i18n files but no button renders it in the current component. The "New Delegation" button is absent from `src/components/settings/delegation-manager.tsx`. The manager card shows only list + revoke functionality.
- **Reason**: Deferred. The dialog requires client-side vault decryption of entry overviews (using `encryptionKey` from `useVault()`) to populate the entry selector. This is a non-trivial component that was intentionally deferred to reduce scope.
- **Impact scope**: `src/components/settings/delegation-manager.tsx` — no "New Delegation" button. `src/components/settings/create-delegation-dialog.tsx` — not created. Users cannot create delegation sessions via the UI in the current implementation; the POST API endpoint is complete and functional, but only accessible programmatically.

---

### D-08: Tenant admin policy UI — not implemented

- **Plan description**: Section 11 specifies adding `delegationDefaultTtlSec` and `delegationMaxTtlSec` fields to the tenant policy UI (mirrors JIT token TTL pattern).
- **Actual implementation**: The Prisma schema fields (`delegationDefaultTtlSec`, `delegationMaxTtlSec`) are present on the `Tenant` model and are read by the POST delegation API. However, no UI component was added to expose these fields in the tenant admin policy settings page.
- **Reason**: Deferred alongside D-07. The fields are enforced server-side (defaulting to `DELEGATION_MAX_TTL_SEC` / `DELEGATION_DEFAULT_TTL_SEC` constants when null). Admin configuration requires direct DB manipulation until the UI is implemented.
- **Impact scope**: No new component in tenant admin settings. Schema fields exist; API enforces them; UI is absent.

---

### D-09: revokeAllDelegationSessions signature — tenantId made optional

- **Plan description**: Section 3 (Core Library) specifies `revokeAllDelegationSessions(userId, tenantId, reason): Promise<number>` with `tenantId` as a required parameter.
- **Actual implementation**: `src/lib/delegation.ts` defines the signature as `revokeAllDelegationSessions(userId: string, tenantId?: string, reason?: string)` — both `tenantId` and `reason` are optional.
- **Reason**: The function is called from `vault-context.tsx` (client-side lock context) indirectly via the DELETE endpoint which does supply tenantId. However, the function itself could be called in contexts where tenantId is not readily available (e.g., future background cleanup jobs). Making it optional avoids forcing callers to always resolve tenantId. The audit log is only emitted when `tenantId` is provided (`if (result.count > 0 && tenantId)`).
- **Impact scope**: `src/lib/delegation.ts` — function signature. `src/app/api/vault/rotate-key/route.ts` passes `user.tenantId` as second argument. `src/app/api/vault/delegation/route.ts` DELETE handler passes tenantId. No functional regression.

---

### D-10: route.test.ts for /api/vault/delegation — not created

- **Plan description**: Batch 3 checklist item: `src/app/api/vault/delegation/route.test.ts` — NEW: integration tests covering CRUD, validation, CSRF, rate limiting, one-active-per-token invariant, and tenantId isolation.
- **Actual implementation**: The file `src/app/api/vault/delegation/route.test.ts` does not exist. Only `src/lib/delegation.test.ts` (unit tests) and `src/lib/constants/mcp.test.ts` (scope exhaustiveness) were created.
- **Reason**: Deferred. The rotate-key route test was updated to mock `revokeAllDelegationSessions`, confirming integration with the key rotation path is tested there. The delegation API integration tests were not implemented in this batch.
- **Impact scope**: Missing test coverage for the delegation API endpoints: CSRF enforcement, rate limiting, one-active-per-token auto-revocation, and cross-tenant isolation.

---

### D-11: tools.test.ts — get_decrypted_credential tests not added

- **Plan description**: Batch 3 checklist: `src/lib/mcp/tools.test.ts` — get_decrypted_credential tests covering valid, expired, missing scope, Redis miss, and revokedAt check.
- **Actual implementation**: No `get_decrypted_credential` test cases were added to `src/lib/mcp/tools.test.ts`.
- **Reason**: Deferred. The `toolGetDecryptedCredential` function is tested indirectly through `src/lib/delegation.test.ts` (Redis round-trip) but the MCP tool dispatch path lacks direct unit test coverage.
- **Impact scope**: Missing test coverage for `toolGetDecryptedCredential` error paths (no delegation session, entry not in delegation, expired session).

---

### D-12: MCP token deletion does not auto-revoke active delegations

- **Plan description**: Section 5 states: "If active (non-revoked, non-expired) DelegationSession rows exist for a token, the token deletion API must auto-revoke them (set revokedAt, evict Redis) before proceeding."
- **Actual implementation**: The MCP token deletion route (`src/app/api/tenant/service-accounts/[id]/tokens/[tokenId]/route.ts`) was not modified to call `revokeDelegationSession` or `revokeAllDelegationSessions` before deletion. The `onDelete: Restrict` FK on `DelegationSession.mcpTokenId` prevents hard deletion of tokens with active sessions at the DB level, but no soft-revocation step is performed.
- **Reason**: The FK constraint prevents data corruption. The auto-revocation guard was deferred; a future implementation can add the revocation step before the DELETE to avoid the FK constraint error.
- **Impact scope**: Attempting to delete an MCP token that has active delegation sessions will return a DB constraint error (FK violation) rather than cleanly auto-revoking sessions first. This is a functional gap, not a data integrity issue.
