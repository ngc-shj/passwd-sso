# passwd-sso Setup Guide

## Overview

An internal password management web application.
Access is restricted via SSO authentication with SAML 2.0 IdPs (HENNGE, Okta, Azure AD, etc.) and Google (OIDC). Password data is encrypted **client-side** with AES-256-GCM and only ciphertext is stored in PostgreSQL (E2E model).
Google supports both Workspace and personal accounts (`GOOGLE_WORKSPACE_DOMAIN` can be left empty to allow any domain).
Any SAML 2.0 compliant IdP can be used via the SAML Jackson bridge.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | Next.js 16 (App Router) + TypeScript |
| Auth | Auth.js v5 — Google OIDC / SAML 2.0 (via SAML Jackson) |
| DB | PostgreSQL 16 + Prisma 7 |
| Encryption | AES-256-GCM (Web Crypto API, client-side) |
| UI | Tailwind CSS v4 + shadcn/ui + Lucide Icons |
| Deployment | Docker Compose (app / db / jackson — 3 containers) |

## Architecture

```
┌──────────┐    ┌──────────────┐    ┌───────────────┐    ┌────────────┐
│ Browser  │───▶│  Next.js App │───▶│  Auth.js v5   │───▶│ PostgreSQL │
│          │◀──│  (port 3000) │◀──│               │    │ (port 5432)│
└──────────┘    └──────┬───────┘    └───┬───────┬──┘    └────────────┘
                       │                │       │
                       │          ┌─────┘       └─────┐
                       │          ▼                   ▼
                       │   ┌────────────┐    ┌──────────────┐
                       │   │  Google    │    │ SAML Jackson │
                       │   │  OIDC     │    │ (port 5225)  │
                       │   └────────────┘    └──────┬───────┘
                       │                            │
                       │                     ┌──────┴───────┐
                       │                     │  SAML 2.0    │
                       │                     │  IdP         │
                       │                     └──────────────┘
                       │
                       ▼
              ┌──────────────────────────┐
              │  AES-256-GCM (client)    │
              │  Encrypt/Decrypt (E2E)   │
              └──────────────────────────┘
```

### About SAML Jackson

Auth.js does not natively support SAML.
[BoxyHQ SAML Jackson](https://github.com/boxyhq/jackson) runs as a Docker container and acts as a SAML-to-OIDC bridge.
Auth.js connects to it as a standard OIDC provider, so no SAML implementation is needed in the application.

Any SAML 2.0 compliant IdP (HENNGE, Okta, Azure AD, OneLogin, Google Workspace SAML, etc.) can be used.

The npm package (`@boxyhq/saml-jackson`) was avoided due to heavy dependencies and known vulnerabilities. The Docker image (`boxyhq/jackson:latest`) is used instead.

## Prerequisites

- Node.js 20 or later
- Docker / Docker Compose
- Access to Google Cloud Console (for OIDC configuration)
- Access to your SAML 2.0 IdP admin panel (for SAML configuration)

## Setup Steps

### 1. Clone and Install Dependencies

```bash
git clone <repository-url>
cd passwd-sso
npm install
```

### 2. Configure Environment Variables

```bash
cp .env.example .env.local
```

Edit `.env.local` and set the following values:

| Variable | Description | How to Generate |
|----------|-------------|-----------------|
| `DATABASE_URL` | PostgreSQL connection string | Use default for development |
| `AUTH_URL` | Application public URL | `http://localhost:3000` for dev |
| `AUTH_SECRET` | NextAuth session signing key | `openssl rand -base64 32` |
| `AUTH_GOOGLE_ID` | Google OAuth Client ID | From Google Cloud Console |
| `AUTH_GOOGLE_SECRET` | Google OAuth Client Secret | From Google Cloud Console |
| `GOOGLE_WORKSPACE_DOMAIN` | Allowed domain | e.g., `example.com` |
| `JACKSON_URL` | SAML Jackson URL | `http://localhost:5225` for dev |
| `AUTH_JACKSON_ID` | Jackson OIDC Client ID | From Jackson admin panel |
| `AUTH_JACKSON_SECRET` | Jackson OIDC Client Secret | From Jackson admin panel |
| `SAML_PROVIDER_NAME` | SAML IdP display name on sign-in page | e.g., `HENNGE`, `Okta`, `Azure AD` |
| `SHARE_MASTER_KEY` | Master key for organization vault encryption (256-bit hex) | `openssl rand -hex 32` |
| `REDIS_URL` | (Optional) Redis URL for shared rate limiting | e.g., `redis://host:6379` |
| `BLOB_BACKEND` | Attachment storage backend | `db`, `s3`, `azure`, or `gcs` |
| `AWS_REGION`, `S3_ATTACHMENTS_BUCKET` | Required if `BLOB_BACKEND=s3` | e.g., `ap-northeast-1`, bucket name |
| `AZURE_STORAGE_ACCOUNT`, `AZURE_BLOB_CONTAINER` | Required if `BLOB_BACKEND=azure` | Azure Storage account / container |
| `GCS_ATTACHMENTS_BUCKET` | Required if `BLOB_BACKEND=gcs` | GCS bucket name |

> **Redis is optional.** If `REDIS_URL` is not set, the app runs without Redis and rate limiting on vault unlock is disabled. For single-instance deployments, you can safely omit Redis.

### 3. Start PostgreSQL

```bash
docker compose up db -d
```

In development, `docker-compose.override.yml` exposes port 5432 to the host.

Verify health:

```bash
docker compose ps
# STATUS should be "healthy"
```

### 4. Run Database Migration

```bash
npx prisma migrate dev --name init
```

### 5. Seed Default Data

```bash
npx tsx prisma/seed.ts
```

Creates default categories: Web, Email, Server, Database, API, Other

### 6. Start Development Server

```bash
npm run dev
```

Access at `http://localhost:3000`.
Unauthenticated users are redirected to `/auth/signin`.

## IdP Configuration

### Google OIDC

#### 1. Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project from the project selector at the top
   - Project name: `passwd-sso` (any name)
3. Make sure the created project is selected

#### 2. Configure OAuth Consent Screen

1. Navigate to **Google Auth Platform** > **Branding** > "Create Branding"
2. **Step 1 - App information**:
   - App name: `passwd-sso`
   - User support email: your email address
3. **Step 2 - Audience**:
   - For testing with personal accounts: select **External**
   - For Google Workspace organization only: select **Internal**
4. **Step 3 - Contact information**: enter your email address
5. **Step 4 - Finish**: agree to Google API Services policy and click "Create"

> **Note**: When "External" is selected, the app runs in test mode. Only users added as test users can sign in. Add test users from the "Audience" menu.

#### 3. Create OAuth Client ID

1. Navigate to **Clients** > "+ Create Client"
2. Application type: **Web application**
3. Name: `passwd-sso-dev` (any name)
4. **Authorized redirect URIs**:
   - Development: `http://localhost:3000/api/auth/callback/google`
   - Production: `https://<your-domain>/api/auth/callback/google`
5. Click "Create"
6. Set the displayed **Client ID** and **Client Secret** in `.env.local`:

   ```bash
   AUTH_GOOGLE_ID=<Client ID>
   AUTH_GOOGLE_SECRET=<Client Secret>
   ```

### SAML 2.0 IdP (via SAML Jackson)

Any SAML 2.0 compliant IdP (HENNGE, Okta, Azure AD, OneLogin, etc.) can be used.

1. Start SAML Jackson:
   ```bash
   docker compose up jackson -d
   ```

2. In the Jackson admin panel (`http://localhost:5225`):
   - Register your IdP's SAML metadata XML
   - Configure tenant / product

3. In your IdP's admin panel:
   - ACS URL: `http://localhost:5225/api/oauth/saml`
   - Entity ID: Use the value provided by Jackson

4. Set the OIDC Client ID / Secret issued by Jackson in `.env.local`

5. Set `SAML_PROVIDER_NAME` in `.env.local` to the IdP name shown on the sign-in page (e.g., `HENNGE`, `Okta`)

## Production Deployment

### Start All Services with Docker Compose

```bash
docker compose up -d
```

Three containers will start:
- `app` — Next.js application (port 3000)
- `db` — PostgreSQL (internal network only)
- `jackson` — SAML Jackson (internal network only)

In production, do NOT place `docker-compose.override.yml` (keeps DB/Jackson ports unexposed).

### Manual Build

```bash
npm run build
npm start
```

## Security Design

### Encryption

- **Algorithm**: AES-256-GCM
- **Client-side encryption**: No server-side master key. The vault secret key is generated in the browser and wrapped with a passphrase-derived key.
- **IV**: Randomly generated per record (96-bit). Identical passwords produce different ciphertexts
- **AuthTag**: GCM authentication tag (128-bit). Used for tamper detection
- **Encrypted Fields**: `encryptedBlob`, `encryptedOverview` (each with its own IV/AuthTag)
- **Share links / Sends**: Server-side encryption uses `SHARE_MASTER_KEY`. Store this value in a secret manager in production.
- **Rate limiting**: Use Redis (`REDIS_URL`) for shared limits in production.

### API Security

- All password APIs require authentication (protected by proxy)
- List API returns encrypted overview data only (client decrypts)
- Detail view decrypts client-side using the in-memory vault key
- Ownership check: Access to another user's passwords returns 403 Forbidden
- `/api/vault/unlock` is rate-limited (5 attempts / 5 minutes per user+IP)

### Client-side

- Clipboard auto-clears 30 seconds after copy
- Password display auto-hides after 30 seconds
- Confirmation dialog before deletion

### HTTP Headers

Configured in `next.config.ts`:
- `Strict-Transport-Security` (enforce HTTPS)
- `X-Frame-Options: DENY` (clickjacking prevention)
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`

Configured in proxy:
- `Content-Security-Policy` with per-request nonce
- CSP reporting to `/api/csp-report`
- `CSP_MODE` can be set to `dev` (allows `style-src 'unsafe-inline'`) or `strict` (nonce-only)

### Session

- Database-backed session management (not JWT)
- Session lifetime: 8 hours
- Activity-based extension: within 1 hour of last access

## npm Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server (Turbopack) |
| `npm run build` | Production build |
| `npm start` | Start production server |
| `npm run lint` | Run ESLint |
| `npm run db:migrate` | Run Prisma migration |
| `npm run db:seed` | Seed default data |
| `npm run db:studio` | Open Prisma Studio (DB GUI) |
| `npm run generate:key` | Generate random 256-bit key |

## Prisma 7 Notes

Prisma 7 introduces the following breaking changes:

- `url` removed from `datasource` block in `schema.prisma`. DB URL is managed in `prisma.config.ts`
- Default engine changed to `client`. Requires `@prisma/adapter-pg` + `pg` packages
- `dotenv` does not auto-load `.env.local`. Must explicitly call `config({ path: ".env.local" })` in `prisma.config.ts`

## Directory Structure

```
passwd-sso/
├── docker-compose.yml          # Production (ports unexposed)
├── docker-compose.override.yml # Development (ports exposed)
├── Dockerfile                  # Multi-stage build
├── .env.example                # Environment variable template
├── prisma.config.ts            # Prisma 7 configuration
├── prisma/
│   ├── schema.prisma           # Database schema
│   ├── migrations/             # Migrations
│   └── seed.ts                 # Seed data
├── src/
│   ├── auth.ts                 # Auth.js config (Prisma Adapter)
│   ├── auth.config.ts          # Auth.js config (Edge-safe)
│   ├── proxy.ts               # Route protection (proxy logic)
│   ├── app/
│   │   ├── api/
│   │   │   ├── auth/[...nextauth]/  # Auth endpoint
│   │   │   ├── categories/          # Category list API
│   │   │   └── passwords/           # Password CRUD API
│   │   ├── auth/{signin,error}/     # Auth UI
│   │   └── dashboard/              # Main UI
│   ├── components/
│   │   ├── auth/               # Auth components
│   │   ├── layout/             # Header, sidebar
│   │   ├── passwords/          # Password management UI
│   │   └── ui/                 # shadcn/ui
│   └── lib/
│       ├── crypto.ts           # AES-256-GCM encryption
│       ├── password-generator.ts
│       ├── prisma.ts           # Prisma client
│       └── validations.ts      # Zod schemas
└── docs/
    ├── setup/docker/en.md      # This document
    └── setup/aws/en.md         # AWS deployment guide
```
