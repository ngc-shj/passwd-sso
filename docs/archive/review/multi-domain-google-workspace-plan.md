# Plan: multi-domain-google-workspace

## Objective

Support multiple Google Workspace domains in `GOOGLE_WORKSPACE_DOMAIN` via comma-separated values, consistent with the existing `AUTH_TENANT_CLAIM_KEYS` pattern.

## Requirements

### Functional

1. `GOOGLE_WORKSPACE_DOMAIN=example.com,acme.co.jp` allows sign-in from both domains
2. Single domain (`GOOGLE_WORKSPACE_DOMAIN=example.com`) continues to work unchanged
3. Empty string (`""`) or unset: allows any Google account (current behavior preserved). Both are semantically equivalent — "no restriction".
4. Whitespace around domains is trimmed (`" example.com , acme.co.jp "` → `["example.com", "acme.co.jp"]`)
5. Domain comparison is case-insensitive: both env values and `hd` claims are lowercased before comparison
6. Google OAuth `hd` hint parameter logic:
   - No domains configured → `undefined` (omit, current behavior)
   - Single domain → that domain string (current behavior)
   - Multiple domains → `undefined` (omit, show account chooser)
7. Server-side `signIn` callback validates `profile.hd` against the domain list
8. When domains are configured, personal Gmail accounts (no `hd` claim) are rejected — they don't belong to any allowed domain

### Non-functional

1. No new dependencies
2. No database changes
3. Backward-compatible — no breaking changes for existing single-domain deployments

## Technical approach

### Parsing utility

Create a `parseAllowedGoogleDomains()` function in `src/lib/google-domain.ts`:

- Reads `process.env.GOOGLE_WORKSPACE_DOMAIN`
- Splits by comma, trims, filters empty strings, lowercases each entry
- Returns `string[]` (empty array = allow all)

### Changes to `src/auth.config.ts`

Cache parse result at module scope:

```typescript
const allowedGoogleDomains = parseAllowedGoogleDomains();
```

1. **`hd` parameter** (L36): `hd: allowedGoogleDomains.length === 1 ? allowedGoogleDomains[0] : undefined`
2. **`signIn` callback** (L157-164): Replace single-domain check with `allowedGoogleDomains.length > 0 && !allowedGoogleDomains.includes(hd?.toLowerCase())` → return false

### Changes to `.env.example`

1. Update comment to mention comma-separated format

### Documentation updates

- Update `README.md`, `README.ja.md`, `docs/setup/docker/en.md` to mention comma-separated format

## Implementation steps

1. Create `src/lib/google-domain.ts` with `parseAllowedGoogleDomains()`
2. Create `src/lib/google-domain.test.ts` with unit tests
3. Update `src/auth.config.ts`:
   - Import and cache `parseAllowedGoogleDomains` at module scope
   - Change `hd` parameter to use cached result
   - Update `signIn` callback to use domain list
4. Update `src/auth.config.test.ts` with signIn callback domain validation tests
5. Update `.env.example` comment
6. Update documentation files (README.md, README.ja.md, docs)

## Testing strategy

1. Unit tests for `parseAllowedGoogleDomains()`:
   - Empty/undefined → `[]`
   - Single domain → `["example.com"]`
   - Multiple domains → `["example.com", "acme.co.jp"]`
   - Whitespace trimming
   - Trailing comma handling (`"example.com,"` → `["example.com"]`)
   - Case normalization (`"Example.COM"` → `["example.com"]`)
2. Unit tests for `signIn` callback:
   - Single allowed domain: matching hd → allow, non-matching → reject
   - Multiple allowed domains: matching any → allow, none matching → reject
   - No domains configured: any hd (including undefined) → allow
   - Domains configured + personal Gmail (no hd) → reject
   - Case-insensitive match: `hd: "Example.COM"` vs domain `"example.com"` → allow
3. Build verification: `npx next build`
4. Full test suite: `npx vitest run`

## Considerations & constraints

- Google OAuth `hd` parameter is a UI hint only — it does NOT enforce domain restriction server-side. The `signIn` callback is the actual enforcement point.
- `AUTH_TENANT_CLAIM_KEYS` already uses comma-separated pattern — this is consistent.
- The `hd` parameter only accepts a single value per Google's OAuth spec. With multiple domains, we omit it so users see the full account chooser.
- No migration needed — existing single-domain configs work without changes.
- `env.ts` schema stays as `z.string().optional()` — domain filtering (trim, empty removal) is the responsibility of `parseAllowedGoogleDomains()`, not the schema layer.
- Tenant resolution: each domain in the list produces a separate tenant via `extractTenantClaimValue` (which uses `hd` as tenant identifier). This is the intended behavior — multiple allowed domains means multiple tenants can sign in, not that they share a tenant. Cross-tenant linking is already blocked by `ensureTenantMembershipForSignIn`.
