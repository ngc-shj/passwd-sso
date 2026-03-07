# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Commands

```bash
npm run dev              # Dev server with Turbopack
npm run build            # Production build
npm run lint             # ESLint (next/core-web-vitals + next/typescript)
npm run db:migrate       # Prisma migrate dev (reads .env.local via prisma.config.ts)
npm run db:push          # Push schema without migration
npm run db:seed          # Seed data (tsx prisma/seed.ts)
npm run db:studio        # Prisma Studio GUI
npm run generate:key     # Generate 256-bit hex master key
```

Docker (dev): `docker compose -f docker-compose.yml -f docker-compose.override.yml up`

## Mandatory Checks

Before committing or reporting implementation complete, **always** run:

1. `npx vitest run` — all tests must pass
2. `npx next build` — production build must succeed (catches TypeScript errors, Turbopack module resolution, SSR bundling issues that `vitest` does not cover)

These are non-negotiable. A passing test suite alone is insufficient — the build can fail due to SSR-only issues (e.g., browser-only WASM modules bundled for server, type mismatches in non-test code).

## Architecture

**Stack:** Next.js 16 (App Router) + TypeScript 5.9 + Prisma 7 + PostgreSQL 16 + Auth.js v5 + Tailwind CSS 4 + shadcn/ui

### Authentication Flow

- Auth.js v5 (beta.30) with database session strategy (not JWT)
- Providers: Google OIDC + SAML 2.0 via BoxyHQ SAML Jackson (Docker container, NOT npm) + Passkey (WebAuthn) + Magic Link (email)
- Jackson exposes an OIDC interface; Auth.js connects as a standard OIDC provider
- Passkey sign-in: discoverable (passwordless) + email-based (non-discoverable security keys)
- PRF extension support for vault auto-unlock after passkey sign-in
- Route protection: `proxy.ts` (root, entry point + CSP) → `src/proxy.ts` (Next.js 16 proxy pattern)
- Protected routes: `/dashboard/*`, `/api/passwords/*`, `/api/tags/*`, `/api/api-keys/*`, `/api/v1/*`, `/api/travel-mode/*`, `/api/directory-sync/*`, `/api/webauthn/*`
- Session cookie: `authjs.session-token` (dev) or `__Secure-authjs.session-token` (prod)

### E2E Encryption Architecture

All password data is encrypted **client-side** before reaching the server. The server never sees plaintext passwords.

- **Key derivation:** Master passphrase → PBKDF2 (600k iterations) → wrapping key → wraps a random 256-bit secret key
- **Domain separation:** Secret key → HKDF → encryption key (AES-256-GCM) + auth key (verification)
- **Storage:** `PasswordEntry` stores two encrypted blobs:
  - `encryptedBlob` — full entry data (title, username, password, url, notes, tags, generatorSettings)
  - `encryptedOverview` — summary for list view (title, username, urlHost, tags)
  - Both have separate IV (12 bytes) and authTag (16 bytes), stored as hex strings
- **Vault context:** `src/lib/vault-context.tsx` provides `encryptionKey` to components after unlock
- **Crypto implementation:** `src/lib/crypto-client.ts` (Web Crypto API)

### API Endpoints

| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/auth/[...nextauth]` | GET, POST | Auth.js handlers |
| `/api/vault/setup` | POST | Initial master passphrase setup |
| `/api/vault/unlock` | POST | Verify passphrase, return encrypted key |
| `/api/vault/unlock/data` | POST | Return encrypted key data |
| `/api/vault/status` | GET | Check vault initialization status |
| `/api/vault/recovery-key/generate` | POST | Save recovery key encrypted data |
| `/api/vault/recovery-key/recover` | POST | Recover vault with recovery key (2-step: verify/reset) |
| `/api/vault/reset` | POST | Full vault deletion (last resort) |
| `/api/passwords` | GET, POST | List/create password entries |
| `/api/passwords/[id]` | GET, PUT, DELETE | CRUD single entry |
| `/api/passwords/generate` | POST | Server-side secure password generation |
| `/api/tags` | GET, POST | List/create tags |
| `/api/tags/[id]` | PUT, DELETE | Update/delete tag |
| `/api/health/live` | GET | Liveness probe (always 200) |
| `/api/health/ready` | GET | Readiness probe (DB + Redis, 503 if unhealthy) |
| `/api/api-keys` | GET, POST | API key management |
| `/api/api-keys/[id]` | DELETE | Delete API key |
| `/api/v1/passwords` | GET, POST | REST API v1 password CRUD |
| `/api/v1/passwords/[id]` | GET, PUT, DELETE | REST API v1 single entry |
| `/api/v1/tags` | GET | REST API v1 tag list |
| `/api/v1/vault/status` | GET | REST API v1 vault status |
| `/api/v1/openapi.json` | GET | OpenAPI 3.1 spec |
| `/api/travel-mode` | GET | Travel mode status |
| `/api/travel-mode/enable` | POST | Enable travel mode |
| `/api/travel-mode/disable` | POST | Disable travel mode |
| `/api/directory-sync` | GET, POST | Directory sync config CRUD |
| `/api/directory-sync/[id]` | GET, PUT, DELETE | Single sync config |
| `/api/directory-sync/[id]/run` | POST | Trigger sync |
| `/api/directory-sync/[id]/logs` | GET | Sync logs |
| `/api/webauthn/register/options` | POST | WebAuthn registration options |
| `/api/webauthn/register/verify` | POST | WebAuthn registration verify |
| `/api/webauthn/authenticate/options` | POST | WebAuthn auth options |
| `/api/webauthn/authenticate/verify` | POST | WebAuthn auth verify |
| `/api/webauthn/credentials` | GET | List WebAuthn credentials |
| `/api/webauthn/credentials/[id]` | DELETE | Delete WebAuthn credential |
| `/api/auth/passkey/options` | POST | Passkey discoverable auth options |
| `/api/auth/passkey/options/email` | POST | Email-based passkey auth options (non-discoverable) |
| `/api/auth/passkey/verify` | POST | Passkey authentication verify + session creation |

### i18n

- Framework: next-intl 4 with locale prefix "always" (`/ja/...`, `/en/...`)
- Default locale: `ja`
- Translation files: `messages/en.json`, `messages/ja.json`
- Routing: `src/i18n/routing.ts`, navigation helper: `src/i18n/navigation.ts`
- Use `useTranslations()` in components, import `useRouter` from `@/i18n/navigation`

## Key Patterns

### Prisma 7

- `prisma.config.ts` at project root uses `defineConfig()` — no `url` in `datasource` block of schema.prisma
- Requires `@prisma/adapter-pg` + `pg` (driver adapter pattern)
- dotenv must explicitly load `.env.local`: `config({ path: ".env.local" })`
- Singleton in `src/lib/prisma.ts` with `pg.Pool` adapter

### Next.js 16

- Route handler `params` must be awaited: `const { id } = await params`
- Proxy pattern: `proxy.ts` (root) + `src/proxy.ts` (logic)
- Standalone output for Docker deployment

### Validation

- Zod 4 schemas in `src/lib/validations.ts`
- Password generation: `symbols` is `z.string()` (concatenated symbol characters), not boolean

### Password Generator

- Settings stored per-entry in encrypted blob (not per-user DB column or localStorage)
- Symbol groups defined in `src/lib/generator-prefs.ts` (6 groups with individual toggles)
- Server-side generation uses `node:crypto` randomBytes in `src/lib/password-generator.ts`

### Docker Services

Four containers: `app` (Next.js), `db` (PostgreSQL 16), `jackson` (BoxyHQ SAML Jackson), `redis` (Redis 7)
