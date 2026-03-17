# Plan: lockout-admin-alert

## Objective

Implement admin notification when vault lockout is triggered (resolves IMPROVE(#40) in `src/lib/account-lockout.ts:197`).

When a user's vault is locked out (5→15min, 10→1hr, 15→24hr), all OWNER + ADMIN users of the same tenant receive:
- In-app notification (`SECURITY_ALERT` type)
- Email alert

## Requirements

### Functional
- Notify all tenant OWNER + ADMIN only when a lockout threshold is **first crossed** (not on every subsequent failure)
- Include: affected user email, attempt count, lock duration, IP address, timestamp
- Bilingual support (ja/en) following existing i18n pattern
- Fire-and-forget: never block the lockout/auth flow

### Non-functional
- No sensitive data in notifications (no passwords, keys, tokens)
- Follow existing `new-device-detection.ts` pattern exactly
- All existing tests must continue to pass
- All email template params must pass through `escapeHtml()`

## Technical Approach

Reuse existing infrastructure — no new dependencies:
- `createNotification()` with `NOTIFICATION_TYPE.SECURITY_ALERT`
- `sendEmail()` with new email template
- `withBypassRls()` for cross-tenant DB queries (single transaction for both user + admin lookup)
- `resolveUserLocale()` for per-admin locale resolution

## Implementation Steps

### Step 1: Create email template
**New**: `src/lib/email/templates/vault-lockout.ts`
- Pattern: `new-device-login.ts` (ja/en labels, escapeHtml, emailLayout)
- Params: `userEmail`, `attempts`, `lockMinutes`, `ipAddress`, `timestamp`
- **All params must pass through `escapeHtml()`** before HTML interpolation

### Step 2: Create email template test
**New**: `src/lib/email/templates/vault-lockout.test.ts`
- Verify ja/en subjects, HTML/text body content, XSS escaping, layout wrapping
- Include XSS test with `<script>` in params to verify escaping

### Step 3: Add notification message
**Modify**: `src/lib/notification-messages.ts`
- Add `VAULT_LOCKOUT` key with ja/en title and body
- Body signature: `(email: string, lockMinutes: string) => string` — all args are strings to match existing `notificationBody(...args: string[])` pattern

### Step 4: Create admin notification function
**New**: `src/lib/lockout-admin-notify.ts`

```typescript
export interface LockoutNotifyParams {
  userId: string;
  attempts: number;
  lockMinutes: number;
  ip: string | null;
}

export async function notifyAdminsOfLockout(params: LockoutNotifyParams): Promise<void>
```

Flow:
1. Wrap entire function in try/catch (fire-and-forget, log warn on catch)
2. Single `withBypassRls` transaction:
   - Lookup user email + tenantId
   - If no tenantId → return
   - Find tenantMembers with role IN (OWNER, ADMIN), include user.email and user.locale
3. For each admin:
   - `resolveUserLocale(admin.user.locale)` for locale (falls back to "en" per existing behavior)
   - `sendEmail()` with lockout email template
   - `createNotification(SECURITY_ALERT)` — pass `tenantId` from step 2 to avoid double DB lookup inside `createNotification`
   - Metadata: `{ userEmail, attempts, lockMinutes, ipAddress, timestamp }` (non-sensitive only)
   - **`lockMinutes` must be converted to string via `String()`** when passed to `notificationBody()`
4. Outer catch: `getLogger().warn({ err, userId }, "lockout.adminNotify.error")`

### Step 5: Add `thresholdCrossed` flag to `recordFailure` and integrate notification
**Modify**: `src/lib/account-lockout.ts`

Changes:
1. Inside `recordFailure`'s transaction, compute `thresholdCrossed`:
   ```typescript
   // After threshold check loop (which sets matchedThreshold via first match)
   const matchedThreshold = LOCKOUT_THRESHOLDS.find(t => newAttempts >= t.attempts);
   const thresholdCrossed = matchedThreshold !== undefined &&
     prevAttempts < matchedThreshold.attempts;
   ```
   This is true only when `newAttempts` first reaches a threshold that `prevAttempts` hadn't.
   Simpler and more robust than comparing via `lockMinutes` indirectly.
2. Add `thresholdCrossed` to the transaction return value.
3. Add import for `notifyAdminsOfLockout`.
4. Replace `// IMPROVE(#40)` comment with:
   ```typescript
   if (result.thresholdCrossed) {
     void notifyAdminsOfLockout({
       userId,
       attempts: result.attempts,
       lockMinutes: result.lockMinutes!,
       ip: meta.ip,
     });
   }
   ```
5. Keep existing `VAULT_LOCKOUT_TRIGGERED` audit log and `getLogger().warn()` as-is — they fire on every locked failure (`lockMinutes !== null`), which is the correct behavior for audit trails. Only the admin notification is gated by `thresholdCrossed`.

### Step 6: Create tests

**New**: `src/lib/lockout-admin-notify.test.ts`

Test cases (all `await notifyAdminsOfLockout()` directly — function is async):
- All OWNER + ADMIN receive email + notification
- MEMBER role excluded
- Multiple admins → all notified
- tenantId null → no-op
- User not found → no-op
- `withBypassRls` throws → swallowed, logged
- `sendEmail` throws → swallowed, logged (notification still attempted or not, depending on implementation)
- Correct locale per admin
- `lockMinutes` passed as string to `notificationBody`

**Modify**: `src/lib/account-lockout.test.ts`

Test cases:
- Mock `@/lib/lockout-admin-notify`
- `notifyAdminsOfLockout` called when threshold 5 is first crossed (attempts 4→5), with `lockMinutes: 15`
- `notifyAdminsOfLockout` called when threshold 10 is first crossed (attempts 9→10), with `lockMinutes: 60`
- `notifyAdminsOfLockout` called when threshold 15 is first crossed (attempts 14→15), with `lockMinutes: 1440`
- `notifyAdminsOfLockout` NOT called when attempts go from 5→6 (already past threshold, not a new crossing)
- `notifyAdminsOfLockout` NOT called when attempts < 5

## Testing Strategy

1. `npx vitest run` — all tests pass
2. `npx next build` — production build succeeds
3. Manual: trigger lockout in dev → verify notification in DB + email in Mailpit

## Considerations & Constraints

- Single `withBypassRls` transaction for both user + admin lookup (avoids TOCTOU race)
- DB queries (2 within 1 transaction) are acceptable: lockout is a low-frequency security event
- Admin count is typically 1-5, so sequential email sending is fine
- `sendEmail` and `createNotification` both swallow errors internally
- If user has no tenantId (bootstrap/orphan), notification is silently skipped
- `resolveUserLocale` falls back to "en" when admin has no stored locale and no Accept-Language header (existing behavior, out of scope for this PR)

## Files Summary

| File | Op | Purpose |
|------|-----|---------|
| `src/lib/email/templates/vault-lockout.ts` | New | Email template |
| `src/lib/email/templates/vault-lockout.test.ts` | New | Template tests |
| `src/lib/notification-messages.ts` | Edit | Add VAULT_LOCKOUT message |
| `src/lib/lockout-admin-notify.ts` | New | Admin notification logic |
| `src/lib/lockout-admin-notify.test.ts` | New | Notification tests |
| `src/lib/account-lockout.ts` | Edit | Add thresholdCrossed flag + notification call |
| `src/lib/account-lockout.test.ts` | Edit | Add threshold crossing + notification tests |
