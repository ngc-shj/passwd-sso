# passwd-sso

[日本語](README.ja.md)

A self-hosted password manager with SSO authentication, end-to-end encryption, and a modern web UI.

## Features

- **SSO Authentication** - Google OIDC + SAML 2.0 (via [BoxyHQ SAML Jackson](https://github.com/boxyhq/jackson))
- **End-to-End Encryption** - AES-256-GCM; the server never sees plaintext passwords
- **Master Passphrase** - PBKDF2 (600k iterations) or Argon2id (64 MB) + HKDF key derivation with Secret Key
- **Multiple Entry Types** - Passwords, secure notes, credit cards, identity/personal info, passkeys, bank accounts, software licenses, and SSH keys
- **Custom Field Types** - TEXT, HIDDEN, URL, BOOLEAN, DATE, and MONTH_YEAR
- **Password Generator** - Random passwords (8-128 chars) and diceware passphrases (3-10 words)
- **TOTP Authenticator** - Store and generate 2FA codes (otpauth:// URI support)
- **Security Audit (Watchtower)** - Breached (HIBP), weak, reused, old, and HTTP-URL detection with security score; continuous dark-web monitoring with email alerts
- **Import / Export** - Bitwarden, 1Password, Chrome CSV import; CSV/JSON export profiles: compatible and passwd-sso (full-fidelity)
- **Password-Protected Export** - AES-256-GCM encrypted exports with PBKDF2 (600k)
- **Attachments** - Encrypted file attachments (personal and team E2E)
- **Share Links & Permissions** - Time-limited sharing with access logs and visibility controls (`view all`, `hide password`, `overview only`)
- **Audit Logs & Webhooks** - Personal and team audit logs with filters, CSV/JSONL download, and team webhook delivery
- **Emergency Access** - Request/approve temporary vault access with key exchange
- **Session Management** - List active sessions and revoke single/all sessions; automatic invalidation on team member removal
- **Notifications** - In-app and email notifications for emergency-access events and new-device logins
- **Key Rotation** - Rotate vault encryption key with passphrase verification
- **Secure Notes** - Prebuilt templates and safe Markdown preview/rendering
- **Tags & Team** - Nested color-coded tags, favorites, archive, soft-delete trash (30-day auto-purge)
- **Team Security Policies** - Team-level sharing/export controls, reprompt requirements, and password-policy guidance
- **Keyboard Shortcuts** - `/ or Cmd+K` search, `n` new, `?` help, `Esc` clear
- **Locale Persistence** - User locale preference saved to database and used for emails/notifications
- **i18n** - English and Japanese (next-intl)
- **Dark Mode** - Light / dark / system (next-themes)
- **Team Vault** - Team password sharing with E2E encryption (ECDH-P256) and RBAC (Owner/Admin/Member/Viewer)
- **Recovery Key** - 256-bit recovery key (HKDF + AES-256-GCM) with Base32 encoding and checksum; recover vault access without passphrase
- **Vault Reset** - Last-resort full vault deletion with explicit confirmation ("DELETE MY VAULT")
- **Account Lockout** - Progressive lockout (5→15min, 10→1h, 15→24h) with audit logging
- **Rate Limiting** - Redis-backed vault unlock rate limiting
- **CSP & Security Headers** - Content Security Policy with nonce, CSP violation reporting, OWASP recommended headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy)
- **SCIM 2.0 Provisioning** - Tenant-scoped user/group sync (RFC 7644) with Bearer token auth
- **Multi-Tenant Isolation** - PostgreSQL FORCE ROW LEVEL SECURITY on 33 tables with IdP claim-based tenant resolution
- **Self-Hosted** - Docker Compose with PostgreSQL, SAML Jackson, and Redis
- **Tenant Admin** - Member management with search, SCIM token management, admin vault reset, and tenant-level settings
- **SSH Agent** - CLI `passwd-sso agent` proxies SSH keys from the vault to `ssh`, `git`, and other tools via the SSH agent protocol
- **CI/CD Secrets** - CLI `env` and `run` commands inject vault secrets into environment variables or subprocess commands
- **API Keys** - Scoped REST API keys with SHA-256 hashed tokens and configurable expiration
- **REST API v1** - Public API (`/api/v1/*`) for passwords, tags, and vault status with OpenAPI 3.1 spec
- **TOTP QR Capture** - Camera-based QR code scanning for TOTP secret setup (MediaDevices + ImageCapture)
- **Travel Mode** - Hide sensitive entries when crossing borders; remote disable restores access
- **Directory Sync** - Sync organization members from Azure AD, Google Workspace, or Okta; encrypted credentials with server master key
- **Passkey Sign-In** - Passwordless sign-in with discoverable FIDO2 credentials (WebAuthn); PRF-capable keys auto-unlock vault
- **Email + Security Key Sign-In** - Non-discoverable credential support via email lookup with timing-oracle mitigation
- **Magic Link Sign-In** - Email-based passwordless authentication with locale-aware templates
- **Passkey Vault Unlock** - Unlock vault with a FIDO2 passkey (WebAuthn PRF) instead of master passphrase
- **CLI Tool** - Node.js CLI (`passwd-sso`) with 13 commands: login, unlock, status, list, get, generate, totp, export, env, run, agent, api-key, ssh-key; OS keychain integration and XDG-compliant config
- **Browser Extension (Chrome/Edge, MV3)** - Manual autofill, inline suggestions, AWS 3-field fill, CC/address autofill, context menu, keyboard shortcuts, new-login detect & save
- **Error Tracking** - Sentry integration with recursive sensitive data scrubbing (no plaintext secrets leave the client)
- **CI Security Scanning** - CodeQL SAST, Trivy container scanning, crypto domain ledger verification, npm audit blocking

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript 5.9 |
| Database | PostgreSQL 16 |
| ORM | Prisma 7 (driver adapter with pg) |
| Auth | Auth.js v5 (database sessions) |
| SAML Bridge | BoxyHQ SAML Jackson (Docker) |
| UI | Tailwind CSS 4 + shadcn/ui + Radix UI |
| Encryption | Web Crypto API (vault E2E) + AES-256-GCM (server-side for share links/sends) |
| Cache / Rate Limit | Redis 7 |

## Architecture

```
Browser (Web Crypto API)
  │  ← Personal & team vault: AES-256-GCM E2E encrypt/decrypt
  ▼
Next.js App (SSR / API Routes)
  │  ← Auth.js sessions, route protection, RBAC
  │  ← Share links / sends: server-side AES-256-GCM encryption
  ▼
PostgreSQL ← Prisma 7          Redis ← rate limiting
  │
  ▼
SAML Jackson (Docker) ← SAML 2.0 IdP (HENNGE, Okta, Azure AD, etc.)
```

**Personal vault** — All password data is encrypted **client-side** before being sent to the server. The server stores only ciphertext. Decryption happens exclusively in the browser using a key derived from the user's master passphrase.

**Team vault** — Shared passwords are encrypted **end-to-end (client-side)**. Team key distribution uses ECDH-P256 member-key exchange.

## Getting Started

### Prerequisites

- Node.js 20+
- Docker & Docker Compose
- Google Cloud project (for OIDC) and/or a SAML IdP

### 1. Clone and install

```bash
git clone https://github.com/ngc-shj/passwd-sso.git
cd passwd-sso
npm install
```

### 2. Configure environment

```bash
cp .env.example .env.local
```

Edit `.env.local` and fill in:

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_BASE_PATH` | (Optional) Sub-path for reverse proxy deployment (e.g., `/passwd-sso`). Build-time variable — set before `npm run build` |
| `DATABASE_URL` | PostgreSQL connection string |
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `AUTH_GOOGLE_ID` | Google OAuth client ID |
| `AUTH_GOOGLE_SECRET` | Google OAuth client secret |
| `GOOGLE_WORKSPACE_DOMAIN` | (Optional) Restrict to a Google Workspace domain |
| `AUTH_TENANT_CLAIM_KEYS` | (Optional) Comma-separated IdP claim keys used to resolve tenant (e.g. `tenant_id,organization`) |
| `JACKSON_URL` | SAML Jackson URL (default: `http://localhost:5225`) |
| `AUTH_JACKSON_ID` | Jackson OIDC client ID |
| `AUTH_JACKSON_SECRET` | Jackson OIDC client secret |
| `SAML_PROVIDER_NAME` | Display name on sign-in page (e.g., "HENNGE") |
| `SHARE_MASTER_KEY` | Master key for server-encrypted share links/sends — `openssl rand -hex 32` |
| `VERIFIER_PEPPER_KEY` | Passphrase verifier pepper key — `openssl rand -hex 32` (**required in production**) |
| `REDIS_URL` | Redis URL for rate limiting (required in production) |
| `BLOB_BACKEND` | Attachment blob backend (`db` / `s3` / `azure` / `gcs`) |
| `AWS_REGION`, `S3_ATTACHMENTS_BUCKET` | Required when `BLOB_BACKEND=s3` |
| `AZURE_STORAGE_ACCOUNT`, `AZURE_BLOB_CONTAINER` | Required when `BLOB_BACKEND=azure` |
| `AZURE_STORAGE_CONNECTION_STRING` or `AZURE_STORAGE_SAS_TOKEN` | One of them is required when `BLOB_BACKEND=azure` |
| `GCS_ATTACHMENTS_BUCKET` | Required when `BLOB_BACKEND=gcs` |
| `BLOB_OBJECT_PREFIX` | Optional key prefix for cloud object paths |

> **Redis is required in production.** In development/test, you can omit `REDIS_URL` to use an in-memory fallback for rate limiting.

### 3. Start services

**Development** (PostgreSQL + SAML Jackson + Next.js dev server):

```bash
# Start all services (with Redis for rate limiting)
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d db jackson redis

# Or without Redis (single-instance / minimal setup)
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d db jackson

# Run database migrations
npm run db:migrate

# Start the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) (or `http://localhost:3000/<basePath>` if `NEXT_PUBLIC_BASE_PATH` is set).

**Production** (all-in-one Docker Compose):

```bash
docker compose up -d
```

### 4. First-time setup

1. Sign in with Google or SAML SSO
2. Set up your master passphrase (used to derive the encryption key)
3. Start adding passwords

## Browser Extension (Chrome/Edge)

This repository includes an MV3 extension in `extension/`.

### Build

```bash
cd extension
npm install
npm run build
```

### Load (Unpacked)

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `extension/dist`

### Basic Flow

1. Open the extension popup
2. Set `serverUrl` in extension settings if needed
3. Connect/sign in to your passwd-sso instance
4. Unlock vault, then use manual fill / inline suggestions
5. Use **Disconnect** in popup to revoke extension token (`DELETE /api/extension/token`) when needed

## Import Samples

- passwd-sso JSON sample: [`docs/assets/passwd-sso.json`](docs/assets/passwd-sso.json)
- passwd-sso CSV sample: [`docs/assets/passwd-sso.csv`](docs/assets/passwd-sso.csv)

## Screenshots

### Dashboard

![passwd-sso dashboard](docs/assets/passwd-sso-dashboard.png)

### Entry Detail (AWS 3-field example)

![passwd-sso entry detail](docs/assets/passwd-sso-entry-detail.png)

### Password Generator

![passwd-sso password generator](docs/assets/passwd-sso-password-generator.png)

### Extension Screenshots (AWS IAM 3-field fill)

![passwd-sso extension aws fill 1](docs/assets/passwd-sso-extension-aws-fill-1.png)
![passwd-sso extension aws fill 2](docs/assets/passwd-sso-extension-aws-fill-2.png)

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Development server (Turbopack) |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with coverage |
| `npm run test:e2e` | Run Playwright E2E tests |
| `npm run db:migrate` | Prisma migrate (dev) |
| `npm run db:push` | Push schema without migration |
| `npm run db:seed` | Seed data |
| `npm run db:studio` | Prisma Studio GUI |
| `npm run generate:key` | Generate 256-bit hex key |
| `npm run licenses:check` | Check app dependency licenses (non-strict) |
| `npm run licenses:check:strict` | Check app dependency licenses (strict; CI mode) |
| `npm run licenses:check:ext` | Check extension dependency licenses (non-strict) |
| `npm run licenses:check:ext:strict` | Check extension dependency licenses (strict; CI mode) |
| `npm run test:load:smoke` | Run load-test seed smoke checks |
| `npm run test:load:seed` | Seed load-test users/sessions |
| `npm run test:load` | Run k6 mixed-workload baseline scenario |
| `npm run test:load:health` | Run k6 health endpoint scenario |
| `npm run test:load:cleanup` | Cleanup load-test users/sessions |
| `npm run scim:smoke` | Run SCIM API smoke checks without IdP (requires `SCIM_TOKEN`) |

Lifecycle scripts (not listed under `available via npm run`):
- `npm test` - Run tests once (`vitest run`)
- `npm start` - Start production server (`next start`)

## Project Structure

```
src/
├── app/[locale]/
│   ├── page.tsx              # Landing / Sign-in
│   ├── dashboard/            # Personal vault, team vault, watchtower, etc.
│   └── auth/                 # Auth pages
├── app/api/
│   ├── auth/                 # Auth.js handlers
│   ├── passwords/            # Password CRUD + generation
│   ├── tags/                 # Tag CRUD
│   ├── vault/                # Setup, unlock, status, key rotation, recovery key, reset
│   ├── teams/                # Team management API
│   ├── share-links/          # Share link CRUD + access
│   ├── audit-logs/           # Audit log queries + download
│   ├── notifications/        # In-app notification center
│   ├── user/                 # User preferences (locale)
│   ├── emergency-access/     # Emergency access workflows
│   ├── watchtower/           # Security audit (HIBP, analysis)
│   ├── health/               # Health check (liveness + readiness)
│   ├── scim/v2/              # SCIM 2.0 provisioning (Users / Groups)
│   ├── api-keys/             # API key management
│   ├── v1/                   # REST API v1 (passwords, tags, vault status, OpenAPI)
│   ├── travel-mode/          # Travel mode enable/disable/status
│   ├── directory-sync/       # Directory sync config CRUD + run + logs
│   ├── webauthn/             # WebAuthn register/authenticate/credentials
│   └── csp-report/           # CSP violation reporting
├── components/
│   ├── layout/               # Header, Sidebar, SearchBar
│   ├── passwords/            # PasswordList, PasswordForm, Generator, entry type forms, QR capture
│   ├── settings/             # API key manager, directory sync, passkey credentials, travel mode
│   ├── team/                 # Team vault UI (list, form, settings, invitations, policies)
│   ├── notifications/        # Notification bell and dropdown
│   ├── emergency-access/     # Emergency access UI
│   ├── share/                # Share link UI
│   ├── watchtower/           # Security audit dashboard
│   ├── vault/                # Vault lock/unlock UI, recovery key dialog/banner
│   ├── tags/                 # TagInput, TagBadge
│   ├── providers/            # Client-side providers (theme, session, etc.)
│   ├── auth/                 # SignOutButton, PasskeySignInButton, SecurityKeySignInForm, EmailSignInForm
│   └── ui/                   # shadcn/ui components
├── lib/
│   ├── crypto-client.ts      # Client-side E2E encryption (personal vault)
│   ├── crypto-recovery.ts    # Recovery Key crypto (HKDF + AES-256-GCM wrap)
│   ├── crypto-server.ts      # Server-side crypto for share links/sends + verifier HMAC
│   ├── crypto-aad.ts         # Additional Authenticated Data for encryption
│   ├── crypto-team.ts        # Team E2E cryptography (ECDH-P256 key exchange)
│   ├── crypto-emergency.ts   # Emergency access key exchange
│   ├── export-crypto.ts      # Password-protected export encryption
│   ├── team-auth.ts          # Team RBAC authorization helpers
│   ├── audit.ts              # Audit log helpers
│   ├── vault-context.tsx     # Vault lock/unlock state + passkey unlock
│   ├── api-key.ts            # API key validation and scope parsing
│   ├── travel-mode.ts        # Travel mode filtering logic
│   ├── webauthn-server.ts    # WebAuthn server (registration/authentication, PRF salt)
│   ├── webauthn-client.ts    # WebAuthn browser client (credential create/get)
│   ├── ssh-key.ts            # SSH key validation and fingerprint generation
│   ├── openapi-spec.ts       # OpenAPI 3.1 specification
│   ├── directory-sync/       # Azure AD, Google Workspace, Okta sync providers
│   ├── password-generator.ts # Server-side secure generation
│   ├── password-analyzer.ts  # Password strength analysis
│   ├── credit-card.ts        # Credit card validation & formatting
│   ├── rate-limit.ts         # Rate limiting logic
│   ├── health.ts             # Health check logic (DB, Redis, timeout)
│   ├── api-error-codes.ts    # Centralized API error codes & i18n mapping
│   ├── prisma.ts             # Prisma singleton
│   ├── redis.ts              # Redis client (rate limiting)
│   └── validations.ts        # Zod schemas
└── i18n/                     # next-intl routing
extension/
├── src/background/           # Service Worker (token, unlock, autofill orchestration)
├── src/content/              # Form detection and in-page fill logic
├── src/popup/                # Extension popup UI
└── manifest.config.ts        # MV3 manifest definition
cli/
├── src/commands/             # CLI commands (login, unlock, status, list, get, generate, totp, export, env, run, agent, api-key, ssh-key)
└── src/lib/                  # Keychain, config, API client, SSH agent protocol, OpenSSH key parser
```

## Security Model

- **Zero-knowledge** - The server stores only AES-256-GCM ciphertext; it cannot decrypt user data
- **Key derivation** - Passphrase -> PBKDF2 (600k) or Argon2id (64 MB) -> wrapping key -> wraps random 256-bit secret key
- **Domain separation** - Secret key -> HKDF -> separate encryption key + auth key
- **Secret Key** - Additional account-specific salt for defense against server compromise
- **AAD binding** - Additional Authenticated Data ties ciphertext to user and entry IDs
- **Key rotation** - Rotate vault encryption key without re-entering all passwords
- **Session security** - Database sessions (not JWT), 8-hour timeout with 1-hour extension
- **Auto-lock** - Vault locks after 15 min idle or 5 min tab hidden
- **Clipboard clear** - Copied passwords auto-clear after 30 seconds
- **Team vault** - End-to-end encryption (ECDH-P256) with per-member key distribution and per-entry ItemKey hierarchy
- **RBAC** - Owner / Admin / Member / Viewer role-based access control for teams
- **Recovery Key** - 256-bit random → HKDF → AES-256-GCM wrap of secret key; server stores only HMAC(pepper, verifierHash)
- **Vault Reset** - Last-resort full data deletion with fixed confirmation token
- **Account lockout** - Progressive lockout (5→15min, 10→1h, 15→24h) with DB persistence and audit logging
- **Rate limiting** - Redis-backed rate limiting on sensitive endpoints (including vault unlock)
- **CSRF defense** - JSON body + SameSite cookie + CSP + Origin header validation on destructive endpoints
- **CSP** - Content Security Policy with nonce-based script control and violation reporting
- **Tenant admin vault reset** - Tenant owner/admin can reset a member's vault with audit logging
- **Multi-tenant isolation** - PostgreSQL FORCE RLS on 33 tables with CI guard scripts to prevent accidental RLS bypass
- **SCIM 2.0** - Tenant-scoped Bearer tokens, Users/Groups endpoints (RFC 7644)
- **Passkey sign-in** - Discoverable and non-discoverable WebAuthn credential sign-in with user-enumeration mitigation
- **Email + security key sign-in** - Non-discoverable credential support via email lookup with timing-oracle mitigation
- **Magic link sign-in** - Time-limited email tokens with locale-aware templates
- **Passkey vault unlock** - WebAuthn PRF-based vault unlock; passkey derives encryption key without master passphrase
- **API key authentication** - Scoped API keys with SHA-256 hashed tokens and HMAC prefix verification
- **Directory sync credentials** - Provider credentials encrypted with server master key (AES-256-GCM)
- **Travel mode** - Hide entries marked `travelSafe=false`; remote disable with audit logging

## Deployment Guides

- Setup docs policy: `docs/setup/README.md` (English-only)
- [Docker Compose Setup](docs/setup/docker/en.md) (includes sub-path deployment)
- [AWS Deployment](docs/setup/aws/en.md)
- [Vercel Deployment](docs/setup/vercel/en.md)
- [Terraform (AWS) — English](infra/terraform/README.md) / [日本語](infra/terraform/README.ja.md)
- [Deployment Operations](docs/operations/deployment.md)

## Security Documentation

- [Security Policy](SECURITY.md)
- [Cryptography Whitepaper](docs/security/cryptography-whitepaper.md) — full key hierarchy and crypto design
- [Threat Model (STRIDE)](docs/security/threat-model.md) — systematic threat analysis
- [Security Considerations (English)](docs/security/considerations/en.md) / [日本語](docs/security/considerations/ja.md)

## License

MIT
