# Coding Deviation Log: expand-security-policies
Created: 2026-04-09

## Deviations from Plan

### D-01: Password generator PolicyViolation type uses hasAnySymbolGroup pre-computed field
- **Plan description**: Extract `getPolicyViolations` as-is from password-generator.tsx to shared util
- **Actual implementation**: The shared `GeneratorSettingsLike` interface uses a pre-computed `hasAnySymbolGroup: boolean` field instead of `symbolGroups: Record<string, boolean>`, to avoid coupling the shared util to the `SymbolGroupFlags` type
- **Reason**: Decoupling the shared validation from UI-specific symbol group types makes the interface usable by both team and personal forms
- **Impact scope**: `src/lib/password-policy-validation.ts`, `src/components/passwords/password-generator.tsx`

### D-02: Passkey enforcement uses auth.ts session callback instead of auth-adapter.ts
- **Plan description**: Add hasPasskey to session via auth-adapter.ts
- **Actual implementation**: Added hasPasskey enrichment in `src/auth.ts` session callback, not in auth-adapter.ts
- **Reason**: The session callback in auth.ts is the standard Auth.js extension point for enriching session data. auth-adapter.ts handles DB operations, not session payload construction.
- **Impact scope**: `src/auth.ts`, `src/types/next-auth.d.ts`

### D-03: Watchtower uses existing `old` and `expiring` categories instead of new EXPIRED_PASSWORD/EXPIRING_PASSWORD
- **Plan description**: Add new alert categories `EXPIRING_PASSWORD`, `EXPIRED_PASSWORD`
- **Actual implementation**: Reused existing `old` and `expiring` categories in the WatchtowerReport, adding policy-driven entries to the same lists
- **Reason**: The existing categories serve the same purpose — adding separate categories would create redundant UI elements. The `old` category already shows "passwords not updated in X days" and `expiring` shows "expiring soon". Policy-driven entries integrate naturally.
- **Impact scope**: `src/hooks/use-watchtower.ts`

### D-04: Team form blocking uses submitBlocked prop pattern instead of policyViolations state in base form model
- **Plan description**: Add policyViolations state to use-team-base-form-model.ts
- **Actual implementation**: Policy violations are computed in use-team-login-form-state.ts and passed as `policyBlocked` boolean via use-team-login-form-model.ts to the form component
- **Reason**: The base form model is shared by all entry types (login, card, identity, secure note). Only login entries have password-based policy checks. Adding violations to the base model would pollute the shared interface.
- **Impact scope**: `src/hooks/use-team-login-form-state.ts`, `src/hooks/use-team-login-form-model.ts`, `src/hooks/use-team-base-form-model.ts`

## Deferred Enforcement (TODO — follow-up PRs)

### TODO-01: PASSKEY_ENFORCEMENT_BLOCKED audit log emission
- **Plan step**: Step 4 / Step 7
- **Status**: Audit action defined in enum + constants. Proxy redirects user. But `logAudit()` is not called from `proxy.ts` because it runs in Edge Runtime (no Prisma access).
- **Required**: Fire-and-forget fetch to an internal API endpoint from proxy, or emit from the passkey-status API when the client calls it after redirect.

### TODO-02: Password reuse prevention — client-side wiring
- **Plan step**: Step 12
- **Status**: `checkPasswordReuse()` is defined in `password-policy-validation.ts` with timing-safe comparison. `passwordHistoryCount` field exists in TeamPolicy schema + UI + API. But no calling code fetches/decrypts history entries in `use-team-login-form-state.ts`.
- **Required**: In the team login form, when `passwordHistoryCount > 0` and editing an existing entry, fetch history, decrypt last N entries, call `checkPasswordReuse()`, and block submission on match.

### TODO-03: Team IP restriction — route handler wiring
- **Plan step**: Step 13
- **Status**: `withTeamIpRestriction()` and `checkTeamAccessRestriction()` are defined in `team-policy.ts`. `inheritTenantCidrs` and `teamAllowedCidrs` fields exist in schema + UI + API. But no team route handler calls these functions.
- **Required**: Add `withTeamIpRestriction(teamId, request, userId)` call to all team resource route handlers (passwords, tags, folders, members, etc.), or implement as shared middleware.

### TODO-04: Watchtower policy expiry — team scope
- **Plan step**: Step 9
- **Status**: Policy-driven expiry check works for personal vault entries. Team entries skip the check because `passwordMaxAgeDays` is only read from the personal vault context.
- **Required**: Apply the same policy-driven age check for team scope entries by reading the tenant policy from the team's tenant.

### TODO-05: Tenant password policy — personal vault form enforcement
- **Plan step**: Step 11
- **Status**: `vault/status` API returns `tenantMinPasswordLength`, `tenantRequireUppercase`, etc. But no personal password form hook reads or enforces these values.
- **Required**: Create a hook or extend the existing personal form to fetch tenant policy from `vault/status` and apply `getPolicyViolations()` blocking.

### TODO-06: Audit log purge — multi-tenant retention enforcement
- **Plan step**: Step 10b
- **Status**: `purge-audit-logs` route checks the retention policy of the `operatorId`'s tenant only. A system-wide purge can bypass other tenants' retention policies.
- **Required**: Either scope the purge per-tenant or enforce the strictest retention across all tenants as the floor.

---
