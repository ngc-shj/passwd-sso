# Plan: fix-invitation-callback-vault

## Objective

Fix the team invitation flow for new users who sign in via Magic Link.
Currently, new users invited to a team see "認証エラー" (Auth Error) when completing Magic Link sign-in, or encounter UX issues where VaultGate blocks the invite acceptance page during vault setup.

## Requirements

### Functional
1. New users invited via team invitation must be able to sign in via Magic Link and reach the invite acceptance page
2. The invitation callbackUrl must be preserved through the entire flow: invite link → sign-in → Magic Link → vault setup → invite acceptance
3. VaultGate must not permanently block access to the invite page for users who need vault setup
4. After vault setup completion, the invite auto-accept should fire correctly
5. The invite page must NOT call the accept API until vault is UNLOCKED (VaultGate blocks mount, but this dependency must be explicit)

### Non-functional
1. No regression in existing sign-in flows (Google, SAML, Passkey)
2. No security weakening (maintain SSO tenant policy enforcement)
3. Auth error page should provide actionable guidance, not just a generic message
4. callbackUrl must be validated against internal paths only (no open-redirect)

## Root Cause Analysis

### Problem 1: Auth Error for New Users via Magic Link

The signIn callback in `src/auth.ts` (lines 201-268) has this flow for nodemailer:

1. SSO tenant check (lines 214-231): Looks up user by email. If user exists in non-bootstrap tenant → reject. For new users, this passes.
2. userId lookup (lines 235-245): Looks up user again. For new users, if Auth.js `createUser` ran BEFORE `signIn` callback, the user now exists.
3. `ensureTenantMembershipForSignIn` (line 262): Called with the new user's ID.
   - `extractTenantClaimValue(account, profile)` returns null for nodemailer
   - `resolveUserTenantId(userId)` resolves the bootstrap tenant
   - Should return true

**Potential failure points:**
- Auth.js adapter `createUser` may throw during transaction (unique constraint if user partially exists from a failed prior attempt)
- `ensureTenantMembershipForSignIn` may throw an unhandled error that Auth.js catches and redirects to error page
- The `tenantClaimStorage` AsyncLocalStorage may not be set up when running outside the expected context, causing `tenantClaimStorage.getStore()` to return undefined
- **tenantClaimStorage context boundary risk**: If `signIn` callback and `createUser` run in different AsyncLocalStorage contexts (or if contexts overlap between concurrent requests), a tenant claim could leak to the wrong user's `createUser` call. This must be verified during investigation.

### Problem 2: VaultGate Blocks Invite Page

Even if sign-in succeeds:
1. New user redirected to `/dashboard/teams/invite/[token]`
2. VaultGate in `src/components/vault/vault-gate.tsx` shows `VaultSetupWizard` full-screen
3. URL is preserved (no redirect), so after setup completes, VaultGate re-renders children
4. Invite page mounts → `useEffect(handleAccept, [])` fires → auto-accept

**Key dependency**: The invite page component is NOT mounted while VaultGate shows the setup wizard. Therefore, auto-accept only fires after vault setup completes and VaultGate renders children. This is correct behavior, but must be documented and tested.

**Remaining UX issues:**
- The VaultSetupWizard shows no context about the pending invitation
- If the auto-accept API call fails (e.g., invitation expired during setup), the user sees a generic error
- `alreadyMember: true` API response is missing `role` field, causing `InviteInfo` type mismatch

## Technical Approach

### Fix 1: Harden signIn callback error handling

**File:** `src/auth.ts`

- Add targeted error handling around `ensureTenantMembershipForSignIn`: catch only unexpected errors (not `MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED` which must still block sign-in). Log the error with a structured format (action, provider, error code — no PII like email addresses) and return false to Auth.js.
- For nodemailer provider with new users (userId is null after lookup), ensure the flow doesn't call `ensureTenantMembershipForSignIn` at all (the user was just created, membership was just established in `createUser`)

### Fix 2: Improve Auth error page

**File:** `src/app/[locale]/auth/error/page.tsx`

- Add `searchParams: Promise<{ error?: string }>` prop to the Server Component function signature and `await` it (Next.js 16 App Router pattern)
- Parse the `error` value to show more specific messages (verify actual Auth.js v5 error codes during investigation: `AccessDenied`, `Configuration`, `Verification`, etc.)
- For `AccessDenied` errors, suggest checking the email address or contacting the team admin
- The "Try again" link points to the sign-in page (internal path only). The original callbackUrl is NOT preserved on the error page to avoid open-redirect risk; users must re-navigate from the invitation link.

### Fix 3: VaultSetupWizard context awareness for invite flow

**Files:** `src/components/vault/vault-setup-wizard.tsx`, `src/components/vault/vault-gate.tsx`

- Add an optional `contextMessage` prop to VaultSetupWizard to display a contextual banner (e.g., "Complete vault setup to accept your team invitation")
- VaultGate receives `contextMessage` prop and forwards it to VaultSetupWizard
- **Implementation approach for context passing**: Since App Router layouts cannot pass props directly to child pages via `children`, use `usePathname()` inside VaultGate to detect invite routes (`/dashboard/teams/invite/`) and pass the appropriate context message. This is an intentional design choice — the pattern is simple and the route path is stable. Document this in a code comment.

### Fix 4: Invite page resilience

**File:** `src/app/[locale]/dashboard/teams/invite/[token]/page.tsx`

- Add vault status awareness using `useVault()` (similar to emergency-access invite page pattern at `src/app/[locale]/dashboard/emergency-access/invite/[token]/page.tsx`)
- When vault is not UNLOCKED (both `SETUP_REQUIRED` and `LOCKED` states), show informational UI explaining that vault setup/unlock is needed. Note: VaultGate already prevents this component from rendering in these states, so this is a defense-in-depth measure.
- When UNLOCKED, run auto-accept as before
- Show manual retry button on failure (no automatic retry — accept API is not idempotent)
- Fix `InviteInfo` type: make `role` optional, or include `role` in `alreadyMember: true` API response

### Fix 5: Email matching documentation (out of scope for implementation)

**File:** `src/app/api/teams/invitations/accept/route.ts`

- Add a code comment documenting the known limitation: email matching uses `toLowerCase()` only, without Gmail alias normalization (`+tag`, dots). This is a known limitation for a future enhancement.

## Implementation Steps

> **Dependency**: Step 1 is a **BLOCKER** for Step 2. Do not implement Step 2 until Step 1 is complete and the exact failure point is identified.

1. **[BLOCKER] Investigate exact auth error cause**:
   - Add structured error logging (format: `[AUTH_SIGNIN] provider=nodemailer action=<step> error=<code>`, no PII) at each decision point in the signIn callback
   - Verify Auth.js v5 callback execution order for email provider: does `createUser` run before or after `signIn` callback?
   - Verify `tenantClaimStorage` context initialization timing: where is `tenantClaimStorage.run()` called? Is it shared across concurrent requests?
   - Verify actual Auth.js v5 error codes passed to the error page (`searchParams.error` values)

2. **Fix signIn callback**: Based on investigation results from Step 1, fix the identified failure point. Add targeted error handling: catch unexpected errors from `ensureTenantMembershipForSignIn`, log them, and return false. Do NOT catch `MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED` — that must remain a block.

3. **Improve Auth error page**: Add `searchParams: Promise<{ error?: string }>` prop, `await` it. Parse error values and display contextual messages. "Try again" link goes to `/auth/signin` (no callbackUrl forwarding from error page).

4. **Add VaultGate/VaultSetupWizard context**: Add `contextMessage?: string` prop to VaultSetupWizard. Update VaultGate to accept and forward the prop. Use `usePathname()` in VaultGate to detect invite routes and set appropriate context message.

5. **Improve invite page resilience**: Add vault status check using `useVault()`. Guard auto-accept with `status === VAULT_STATUS.UNLOCKED`. Handle both `SETUP_REQUIRED` and `LOCKED` states with informational UI. Fix `InviteInfo` type for `alreadyMember` response. Show manual retry button on failure.

6. **Add email matching documentation**: Add code comment to accept API about known email normalization limitation.

7. **Add tests**:
   - signIn callback with nodemailer: new user (returns true), existing bootstrap user (returns true), existing SSO user (returns false), error scenarios
   - SSO tenant enforcement regression: verify Magic Link is still blocked for SSO tenant users
   - VaultGate: renders contextMessage via VaultSetupWizard when status is SETUP_REQUIRED
   - VaultGate: forwards contextMessage prop correctly
   - Invite page: vault UNLOCKED → auto-accept fires
   - Invite page: vault SETUP_REQUIRED → shows informational message (defense-in-depth)
   - Invite page: vault LOCKED → shows informational message
   - Auth error page: renders different messages for AccessDenied vs default error

8. **Build verification**: Run `npx vitest run` and `npx next build` to ensure no regressions.

## Testing Strategy

### signIn callback tests (in `src/auth.test.ts`)
- `provider: "nodemailer"`, new user (no existing record) → returns true
- `provider: "nodemailer"`, existing user in bootstrap tenant → returns true
- `provider: "nodemailer"`, existing user in SSO (non-bootstrap) tenant → returns false
- `provider: "nodemailer"`, `ensureTenantMembershipForSignIn` throws unexpected error → returns false (not crash)

### SSO enforcement regression
- Verify Magic Link is rejected for users in non-bootstrap tenants

### VaultGate / VaultSetupWizard tests
- VaultGate with `VAULT_STATUS.SETUP_REQUIRED` + `contextMessage` → renders VaultSetupWizard with banner
- VaultGate with `VAULT_STATUS.SETUP_REQUIRED` + no `contextMessage` → renders VaultSetupWizard without banner
- VaultGate with `VAULT_STATUS.UNLOCKED` → renders children

### Invite page tests
- Vault UNLOCKED → auto-accept fires (fetchApi called)
- Vault SETUP_REQUIRED → informational message shown, accept NOT called
- Vault LOCKED → informational message shown, accept NOT called

### Auth error page tests
- `searchParams.error = "AccessDenied"` → specific message rendered
- `searchParams.error = undefined` → default message rendered
- No callbackUrl forwarded in "Try again" link

### Manual verification
- Full flow: New user invite → Magic Link sign-in → vault setup → invite accept

### Build
- `npx vitest run` must pass
- `npx next build` must pass

## Security Considerations

- **callbackUrl validation**: Auth.js already validates callbackUrl against the app's origin. The error page "Try again" link does NOT forward callbackUrl to avoid open-redirect. Users must re-navigate from the invitation email link.
- **SSO tenant enforcement**: The fix must NOT weaken SSO policy. Magic Link must remain blocked for users in non-bootstrap (SSO) tenants. A dedicated regression test verifies this.
- **CSRF on auto-accept**: The accept API (`POST /api/teams/invitations/accept`) is protected by session cookie (SameSite=Lax) and is only called from the same origin. No additional CSRF token is needed.
- **Error logging**: No PII (email, userId) in log messages. Use provider name, action step, and error code only.
- **Tenant bypass**: Targeted error handling must NOT silently allow sign-in when tenant membership verification fails. Unknown errors → log + return false (block sign-in).
- **tenantClaimStorage isolation**: Must verify that AsyncLocalStorage context is properly scoped per-request. If not, tenant claims could leak between concurrent requests. Investigation step covers this.
- **Proxy session cache**: Known design tradeoff — the proxy caches session validity for up to 30 seconds (TTL). After session invalidation, dashboard routes remain accessible at the proxy layer for this window. Each route handler's `auth()` check serves as the final defense line.
- **Email matching limitation**: The invitation accept API uses `toLowerCase()` only for email comparison. Gmail alias normalization (`+tag`, dots) is not handled. This is a known limitation, documented as a code comment, and is out of scope for this fix.

## Considerations & Constraints

- **Auth.js v5 internal behavior**: The exact order of createUser vs signIn callback for email provider needs investigation. Auth.js v5 is in beta and behavior may differ from documentation. **Step 1 is a blocker for Step 2.**
- **Multi-tenant model**: The fix must not weaken SSO tenant enforcement. Magic Link must remain blocked for SSO tenant users.
- **E2E encryption**: Team invite acceptance requires vault setup (ecdhPublicKey). This is a legitimate prerequisite, not a bug. The UX should make this clear.
- **Idempotency**: The invitation accept API is not idempotent (changes status to ACCEPTED). No automatic retry — only manual retry via button.
- **App Router constraints**: Layouts cannot pass props to child pages via `children`. VaultGate uses `usePathname()` to detect invite routes. This is intentional and documented.
- **Out of scope**: Changing the Magic Link authentication mechanism itself. The fix focuses on handling the new-user invite flow correctly within existing auth infrastructure.
- **Out of scope**: Automated E2E test for the full flow (requires real SMTP + browser automation). Manual verification listed in testing strategy.
- **Out of scope**: Email alias normalization in invitation accept API. Documented as known limitation.
