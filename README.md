# passwd-sso

[日本語](README.ja.md)

A self-hosted password manager with SSO authentication, end-to-end encryption, and a modern web UI.

## Features

- **SSO Authentication** - Google OIDC + SAML 2.0 (via [BoxyHQ SAML Jackson](https://github.com/boxyhq/jackson))
- **End-to-End Encryption** - AES-256-GCM; the server never sees plaintext passwords
- **Master Passphrase** - PBKDF2 (600k iterations) + HKDF key derivation with Secret Key
- **Multiple Entry Types** - Passwords, secure notes, credit cards, identity/personal info, and passkey records
- **Password Generator** - Random passwords (8-128 chars) and diceware passphrases (3-10 words)
- **TOTP Authenticator** - Store and generate 2FA codes (otpauth:// URI support)
- **Security Audit (Watchtower)** - Breached (HIBP), weak, reused, old, and HTTP-URL detection with security score
- **Import / Export** - Bitwarden, 1Password, Chrome CSV import; CSV and JSON export
- **Password-Protected Export** - AES-256-GCM encrypted exports with PBKDF2 (600k)
- **Attachments** - Encrypted file attachments (personal E2E, org server-side)
- **Share Links** - Time-limited read-only sharing with access logs
- **Audit Logs** - Personal and org audit logs with filters and export events
- **Emergency Access** - Request/approve temporary vault access with key exchange
- **Key Rotation** - Rotate vault encryption key with passphrase verification
- **Tags & Organization** - Color-coded tags, favorites, archive, soft-delete trash (30-day auto-purge)
- **Keyboard Shortcuts** - `/ or Cmd+K` search, `n` new, `?` help, `Esc` clear
- **i18n** - English and Japanese (next-intl)
- **Dark Mode** - Light / dark / system (next-themes)
- **Organization Vault** - Team password sharing with server-side AES-256-GCM encryption and RBAC (Owner/Admin/Member/Viewer)
- **Rate Limiting** - Redis-backed vault unlock rate limiting
- **CSP & Security Headers** - Content Security Policy with nonce, CSP violation reporting
- **Self-Hosted** - Docker Compose with PostgreSQL, SAML Jackson, and Redis

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
| Encryption | Web Crypto API (client-side) + AES-256-GCM (server-side for org vault) |
| Cache / Rate Limit | Redis 7 |

## Architecture

```
Browser (Web Crypto API)
  │  ← Personal vault: AES-256-GCM E2E encrypt/decrypt
  ▼
Next.js App (SSR / API Routes)
  │  ← Auth.js sessions, route protection, RBAC
  │  ← Org vault: server-side AES-256-GCM encrypt/decrypt
  ▼
PostgreSQL ← Prisma 7          Redis ← rate limiting
  │
  ▼
SAML Jackson (Docker) ← SAML 2.0 IdP (HENNGE, Okta, Azure AD, etc.)
```

**Personal vault** — All password data is encrypted **client-side** before being sent to the server. The server stores only ciphertext. Decryption happens exclusively in the browser using a key derived from the user's master passphrase.

**Organization vault** — Shared passwords are encrypted **server-side** with per-org keys (wrapped by `ORG_MASTER_KEY`). This enables instant sharing across team members without requiring individual key exchange.

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
| `DATABASE_URL` | PostgreSQL connection string |
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `AUTH_GOOGLE_ID` | Google OAuth client ID |
| `AUTH_GOOGLE_SECRET` | Google OAuth client secret |
| `GOOGLE_WORKSPACE_DOMAIN` | (Optional) Restrict to a Google Workspace domain |
| `JACKSON_URL` | SAML Jackson URL (default: `http://localhost:5225`) |
| `AUTH_JACKSON_ID` | Jackson OIDC client ID |
| `AUTH_JACKSON_SECRET` | Jackson OIDC client secret |
| `SAML_PROVIDER_NAME` | Display name on sign-in page (e.g., "HENNGE") |
| `ORG_MASTER_KEY` | Org vault master key — `openssl rand -hex 32` |
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

Open [http://localhost:3000](http://localhost:3000).

**Production** (all-in-one Docker Compose):

```bash
docker compose up -d
```

### 4. First-time setup

1. Sign in with Google or SAML SSO
2. Set up your master passphrase (used to derive the encryption key)
3. Start adding passwords

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Development server (Turbopack) |
| `npm run build` | Production build |
| `npm run start` | Start production server |
| `npm run lint` | ESLint |
| `npm test` | Run tests (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with coverage |
| `npm run db:migrate` | Prisma migrate (dev) |
| `npm run db:push` | Push schema without migration |
| `npm run db:seed` | Seed data |
| `npm run db:studio` | Prisma Studio GUI |
| `npm run generate:key` | Generate 256-bit hex key |

## Project Structure

```
src/
├── app/[locale]/
│   ├── page.tsx              # Landing / Sign-in
│   ├── dashboard/            # Personal vault, org vault, watchtower, etc.
│   └── auth/                 # Auth pages
├── app/api/
│   ├── auth/                 # Auth.js handlers
│   ├── passwords/            # Password CRUD + generation
│   ├── tags/                 # Tag CRUD
│   ├── vault/                # Setup, unlock, status, key rotation
│   ├── orgs/                 # Organization management
│   ├── share-links/          # Share link CRUD + access
│   ├── audit-logs/           # Audit log queries
│   ├── emergency-access/     # Emergency access workflows
│   ├── watchtower/           # Security audit (HIBP, analysis)
│   └── csp-report/           # CSP violation reporting
├── components/
│   ├── layout/               # Header, Sidebar, SearchBar
│   ├── passwords/            # PasswordList, PasswordForm, Generator, entry type forms
│   ├── org/                  # Org vault UI (list, form, settings, invitations)
│   ├── emergency-access/     # Emergency access UI
│   ├── share/                # Share link UI
│   ├── watchtower/           # Security audit dashboard
│   ├── vault/                # Vault lock/unlock UI
│   ├── tags/                 # TagInput, TagBadge
│   ├── providers/            # Client-side providers (theme, session, etc.)
│   ├── auth/                 # SignOutButton
│   └── ui/                   # shadcn/ui components
├── lib/
│   ├── crypto-client.ts      # Client-side E2E encryption (personal vault)
│   ├── crypto-server.ts      # Server-side encryption (org vault)
│   ├── crypto-aad.ts         # Additional Authenticated Data for encryption
│   ├── crypto-emergency.ts   # Emergency access key exchange
│   ├── export-crypto.ts      # Password-protected export encryption
│   ├── org-auth.ts           # Org RBAC authorization helpers
│   ├── audit.ts              # Audit log helpers
│   ├── vault-context.tsx     # Vault lock/unlock state
│   ├── password-generator.ts # Server-side secure generation
│   ├── password-analyzer.ts  # Password strength analysis
│   ├── credit-card.ts        # Credit card validation & formatting
│   ├── rate-limit.ts         # Rate limiting logic
│   ├── api-error-codes.ts    # Centralized API error codes & i18n mapping
│   ├── prisma.ts             # Prisma singleton
│   ├── redis.ts              # Redis client (rate limiting)
│   └── validations.ts        # Zod schemas
└── i18n/                     # next-intl routing
```

## Security Model

- **Zero-knowledge** - The server stores only AES-256-GCM ciphertext; it cannot decrypt user data
- **Key derivation** - Passphrase -> PBKDF2 (600k) -> wrapping key -> wraps random 256-bit secret key
- **Domain separation** - Secret key -> HKDF -> separate encryption key + auth key
- **Secret Key** - Additional account-specific salt for defense against server compromise
- **AAD binding** - Additional Authenticated Data ties ciphertext to user and entry IDs
- **Key rotation** - Rotate vault encryption key without re-entering all passwords
- **Session security** - Database sessions (not JWT), 8-hour timeout with 1-hour extension
- **Auto-lock** - Vault locks after 15 min idle or 5 min tab hidden
- **Clipboard clear** - Copied passwords auto-clear after 30 seconds
- **Organization vault** - Server-side AES-256-GCM with per-org keys wrapped by `ORG_MASTER_KEY`
- **RBAC** - Owner / Admin / Member / Viewer role-based access control for organizations
- **Rate limiting** - Redis-backed rate limiting on vault unlock (5 attempts per 15 min)
- **CSP** - Content Security Policy with nonce-based script control and violation reporting

## Deployment Guides

- [Docker Compose Setup (English)](docs/setup.docker.en.md) / [日本語](docs/setup.docker.ja.md)
- [AWS Deployment (English)](docs/setup.aws.en.md) / [日本語](docs/setup.aws.ja.md)
- [Terraform (AWS) — English](infra/terraform/README.md) / [日本語](infra/terraform/README.ja.md)

## License

MIT
