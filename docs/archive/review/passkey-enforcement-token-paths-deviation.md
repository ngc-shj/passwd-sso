# Coding Deviation Log: passkey-enforcement-token-paths

Phase 2 implementation deviations from the locked plan (C1–C9). All minor; none change a contract.

## D1 — `exchangeRefreshToken` findUnique: `include` → explicit `select` (C8)
The MCP refresh `findUnique` previously used `include: { mcpClient: true }` (returns all
columns implicitly). To add `familyCreatedAt` for the absolute-cap check, it was switched to an
explicit `select` listing every field the function consumes (id, tokenHash, rotatedAt, revokedAt,
expiresAt, clientId, tenantId, userId, serviceAccountId, familyId, familyCreatedAt, accessTokenId,
scope, mcpClient). Verified the select is complete (orchestrator spot-check, oauth-server.ts:363-381).
More precise than the prior implicit-all; no behavior change for the consumed fields.

## D2 — `API_ERROR.PASSKEY_REQUIRED` added to the shared error-code module (C2/C8)
The plan said the extension/iOS refusal returns `errorCode PASSKEY_REQUIRED`. Implementing this the
non-hacky way required registering it in `src/lib/http/api-error-codes.ts` (`API_ERROR` +
`API_ERROR_STATUS=403` + `API_ERROR_I18N=passkeyRequired`) and the en/ja `ApiErrors.json`, plus the
code-count test (166→167). This is the correct shared-constant path, not a deviation in intent.

## D3 — R19 multi-tree test fix (not a plan deviation, recorded for traceability)
The co-located `*.test.ts` trees were updated by the implementation batches, but four CENTRALIZED
siblings under `src/__tests__/` (mcp/authorize, lib/mcp/refresh-token, extension/bridge-code-cnfJkt,
extension/token-refresh-cnfJkt) referenced the changed routes/lib and needed the same
`derivePasskeyState`/`user.findUnique` mocks + `familyCreatedAt` fixtures. Fixed test-only. Surfaced
only by the full-suite run (the per-batch runs were green). Reinforces the R19 all-test-tree obligation.

## D4 — bypass-rls allowlist (R18)
`derivePasskeyState` (passkey-enforcement.ts) and the MCP refresh pre-read (mcp/token/route.ts) open
`withBypassRls`; both were added to `scripts/checks/check-bypass-rls.mjs` ALLOWED_USAGE with reasons
(webAuthnCredential+tenant; mcpRefreshToken respectively) — the prescribed security-reviewed path.
