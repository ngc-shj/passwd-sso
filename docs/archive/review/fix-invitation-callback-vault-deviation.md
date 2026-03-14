# Coding Deviation Log: fix-invitation-callback-vault
Created: 2026-03-14T00:00:00+09:00

## Deviations from Plan

### DEV-1: Root cause recharacterized — signIn callback is correct, UX is the real issue
- **Plan description**: Fix 1 proposed hardening the signIn callback and potentially changing logic for nodemailer new users
- **Actual implementation**: Investigation confirmed that Auth.js v5 calls `signIn` BEFORE `createUser` for email provider. The signIn callback correctly handles new users (userId=null → returns true). Only a try-catch wrapper was added around `ensureTenantMembershipForSignIn` for defense-in-depth.
- **Reason**: The auth error was caused by users re-clicking consumed Magic Links (tokens are one-time use), not by signIn callback logic failure. The real fix is UX improvements (error page, VaultGate context, invite page resilience).
- **Impact scope**: src/auth.ts — minimal change (error handling only, no logic change)

### DEV-2: VaultGate uses usePathname() instead of props drilling
- **Plan description**: Initially considered props-based context passing, then updated to usePathname() during plan review
- **Actual implementation**: VaultGate uses `usePathname()` with regex `/\/dashboard\/(teams|emergency-access)\/invite\//` to detect invite routes
- **Reason**: App Router layouts cannot pass props to child pages. usePathname() is simple and the route paths are stable.
- **Impact scope**: src/components/vault/vault-gate.tsx

### DEV-3: InviteInfo type change — role made optional instead of adding to API response
- **Plan description**: Either make `role` optional in InviteInfo or include `role` in `alreadyMember: true` API response
- **Actual implementation**: Made `role` optional in `InviteInfo` type and used `result.role ?? ""` in template
- **Reason**: Simpler change with no API modification needed. The `alreadyMember: true` path is an edge case (existing member clicks invite link again).
- **Impact scope**: src/app/[locale]/dashboard/teams/invite/[token]/page.tsx

---
