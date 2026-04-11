# Coding Deviation Log: extension-bridge-code-exchange
Created: 2026-04-11

## Deviations from Plan

### D-1: `EXTENSION_TOKEN_EXCHANGE_FAILURE` audit action enum value omitted
- **Plan description (§Step 3)**: Add three new audit actions including `EXTENSION_TOKEN_EXCHANGE_FAILURE`.
- **Actual implementation**: Only two values added — `EXTENSION_BRIDGE_CODE_ISSUE` and `EXTENSION_TOKEN_EXCHANGE_SUCCESS`. The `..._FAILURE` value is NOT in the enum.
- **Reason**: Plan §Considerations §7 (decided in Round 2 / R2-S1) requires failure paths to use pino-only logging via `getLogger().warn(...)` because `logAudit()` cannot resolve a tenant for unknown users. An audit action value that is never emitted would be dead code and would also propagate confusion (developers might call `logAudit({ action: "EXTENSION_TOKEN_EXCHANGE_FAILURE", ... })` and silently lose the record). Omitting the enum value enforces the design at the type level.
- **Impact scope**: Audit log enum, i18n keys, audit action group membership. The plan §Step 3 text mentioned three values but the §Considerations §7 design implicitly invalidates the third. This deviation aligns the implementation with the design intent.

---

### D-2: New deviation IA-1 — `proxy.ts` modification (raised during impact analysis)
- **Plan description**: The plan did NOT mention `proxy.ts` changes.
- **Actual implementation**:
  - Added an explicit bypass for `pathname === API_PATH.EXTENSION_TOKEN_EXCHANGE` that returns `NextResponse.next()` with CORS headers and `allowExtension: true`. Placed before the share-link verify-access bypass for visibility.
  - Updated the OPTIONS preflight handler to set `allowExtension: isBearerRoute || isExtensionExchangeRoute` so that chrome-extension origin preflights succeed for the exchange endpoint.
  - Added two test cases to `src/__tests__/proxy.test.ts`: (1) exchange bypasses session check, (2) bridge-code endpoint without session returns 401 (existing EXTENSION prefix behavior preserved).
- **Reason**: `src/proxy.ts:259` includes `pathname.startsWith(API_PATH.EXTENSION)` in the session-required block. Without an explicit bypass, the new exchange endpoint would receive a 401 from proxy before the route handler ran. This was caught during Phase 2 Step 2-1 impact analysis and recorded in plan §Phase 2 Impact Analysis Findings (IA-1).
- **Impact scope**: `src/proxy.ts`, `src/__tests__/proxy.test.ts`.

---

### D-3: Migration created by hand (not via `prisma migrate dev`)
- **Plan description (§Step 1)**: "Create migration: `prisma/migrations/YYYYMMDDHHMMSS_add_extension_bridge_codes/migration.sql`. Verify with `npm run db:migrate`."
- **Actual implementation**: Migration SQL written manually at `prisma/migrations/20260411123230_add_extension_bridge_codes/migration.sql`. `npm run db:migrate` was NOT run.
- **Reason**: The shared dev DB has migrations from another active feature branch (`feature/expand-security-policies`) that are not in the current branch's migrations directory. `prisma migrate dev` blocks with "We need to reset the public schema" — running `prisma migrate reset` would destroy data the user actively needs on the other branch. `prisma migrate dev --create-only` is also blocked by the same drift check. The safest path was to write the migration SQL manually by mirroring the existing similar migrations (`20260328075528_add_rls_machine_identity_tables` for the RLS policy block, `20260327214409_add_service_account_models` for the table+indexes+FKs structure). `npx prisma generate` was run to refresh the client types — this only updates `node_modules/@prisma/client` and does not touch the DB.
- **Impact scope**: `prisma/migrations/20260411123230_add_extension_bridge_codes/migration.sql` (NEW, hand-written). Memory entry `feedback_prisma_migrate_drift.md` was added to record this gotcha for future sessions.

---

### D-4: `src/lib/inject-extension-token.ts` rename
- **Plan description (§Step 7)**: Rename to `inject-extension-bridge-code.ts`.
- **Actual implementation**: Used `git mv` to rename. The test file `inject-extension-token.test.ts` was also renamed to `inject-extension-bridge-code.test.ts` and rewritten to test the new function.
- **Reason**: Per plan §Step 7. The git rename detection threshold may treat the rewrite as delete+create due to large content overlap reduction (Round 3 R3-T9 noted this concern). Acceptable; the diff is reviewable either way.
- **Impact scope**: `src/lib/inject-extension-token.ts` → `src/lib/inject-extension-bridge-code.ts`, test file rename.

---

### D-5: Refresh route NOT modified (per plan §Step 6)
- **Plan description (§Step 6)**: `POST /api/extension/token/refresh` is explicitly excluded from the `issueExtensionToken()` refactor.
- **Actual implementation**: `src/app/api/extension/token/refresh/route.ts` is unchanged.
- **Reason**: Refresh requires `revoke(oldToken) + create(newToken)` to be atomic in a single transaction. Replacing with a standalone helper would split the operation across two transactions and introduce a TOCTOU window. This was decided in Round 2 (F-06) and documented in plan §Step 6.
- **Impact scope**: None (no change).

---

### D-6: Cross-repo constants sync test placement
- **Plan description (§Step 9 — added in Round 5 R5-T2)**: Create `src/__tests__/i18n/extension-constants-sync.test.ts` for cross-repo numeric constant sync verification.
- **Actual implementation**: Created at the planned path. Uses `fs.readFileSync` + regex extraction (the simpler fallback path), not the relative TypeScript import. The web app vitest does not have `extension/src/lib/constants` in its `paths` configuration, so the relative import would fail at test compile time.
- **Reason**: The plan listed both approaches and noted the fallback was acceptable. The fallback (regex parsing of source) is more robust against tsconfig path drift.
- **Impact scope**: `src/__tests__/i18n/extension-constants-sync.test.ts` (NEW).

---

### D-7: API_PATH constants for new endpoints
- **Plan description**: Plan did not explicitly mention adding `EXTENSION_TOKEN_EXCHANGE` / `EXTENSION_BRIDGE_CODE` to `src/lib/constants/api-path.ts` or the extension's `api-paths.ts`.
- **Actual implementation**:
  - `src/lib/constants/api-path.ts` — added `EXTENSION_TOKEN_EXCHANGE` and `EXTENSION_BRIDGE_CODE`
  - `extension/src/lib/api-paths.ts` — added `EXTENSION_TOKEN_EXCHANGE` (the extension does not call bridge-code; only the web app does)
  - `src/lib/constants/api-path.test.ts` and `extension/src/__tests__/lib/api-paths.test.ts` — added assertions
- **Reason**: Recorded as Phase 2 IA-2 in the plan. The web app's `auto-extension-connect.tsx` migration (Step 8) needs `API_PATH.EXTENSION_BRIDGE_CODE`, and the extension's content script (Step 9) needs `EXT_API_PATH.EXTENSION_TOKEN_EXCHANGE`. Adding the constants is required for the migration to use shared values rather than hardcoded paths.
- **Impact scope**: API path constant files and their tests.
