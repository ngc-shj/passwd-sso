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

---
