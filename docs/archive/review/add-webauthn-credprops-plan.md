# Plan: add-webauthn-credprops

## Context

WebAuthn registration currently uses a heuristic (`singleDevice && !backedUp`) to estimate whether a credential is discoverable (resident key). WebAuthn Level 3 defines the `credProps` extension which lets the authenticator report `rk: true/false` directly. Adding this extension provides accurate discoverable detection, with fallback to the existing heuristic when the authenticator doesn't support it.

## Objective

Add `credProps` extension support to the WebAuthn registration flow, storing the result in the database and using it for accurate badge display in the UI.

## Requirements

### Functional
- Request `credProps: true` in registration options
- Read `clientExtensionResults.credProps.rk` from the registration response
- Validate `rk` as boolean before storing (non-boolean → `null`)
- Store the value as a nullable boolean in the database (`null` = authenticator didn't report)
- Display accurate discoverable/non-discoverable badge using the stored value, falling back to heuristic when `null`
- Return the new field from the credentials list API
- Include `discoverable` in audit log metadata

### Non-functional
- Backward compatible: existing credentials get `null` (no data loss)
- No breaking changes to API response shape (additive field only)

## Technical Approach

### credProps data flow
1. **Server → Client**: `generateRegistrationOptions()` includes `extensions: { credProps: true }`
2. **Client → Server**: `clientExtensionResults.credProps.rk` already sent (webauthn-client.ts L104 sends `getClientExtensionResults()`)
3. **Server**: Extract `rk` from the response object, validate as boolean, save to DB
4. **API → UI**: Return `discoverable` field in credentials list; UI uses it for badge

### Key insight
`credProps.rk` is a **client extension result**, not in `verifyRegistrationResponse()` return value. Must read from the raw response object, same pattern as transports extraction (register/verify/route.ts L124-125).

## Implementation Steps

### Step 1: Prisma schema + migration
- Add `discoverable Boolean? @map("discoverable")` to `WebAuthnCredential` model in `prisma/schema.prisma` (after `backedUp` field, line ~1204)
- Run `npm run db:migrate` to generate migration

**File:** `prisma/schema.prisma`

### Step 2: Registration options — request credProps
- Add `extensions: { credProps: true }` to `GenerateRegistrationOptionsOpts` in `generateRegistrationOpts()`

**File:** `src/lib/webauthn-server.ts` (L99-110)

### Step 3: Registration verify — extract, validate, and save credProps.rk
- After transports extraction (L125), add with type guard:
  ```ts
  const rawRk = (response as any).clientExtensionResults?.credProps?.rk;
  const discoverable: boolean | null = typeof rawRk === "boolean" ? rawRk : null;
  ```
- Add `discoverable` to `prisma.webAuthnCredential.create()` data (L139-160)
- Add `discoverable` to the JSON response (L189-200) — `create()` returns all fields, so use `credential.discoverable`
- Add `discoverable` to `logAudit` metadata (L163-176)

**File:** `src/app/api/webauthn/register/verify/route.ts`

### Step 4: Credentials list API — return discoverable field
- Add `discoverable: true` to `select` in `prisma.webAuthnCredential.findMany()`

**File:** `src/app/api/webauthn/credentials/route.ts` (L24-36)

### Step 5: UI — use discoverable field with heuristic fallback
- Add `discoverable: boolean | null` to `Credential` interface
- Update badge logic in credentials list:
  ```ts
  const isDiscoverable = cred.discoverable ?? !(cred.deviceType === "singleDevice" && !cred.backedUp);
  ```
- Update registration toast logic (`handleRegister`) to also use the new field from the registration response

**File:** `src/components/settings/passkey-credentials-card.tsx`

### Step 6: Tests
- Add unit tests for the registration verify route covering three `credProps.rk` scenarios:
  - `rk: true` → `discoverable: true` saved and returned
  - `rk: false` → `discoverable: false` saved and returned
  - `rk: null` → `discoverable: null` (authenticator returned null)
  - `rk` absent (no credProps) → `discoverable: null` saved and returned
  - `rk` with invalid type (e.g., string, number) → `discoverable: null`
- Add test for credentials list API asserting `discoverable` field is included in response

**Files:** `src/app/api/webauthn/register/verify/route.test.ts`, `src/app/api/webauthn/credentials/route.test.ts`

## Testing Strategy

- New unit tests covering `credProps.rk` extraction (3 valid scenarios + 1 invalid)
- New unit test for credentials list API response shape
- Run `npx vitest run` — all tests must pass
- Run `npx next build` — production build must succeed

## Considerations & Constraints

- `@simplewebauthn/server` v9.x supports `extensions` in options — no library upgrade needed
- `credProps.rk` may be `undefined` if authenticator doesn't support it — handled by nullable column + fallback
- Existing credentials will have `discoverable = null` — the heuristic continues to work for them
- Firefox does not yet support `credProps` — fallback is essential
- Type validation (`typeof rawRk === "boolean"`) prevents malformed client data from reaching DB
