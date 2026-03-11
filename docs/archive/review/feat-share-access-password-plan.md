# Feature: Access Password for Share Links & Send

## Overview

Add optional auto-generated password protection to shared links (ENTRY_SHARE) and Send (TEXT/FILE).
When enabled, the recipient must provide the correct password before viewing the content.
The password is server-generated (strong, not human-typable) and shown once to the creator for copy-paste sharing.

## Requirements

1. **Auto-generated only**: No manual password input. Server generates a 32-byte random password (base64url, 43 chars).
2. **Copy-paste sharing**: Creator copies the generated password and shares it via a separate channel.
3. **Gate enforcement**: Without the correct password, content is not decrypted or returned.
4. **Works for all share types**: ENTRY_SHARE, TEXT, FILE.
5. **Brute-force protection**: Rate limiting + timing-safe comparison.

## Design

### Database Changes

Add two columns to `PasswordShare`:

```prisma
model PasswordShare {
  // ... existing fields ...

  // Optional access password protection
  accessPasswordHash String? @map("access_password_hash") @db.VarChar(128)
}
```

- `accessPasswordHash`: SHA-256(HMAC(pepper, password)) — same peppered approach as `hmacVerifier` in `crypto-server.ts`. Nullable = password not required.
- Using HMAC-SHA256 with pepper (not bcrypt) for consistency with existing crypto patterns and because the password is 32-byte random (not human-chosen), making dictionary attacks infeasible.

### Migration

```sql
ALTER TABLE "password_shares" ADD COLUMN "access_password_hash" VARCHAR(128);
```

### Crypto: Password Generation & Verification

In `src/lib/crypto-server.ts`, add:

```typescript
/** Generate a 32-byte random access password as base64url (43 chars). */
export function generateAccessPassword(): string {
  return randomBytes(32).toString("base64url");
}

/** Hash an access password for storage: HMAC(pepper, SHA-256(password)). */
export function hashAccessPassword(password: string): string {
  const digest = createHash("sha256").update(password).digest("hex");
  return hmacVerifier(digest);
}

/** Verify an access password against stored hash. Timing-safe. */
export function verifyAccessPassword(password: string, storedHash: string): boolean {
  const digest = createHash("sha256").update(password).digest("hex");
  return verifyPassphraseVerifier(digest, storedHash);
}
```

This reuses the existing `hmacVerifier` / `verifyPassphraseVerifier` functions which already provide:
- HMAC with pepper key (protects against DB leak)
- `timingSafeEqual` comparison (prevents timing attacks)

### API Changes

#### 1. Create Send (Text) — `POST /api/sends`

Add optional `requirePassword: boolean` to `createSendTextSchema`.

**Request:**
```json
{
  "name": "Secret",
  "text": "...",
  "expiresIn": "1d",
  "requirePassword": true
}
```

**Response (when requirePassword=true):**
```json
{
  "id": "...",
  "token": "abc123...",
  "url": "/s/abc123...",
  "expiresAt": "...",
  "accessPassword": "dGhpcyBpcyBhIHNlY3JldCBwYXNzd29yZA"
}
```

The `accessPassword` field is only returned at creation time and never stored in plaintext.

**Log safety**: API response logging middleware (if any) must exclude `accessPassword` from logs. The field should be treated as sensitive data equivalent to a secret key.

#### 2. Create Send (File) — `POST /api/sends/file`

Add optional `requirePassword` field in FormData.

#### 3. Create Share Link — `POST /api/share-links`

Add optional `requirePassword: boolean` to `createShareLinkSchema`.

#### 4. New: Verify Access Password — `POST /api/share-links/verify-access`

New endpoint for password verification. Returns a signed, short-lived access token.

This endpoint accepts `Content-Type: application/json` only. The existing Next.js `req.json()` parsing provides implicit CSRF protection (browsers won't send JSON content-type cross-origin without CORS preflight).

**Request:**
```json
{
  "token": "abc123...",
  "password": "dGhpcyBpcyBhIHNlY3JldCBwYXNzd29yZA"
}
```

**Response (success):**
```json
{
  "accessToken": "signed-jwt-or-hmac-token"
}
```

**Access token design:**
- HMAC-SHA256 signed: `base64url(shareId:expiresTs):signature`
- TTL: 5 minutes (short-lived, single session use)
- Scoped to a specific share ID
- Stored in `sessionStorage` by the client

**Rate limiting (two independent limiters):**
- `createRateLimiter({ windowMs: 60_000, max: 5 })` with key `rl:share_verify_ip:${ip}:${tokenHash}` — per IP per token
- `createRateLimiter({ windowMs: 60_000, max: 20 })` with key `rl:share_verify_token:${tokenHash}` — per token globally
- Both checked before DB lookup (to avoid Redis storage exhaustion from non-existent tokens, use `tokenHash` as key, not raw token)
- Failed attempts logged to audit log for security monitoring

#### 5. View Share Page — `/s/[token]` (page.tsx) — Hybrid SSR+CSR

The share page becomes a hybrid: server renders the gate (or error), client fetches content via API after password verification. This avoids passing access tokens in URLs.

**Modified flow:**
1. Look up share by `tokenHash` (server)
2. Check revoked/expired/maxViews as before
3. If `accessPasswordHash` is NOT set → proceed as before (server decrypts, increments viewCount, renders)
4. If `accessPasswordHash` IS set → **do NOT increment viewCount** → render `ShareProtectedContent` client component (passing `shareId`, `token`, `shareType`, `entryType`, `expiresAt`, `maxViews`)

Note: `accessPasswordHash` must be added to the `select` clause in `prisma.passwordShare.findUnique`. Only its presence (not its value) is needed — select as `accessPasswordHash: true` and check `!!share.accessPasswordHash`.
5. Client: after password verification, receives `accessToken` from verify endpoint
6. Client: calls `GET /api/share-links/[id]/content` with `Authorization: Bearer <accessToken>` header (new endpoint, see below) which increments viewCount and returns decrypted content
7. Client: renders content in `ShareSendView` / `ShareEntryView`

**Why not URL search param?** Access tokens in URLs leak via Referer headers, browser history, and server logs. Using client-side fetch with the token avoids this entirely.

#### 6. New: Get Share Content — `GET /api/share-links/[id]/content`

New API endpoint for fetching password-protected share content after verification.

**Request:** `GET /api/share-links/{shareId}/content` with `Authorization: Bearer <accessToken>` header

**Flow:**
1. Verify access token (HMAC signature + expiry + shareId match)
2. Look up share, check revoked/expired/maxViews
3. Atomically increment viewCount (same `$executeRaw` pattern as current page.tsx)
4. Decrypt and return content as JSON

**Response:**
```json
{
  "shareType": "TEXT",
  "entryType": null,
  "data": { "name": "...", "text": "..." },
  "expiresAt": "...",
  "viewCount": 5,
  "maxViews": 10,
  "sendFilename": null,
  "sendSizeBytes": null
}
```

#### 7. File Download — `/s/[token]/download`

Modified flow:
1. Add `accessPasswordHash`, `maxViews`, `viewCount` to the `select` clause
2. Check `maxViews`/`viewCount` (for ALL shares, not just password-protected — fixes pre-existing gap)
3. If share has `accessPasswordHash`, require `Authorization: Bearer <accessToken>` header and verify it
4. **Do NOT increment viewCount** in download (already incremented by page.tsx or content API)
5. Client includes the access token from sessionStorage via fetch (not direct link)

For password-protected FILE shares, the download button triggers a client-side `fetch` with Authorization header and creates a blob URL for download, instead of a direct `<a href>` link.

**viewCount policy:** viewCount is incremented exactly once per "view" — either by `page.tsx` (non-protected shares) or by the content API (protected shares). The download endpoint never increments viewCount.

#### 8. E2E Shares (Team Entries, masterKeyVersion === 0)

Password protection is supported for E2E shares. The flow is:
1. Creator enables `requirePassword` when creating a team entry share
2. Server stores `accessPasswordHash` as usual
3. Viewer visits `/s/[token]` → sees password gate (same as server-encrypted shares)
4. After verification, client receives the encrypted data blob via the content API
5. Client decrypts with the key from URL fragment (existing E2E flow)

The password gate protects access to the encrypted data itself, not the decryption key. This is defense-in-depth: even with the URL fragment key, the encrypted data is not served without the password.

### Access Token Utility

New file: `src/lib/share-access-token.ts`

```typescript
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { getMasterKeyByVersion } from "@/lib/crypto-server";

const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getSigningKey(): Buffer {
  // Derive from master key to avoid another env var
  return createHash("sha256")
    .update("share-access-token:")
    .update(getMasterKeyByVersion(1))
    .digest();
}

export function createShareAccessToken(shareId: string): string {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = JSON.stringify({ sid: shareId, exp: expiresAt });
  const payloadB64 = Buffer.from(payload).toString("base64url");
  const signature = createHmac("sha256", getSigningKey())
    .update(payloadB64)
    .digest("base64url");
  return `${payloadB64}.${signature}`;
}

export function verifyShareAccessToken(token: string, expectedShareId: string): boolean {
  const dotIdx = token.indexOf(".");
  if (dotIdx < 0) return false;
  const payloadB64 = token.slice(0, dotIdx);
  const signature = token.slice(dotIdx + 1);
  if (!payloadB64 || !signature) return false;

  let parsed: { sid?: string; exp?: number };
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
  } catch {
    return false;
  }
  if (parsed.sid !== expectedShareId) return false;
  if (typeof parsed.exp !== "number" || Date.now() > parsed.exp) return false;

  const expectedSig = createHmac("sha256", getSigningKey())
    .update(payloadB64)
    .digest("base64url");
  const a = Buffer.from(signature, "base64url");
  const b = Buffer.from(expectedSig, "base64url");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

### UI Changes

#### 1. Send Dialog (`send-dialog.tsx`)

Add a toggle/switch: "Require access password" (default: off).

In the success state (after creation), if `accessPassword` is returned:
- Show the password in a read-only input with copy button
- Warning text: "This password will only be shown once. Copy it now."

#### 2. Share Link Dialog (if applicable)

Same toggle pattern.

#### 3. Password Gate (`share-password-gate.tsx`) — New Component

Shown on `/s/[token]` when the share requires a password:

```
┌──────────────────────────────────┐
│  🔒 Password Required           │
│                                  │
│  This content is protected.      │
│  Paste the access password       │
│  to continue.                    │
│                                  │
│  [____________________________]  │
│  [        Unlock ▶         ]     │
│                                  │
│  ⚠ Paste only — this password   │
│    cannot be manually typed.     │
└──────────────────────────────────┘
```

- Input field with paste event handler (read-only text input, only accepts paste)
- Submit button calls `POST /api/share-links/verify-access`
- On success: store access token in `sessionStorage`, then fetch content via `GET /api/share-links/[id]/content` with `Authorization: Bearer` header
- Render content inline using `ShareSendView` / `ShareEntryView` / `ShareE2EEntryView`
- On failure: show error message, rate limit info
- Rate limit: disable button after 5 failed attempts

#### 4. Share Protected Content (`share-protected-content.tsx`) — New Component

Wrapper client component rendered by `page.tsx` when a password-protected share is found. Manages the flow:
1. Renders `SharePasswordGate` initially
2. After successful verification, fetches content via API
3. Renders the appropriate view component with the fetched data

#### 5. Share Send View & Entry View

Pass `accessToken` to file download: use client-side `fetch` with `Authorization: Bearer` header and create blob URL for download.

### i18n Keys

Add to `messages/en/Share.json` and `messages/ja/Share.json`:

```json
{
  "requirePassword": "Require access password",
  "requirePasswordDesc": "Generate a strong password that must be provided to view this content",
  "accessPasswordLabel": "Access password",
  "accessPasswordWarning": "This password will only be shown once. Copy it now.",
  "passwordRequired": "Password required",
  "passwordRequiredDesc": "This content is protected. Paste the access password to continue.",
  "pasteOnly": "Paste only — this password cannot be manually typed.",
  "unlock": "Unlock",
  "wrongPassword": "Incorrect password. Please try again.",
  "tooManyAttempts": "Too many attempts. Please wait a moment."
}
```

### API Error Codes

Add to `src/lib/api-error-codes.ts`:

```typescript
SHARE_PASSWORD_REQUIRED: "SHARE_PASSWORD_REQUIRED",
SHARE_PASSWORD_INCORRECT: "SHARE_PASSWORD_INCORRECT",
```

### Validation Schema Changes

```typescript
// Send text
export const createSendTextSchema = z.object({
  name: z.string().min(1).max(SEND_NAME_MAX_LENGTH).trim(),
  text: z.string().min(1).max(SEND_MAX_TEXT_LENGTH),
  expiresIn: z.enum(["1h", "1d", "7d", "30d"]),
  maxViews: z.number().int().min(MAX_VIEWS_MIN).max(MAX_VIEWS_MAX).optional(),
  requirePassword: z.boolean().optional(),  // NEW
});

// Send file meta
export const createSendFileMetaSchema = z.object({
  name: z.string().min(1).max(SEND_NAME_MAX_LENGTH).trim(),
  expiresIn: z.enum(["1h", "1d", "7d", "30d"]),
  maxViews: z.coerce.number().int().min(MAX_VIEWS_MIN).max(MAX_VIEWS_MAX).optional(),
  requirePassword: z.coerce.boolean().optional(),  // NEW (coerce for FormData)
});

// Share link
export const createShareLinkSchema = z.object({
  // ... existing fields ...
  requirePassword: z.boolean().optional(),  // NEW
});

// Verify access password
export const verifyShareAccessSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/),
  password: z.string().min(1).max(44),
});
```

## File Changes Summary

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Add `accessPasswordHash` to `PasswordShare` |
| `src/lib/crypto-server.ts` | Add `generateAccessPassword`, `hashAccessPassword`, `verifyAccessPassword` |
| `src/lib/share-access-token.ts` | New: signed access token create/verify |
| `src/lib/validations.ts` | Add `requirePassword` to schemas, new `verifyShareAccessSchema` |
| `src/lib/api-error-codes.ts` | Add `SHARE_PASSWORD_REQUIRED`, `SHARE_PASSWORD_INCORRECT` |
| `src/app/api/sends/route.ts` | Handle `requirePassword`, return `accessPassword` |
| `src/app/api/sends/file/route.ts` | Handle `requirePassword`, return `accessPassword` |
| `src/app/api/share-links/route.ts` | Handle `requirePassword`, return `accessPassword` |
| `src/app/api/share-links/verify-access/route.ts` | New: password verification endpoint |
| `src/app/api/share-links/[id]/content/route.ts` | New: content retrieval for password-protected shares |
| `src/app/s/[token]/page.tsx` | Check for password protection, render gate or content |
| `src/app/s/[token]/download/route.ts` | Verify access token + maxViews/revoke for password-protected shares |
| `src/components/share/share-password-gate.tsx` | New: password input gate component |
| `src/components/share/share-protected-content.tsx` | New: client component that fetches + renders content after verification |
| `src/components/share/send-dialog.tsx` | Add password toggle + show generated password |
| `src/components/share/share-send-view.tsx` | Pass access token for download (fetch + blob URL) |
| `messages/en/Share.json` | Add i18n keys |
| `messages/ja/Share.json` | Add i18n keys |

## Testing Strategy

### Unit Tests
1. **crypto-server.ts**: Test `generateAccessPassword`, `hashAccessPassword`, `verifyAccessPassword`
   - Round-trip: `verifyAccessPassword(pw, hashAccessPassword(pw))` returns true
   - Wrong password returns false
   - Generated password is 43-char base64url
2. **share-access-token.ts**: Test `createShareAccessToken`, `verifyShareAccessToken`
   - Valid token for correct shareId
   - Expired token rejected
   - Wrong shareId rejected
   - Tampered signature rejected
   - Malformed tokens: no `.`, empty string, invalid base64url, multiple `.`
3. **validations.ts**: Test `verifyShareAccessSchema`, updated schemas with `requirePassword`
   - `generateShareToken()` output passes `verifyShareAccessSchema.token` validation

### API Integration Tests
4. **POST /api/sends**: Verify `requirePassword=true` returns `accessPassword` and stores hash
5. **POST /api/sends/file**: Same as above for file sends
6. **POST /api/share-links**: Same for entry shares (personal and team/E2E)
7. **POST /api/share-links/verify-access**: Correct password → access token, wrong password → 403, rate limiting (both IP-level and token-level limiters)
8. **GET /api/share-links/[id]/content**: Valid access token → content, expired → 403, wrong shareId → 403, no token → 401
9. **GET /s/[token]/download**: Reject without access token when password-protected; accept with valid token; reject expired token; reject wrong-shareId token; backward compatibility (non-protected shares still work without token); maxViews enforcement (reject when viewCount >= maxViews for all shares)

### Page-level Tests
10. **`/s/[token]` page**: With `accessPasswordHash` set → renders `ShareProtectedContent` (no viewCount increment); without → renders content directly (viewCount incremented)

### E2E / Component Tests
11. **SharePasswordGate**: Renders gate, paste input works, submit calls verify endpoint, keyboard input blocked
12. **ShareProtectedContent**: After verification, fetches content API and renders appropriate view
13. **SendDialog**: Toggle shows, generated password displayed on success

### Test Prerequisites
- `SHARE_MASTER_KEY` or `SHARE_MASTER_KEY_V1` env var required (existing dev fallback)
- `VERIFIER_PEPPER_KEY` uses dev fallback from master key in test/dev environments
- Existing test mocks for `crypto-server` must be updated to include `generateAccessPassword` and `hashAccessPassword` (affects `sends/route.test.ts`, `share-links/route.test.ts`)

## Security Considerations

1. **Password strength**: 32 random bytes (256 bits of entropy) — computationally infeasible to brute force
2. **Storage**: HMAC-peppered SHA-256 hash only — no plaintext or reversible form stored
3. **Timing attacks**: `timingSafeEqual` for all comparisons
4. **Rate limiting**: 5 attempts/min per IP per token on verify endpoint
5. **Access token**: HMAC-signed, 5-minute TTL, scoped to share ID — cannot be reused for other shares
6. **View count**: Only incremented after successful password verification (not on gate render)
7. **No enumeration**: Password gate shown only after token lookup succeeds (same error for not-found)
8. **Paste-only input**: UX hint only (not enforced server-side) — security comes from password strength
9. **Key derivation**: Signing key derived from master key V1 with domain separator — no extra env var needed
10. **Audit logging**: Both successful and failed password verification attempts are logged to the audit log with IP and user agent for security monitoring

## Out of Scope

- Password rotation (revoke & recreate instead)
- Custom password input (intentionally excluded per requirements)
- Password hint storage
- Remember password across sessions (sessionStorage only)
