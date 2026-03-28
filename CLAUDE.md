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
npm run version:bump     # Suggest next version from git log (interactive)
npm run version:bump -- 0.3.0  # Bump to explicit version
```

Admin scripts:
```bash
ADMIN_API_TOKEN=<hex64> OPERATOR_ID=<uuid> scripts/purge-history.sh                    # System-wide history purge
ADMIN_API_TOKEN=<hex64> OPERATOR_ID=<uuid> TARGET_VERSION=<int> scripts/rotate-master-key.sh  # Rotate ShareLink master key
```

Docker (dev): `docker compose -f docker-compose.yml -f docker-compose.override.yml up`

## Code Quality Rules

- **No ad-hoc fixes**: Always use the proper component, import, or pattern. Never substitute with a quick workaround (e.g., replacing `<Card>` with `<div>` to avoid adding an import).
- **No cutting corners**: Every change must be complete and correct. If a component needs an import, add the import. If a fix needs to be applied to multiple files, apply it to all of them.
- **Build verification is mandatory**: Run `npx next build` after every change. A TypeScript or build error means the fix is incomplete — do not commit broken code.

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
- Protected routes (proxy middleware session check): `/dashboard/*`, `/api/passwords/*`, `/api/tags/*`, `/api/api-keys/*`, `/api/travel-mode/*`, `/api/directory-sync/*`, `/api/webauthn/*`, `/api/teams/*`, `/api/tenant/*`, `/api/sessions/*`, `/api/notifications/*`, `/api/audit-logs/*`, `/api/emergency-access/*`, `/api/share-links/*`, `/api/sends/*`, `/api/watchtower/*`, `/api/extension/*`, `/api/user/*`
- Route-handler auth (not middleware): `/api/vault/*`, `/api/folders/*`, `/api/admin/*`, `/api/maintenance/*`, `/api/scim/*`
- API key auth (no session): `/api/v1/*`
- Session cookie: `authjs.session-token` (dev) or `__Secure-authjs.session-token` (prod)
- Service Account tokens: `sa_` prefix Bearer tokens, validated in `authOrToken()` alongside existing `api_`/extension tokens
- MCP tokens: `mcp_` prefix, validated by dedicated `validateMcpToken()` in MCP route handlers
- JIT Access: SA self-service via `access-request:create` scope → admin approval → short-lived token

### Machine Identity (AI Agent Identity)

- Service accounts as first-class non-human identities with `sa_` prefix tokens
- MCP Gateway at `/api/mcp` — Streamable HTTP transport for AI tool integration
- OAuth 2.1 Authorization Code + PKCE for MCP client authentication
- Cross-actor audit: `actorType` enum (HUMAN/SERVICE_ACCOUNT/MCP_AGENT/SYSTEM) on all audit log entries
- E2E encryption preserved: MCP tools return encrypted data only (Phase 3)
- Delegated Decryption planned for Phase 5 (browser-side decrypt → MCP relay)

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

#### Auth & Passkey

| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/auth/[...nextauth]` | GET, POST | Auth.js handlers |
| `/api/auth/passkey/options` | POST | Passkey discoverable auth options |
| `/api/auth/passkey/options/email` | POST | Email-based passkey auth options (non-discoverable) |
| `/api/auth/passkey/verify` | POST | Passkey authentication verify + session creation |

#### Vault

| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/vault/setup` | POST | Initial master passphrase setup |
| `/api/vault/unlock` | POST | Verify passphrase, return encrypted key |
| `/api/vault/unlock/data` | POST | Return encrypted key data |
| `/api/vault/status` | GET | Check vault initialization status |
| `/api/vault/change-passphrase` | POST | Change master passphrase |
| `/api/vault/rotate-key` | POST | Rotate encryption key |
| `/api/vault/rotate-key/data` | GET | Bulk fetch entries for key rotation |
| `/api/vault/admin-reset` | POST | Tenant admin vault reset |
| `/api/vault/recovery-key/generate` | POST | Save recovery key encrypted data |
| `/api/vault/recovery-key/recover` | POST | Recover vault with recovery key (2-step: verify/reset) |
| `/api/vault/reset` | POST | Full vault deletion (last resort) |

#### Passwords & Entries

| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/passwords` | GET, POST | List/create password entries |
| `/api/passwords/[id]` | GET, PUT, DELETE | CRUD single entry |
| `/api/passwords/[id]/restore` | POST | Restore from trash |
| `/api/passwords/[id]/attachments` | GET, POST | List/upload attachments |
| `/api/passwords/[id]/attachments/[attachmentId]` | GET, DELETE | Download/delete attachment |
| `/api/passwords/[id]/history` | GET | Entry version history |
| `/api/passwords/[id]/history/[historyId]` | GET | Single history record |
| `/api/passwords/[id]/history/[historyId]/restore` | POST | Restore from history |
| `/api/passwords/generate` | POST | Server-side secure password generation |
| `/api/passwords/bulk-archive` | POST | Bulk archive entries |
| `/api/passwords/bulk-restore` | POST | Bulk restore entries |
| `/api/passwords/bulk-trash` | POST | Bulk soft-delete entries |
| `/api/passwords/bulk-import` | POST | Bulk import entries |
| `/api/passwords/empty-trash` | POST | Permanently delete all trashed entries |

#### Tags & Folders

| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/tags` | GET, POST | List/create tags |
| `/api/tags/[id]` | PUT, DELETE | Update/delete tag |
| `/api/folders` | GET, POST | List/create folders |
| `/api/folders/[id]` | PUT, DELETE | Update/delete folder |

#### Share Links & Sends

| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/share-links` | GET, POST | List/create share links |
| `/api/share-links/[id]` | GET, DELETE | Get/revoke share link |
| `/api/share-links/[id]/content` | GET | Get shared content |
| `/api/share-links/[id]/access-logs` | GET | Share link access logs |
| `/api/share-links/mine` | GET | List own share links |
| `/api/share-links/verify-access` | POST | Verify share link access |
| `/api/sends` | POST | Create text send (list via `/api/share-links/mine?shareType=send`) |
| `/api/sends/file` | POST | Create file send |

#### Emergency Access

| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/emergency-access` | GET, POST | List/create emergency access grants |
| `/api/emergency-access/[id]/accept` | POST | Accept grant invitation |
| `/api/emergency-access/[id]/approve` | POST | Approve access request |
| `/api/emergency-access/[id]/confirm` | POST | Confirm key exchange |
| `/api/emergency-access/[id]/decline` | POST | Decline access request |
| `/api/emergency-access/[id]/request` | POST | Request emergency access |
| `/api/emergency-access/[id]/revoke` | POST | Revoke grant |
| `/api/emergency-access/[id]/vault` | GET | Access grantor's vault |
| `/api/emergency-access/[id]/vault/entries` | GET | List grantor's vault entries |
| `/api/emergency-access/accept` | POST | Accept by token |
| `/api/emergency-access/pending-confirmations` | GET | List pending key confirmations |
| `/api/emergency-access/reject` | POST | Reject by token |

#### Teams

| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/teams` | GET, POST | List/create teams |
| `/api/teams/[teamId]` | GET, PUT, DELETE | CRUD single team |
| `/api/teams/[teamId]/members` | GET, POST | List/add team members |
| `/api/teams/[teamId]/members/search` | GET | Search users for invitation |
| `/api/teams/[teamId]/members/[memberId]` | PUT, DELETE | Update role/remove member |
| `/api/teams/[teamId]/members/[memberId]/confirm-key` | POST | Confirm member key distribution |
| `/api/teams/[teamId]/member-key` | GET, POST | Get/submit member encryption key |
| `/api/teams/[teamId]/rotate-key` | POST | Rotate team encryption key |
| `/api/teams/[teamId]/rotate-key/data` | GET | Bulk fetch entries for team key rotation |
| `/api/teams/[teamId]/invitations` | GET, POST | List/create team invitations |
| `/api/teams/[teamId]/invitations/[invId]` | DELETE | Cancel invitation |
| `/api/teams/[teamId]/policy` | GET, PUT | Team security policy |
| `/api/teams/[teamId]/passwords` | GET, POST | List/create team password entries |
| `/api/teams/[teamId]/passwords/[id]` | GET, PUT, DELETE | CRUD single team entry |
| `/api/teams/[teamId]/passwords/[id]/restore` | POST | Restore team entry from trash |
| `/api/teams/[teamId]/passwords/[id]/favorite` | PUT, DELETE | Toggle team entry favorite |
| `/api/teams/[teamId]/passwords/[id]/attachments` | GET, POST | Team entry attachments |
| `/api/teams/[teamId]/passwords/[id]/attachments/[attachmentId]` | GET, DELETE | Team attachment download/delete |
| `/api/teams/[teamId]/passwords/[id]/history` | GET | Team entry version history |
| `/api/teams/[teamId]/passwords/[id]/history/[historyId]` | GET | Team history record |
| `/api/teams/[teamId]/passwords/[id]/history/[historyId]/restore` | POST | Restore team entry from history |
| `/api/teams/[teamId]/passwords/bulk-archive` | POST | Bulk archive team entries |
| `/api/teams/[teamId]/passwords/bulk-restore` | POST | Bulk restore team entries |
| `/api/teams/[teamId]/passwords/bulk-trash` | POST | Bulk soft-delete team entries |
| `/api/teams/[teamId]/passwords/bulk-import` | POST | Bulk import team entries |
| `/api/teams/[teamId]/passwords/empty-trash` | POST | Empty team trash |
| `/api/teams/[teamId]/tags` | GET, POST | Team tags |
| `/api/teams/[teamId]/tags/[id]` | PUT, DELETE | Update/delete team tag |
| `/api/teams/[teamId]/folders` | GET, POST | Team folders |
| `/api/teams/[teamId]/folders/[id]` | PUT, DELETE | Update/delete team folder |
| `/api/teams/[teamId]/audit-logs` | GET | Team audit logs |
| `/api/teams/[teamId]/audit-logs/download` | GET | Download team audit logs |
| `/api/teams/[teamId]/webhooks` | GET, POST | Team webhooks |
| `/api/teams/[teamId]/webhooks/[webhookId]` | PUT, DELETE | Update/delete team webhook |
| `/api/teams/invitations/accept` | POST | Accept team invitation |
| `/api/teams/pending-key-distributions` | GET | Pending key distributions |

#### Tenant Admin

| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/tenant/members` | GET | List tenant members |
| `/api/tenant/members/[userId]` | GET, PUT, DELETE | Manage tenant member |
| `/api/tenant/members/[userId]/reset-vault` | POST | Admin vault reset |
| `/api/tenant/members/[userId]/reset-vault/[resetId]/revoke` | POST | Revoke vault reset |
| `/api/tenant/role` | GET | Get current user's tenant role |
| `/api/tenant/policy` | GET, PUT | Tenant security policy |
| `/api/tenant/scim-tokens` | GET, POST | SCIM token management |
| `/api/tenant/scim-tokens/[tokenId]` | DELETE | Delete SCIM token |
| `/api/tenant/audit-logs` | GET | Tenant audit logs |
| `/api/tenant/audit-logs/download` | GET | Download tenant audit logs |
| `/api/tenant/breakglass` | GET, POST | Break Glass grant management |
| `/api/tenant/breakglass/[id]` | DELETE | Revoke Break Glass grant |
| `/api/tenant/breakglass/[id]/logs` | GET | Break Glass personal logs |
| `/api/tenant/webhooks` | GET, POST | Tenant webhooks |
| `/api/tenant/webhooks/[webhookId]` | PUT, DELETE | Update/delete tenant webhook |

#### Sessions & Notifications

| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/sessions` | GET | List active sessions |
| `/api/sessions/[id]` | DELETE | Revoke session |
| `/api/notifications` | GET | List notifications |
| `/api/notifications/[id]` | DELETE | Dismiss notification |
| `/api/notifications/count` | GET | Unread notification count |

#### Audit Logs (Personal)

| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/audit-logs` | GET | List personal audit logs |
| `/api/audit-logs/download` | GET | Download audit logs (CSV/JSONL) |
| `/api/audit-logs/export` | POST | Export audit log data |
| `/api/audit-logs/import` | POST | Import audit log data |

#### Watchtower (Security Audit)

| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/watchtower/start` | POST | Start security scan |
| `/api/watchtower/hibp` | POST | Check password against HIBP |
| `/api/watchtower/alert` | GET, POST | Manage security alerts |

#### WebAuthn

| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/webauthn/register/options` | POST | WebAuthn registration options |
| `/api/webauthn/register/verify` | POST | WebAuthn registration verify |
| `/api/webauthn/authenticate/options` | POST | WebAuthn auth options |
| `/api/webauthn/authenticate/verify` | POST | WebAuthn auth verify |
| `/api/webauthn/credentials` | GET | List WebAuthn credentials |
| `/api/webauthn/credentials/[id]` | DELETE | Delete WebAuthn credential |

#### SCIM 2.0

| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/scim/v2/Users` | GET, POST | SCIM user provisioning |
| `/api/scim/v2/Users/[id]` | GET, PUT, PATCH, DELETE | SCIM single user |
| `/api/scim/v2/Groups` | GET, POST | SCIM group provisioning |
| `/api/scim/v2/Groups/[id]` | GET, PUT, PATCH, DELETE | SCIM single group |
| `/api/scim/v2/ServiceProviderConfig` | GET | SCIM service provider config |
| `/api/scim/v2/ResourceTypes` | GET | SCIM resource types |
| `/api/scim/v2/Schemas` | GET | SCIM schemas |

#### Directory Sync

| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/directory-sync` | GET, POST | Directory sync config CRUD |
| `/api/directory-sync/[id]` | GET, PUT, DELETE | Single sync config |
| `/api/directory-sync/[id]/run` | POST | Trigger sync |
| `/api/directory-sync/[id]/logs` | GET | Sync logs |

#### Extension

| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/extension/token` | POST | Issue extension token |
| `/api/extension/token/refresh` | POST | Refresh extension token |

#### Travel Mode

| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/travel-mode` | GET | Travel mode status |
| `/api/travel-mode/enable` | POST | Enable travel mode |
| `/api/travel-mode/disable` | POST | Disable travel mode |

#### API Keys & REST API v1

| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/api-keys` | GET, POST | API key management |
| `/api/api-keys/[id]` | DELETE | Delete API key |
| `/api/v1/passwords` | GET, POST | REST API v1 password CRUD |
| `/api/v1/passwords/[id]` | GET, PUT, DELETE | REST API v1 single entry |
| `/api/v1/tags` | GET | REST API v1 tag list |
| `/api/v1/vault/status` | GET | REST API v1 vault status |
| `/api/v1/openapi.json` | GET | OpenAPI 3.1 spec |

#### Service Accounts & Machine Identity

| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/tenant/service-accounts` | GET, POST | List/create service accounts |
| `/api/tenant/service-accounts/[id]` | GET, PUT, DELETE | CRUD single SA (DELETE = hard delete) |
| `/api/tenant/service-accounts/[id]/tokens` | GET, POST | List/create SA tokens |
| `/api/tenant/service-accounts/[id]/tokens/[tokenId]` | DELETE | Revoke SA token |
| `/api/tenant/access-requests` | GET, POST | List/create JIT access requests (SA self-service via `sa_` token or admin via session) |
| `/api/tenant/access-requests/[id]` | GET | Access request detail |
| `/api/tenant/access-requests/[id]/approve` | POST | Approve + issue JIT token |
| `/api/tenant/access-requests/[id]/deny` | POST | Deny request |
| `/api/tenant/mcp-clients` | GET, POST | List/create MCP clients |
| `/api/tenant/mcp-clients/[id]` | GET, PUT, DELETE | CRUD single MCP client |
| `/api/mcp` | POST, GET | MCP Streamable HTTP (JSON-RPC) + SSE |
| `/api/mcp/authorize` | GET | OAuth 2.1 authorization (PKCE) |
| `/api/mcp/token` | POST | OAuth 2.1 token exchange |
| `/api/mcp/.well-known/oauth-authorization-server` | GET | OAuth discovery metadata |

#### Health & Infrastructure

| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/health/live` | GET | Liveness probe (always 200) |
| `/api/health/ready` | GET | Readiness probe (DB + Redis, 503 if unhealthy) |
| `/api/csp-report` | POST | CSP violation report endpoint |
| `/api/user/locale` | PUT | Update user locale preference |
| `/api/admin/rotate-master-key` | POST | Rotate server master key (admin-only, bearer token) |
| `/api/maintenance/purge-history` | POST | System-wide history purge (admin-only, bearer token) |

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

Five containers: `app` (Next.js), `db` (PostgreSQL 16), `jackson` (BoxyHQ SAML Jackson), `redis` (Redis 7), `migrate` (one-shot Prisma migration)

Dev override adds: `mailpit` (local email testing on port 8025)

## Versioning

### Rules (SemVer)

Tags use `vX.Y.Z` format. Root `package.json` is the single source of truth — CLI and extension read from it automatically.

| Bump | When | Example |
|------|------|---------|
| **Major** (`X`) | Breaking API/schema change, auth flow change, encryption format change | `0.2.1` → `1.0.0` |
| **Minor** (`Y`) | New feature, new API endpoint, new UI page | `0.2.1` → `0.3.0` |
| **Patch** (`Z`) | Bug fix, refactor, dependency update, docs, chore | `0.2.1` → `0.2.2` |

While `0.x.y` (pre-1.0), Minor bumps may include breaking changes.

### Commit Prefix → Bump Mapping

| Prefix | Bump | Notes |
|--------|------|-------|
| `feat:` | Minor | New functionality |
| `fix:` | Patch | Bug fix |
| `refactor:` | Patch | No behavior change |
| `perf:` | Patch | Performance improvement |
| `chore:` | Patch | Tooling, deps, config |
| `docs:` | Patch | Documentation only |
| `feat!:` / `BREAKING CHANGE` | Major | Breaking change (any prefix with `!`) |

The highest bump wins when multiple commits are included in a release.

### Release Process (release-please)

Automated via [release-please](https://github.com/googleapis/release-please). Feature branches do NOT change version numbers.

```
feature PR → merge to main → release-please auto-updates Release PR
                            → merge Release PR → tag + GitHub Release created automatically
```

How it works:
1. Every push to main, release-please analyzes new conventional commits
2. It creates/updates a "Release PR" with version bump + CHANGELOG
3. The Release PR updates `package.json`, `cli/package.json`, `extension/package.json` automatically
4. When you merge the Release PR, a GitHub Release + git tag is created
Config files: `release-please-config.json`, `.release-please-manifest.json`

### Manual Fallback

If release-please is unavailable, use `scripts/bump-version.sh`:

```bash
npm run version:bump           # Interactive — suggests version from git log
npm run version:bump -- 0.3.0  # Explicit version
```

### Version Locations

| Location | How it gets the version |
|----------|------------------------|
| `package.json` | Single source of truth (SSOT) |
| `cli/package.json` | Synced by `bump-version.sh` |
| `extension/package.json` | Synced by `bump-version.sh` |
| `cli/src/index.ts` | Reads root `package.json` at runtime via `createRequire` |
| `extension/manifest.config.ts` | Imports root `package.json` at build time |
| `src/lib/openapi-spec.ts` | Independent API version (`1.0.0`) — not synced |

CI `version-check` job validates consistency on every PR.
