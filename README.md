# passwd-sso

[日本語](README.ja.md)

A self-hosted password manager with SSO authentication, end-to-end encryption, and a modern web UI.

## Screenshots

![passwd-sso dashboard](docs/assets/passwd-sso-dashboard.png)

<details>
<summary>More screenshots</summary>

### Entry Detail (AWS 3-field example)

![passwd-sso entry detail](docs/assets/passwd-sso-entry-detail.png)

### Password Generator

![passwd-sso password generator](docs/assets/passwd-sso-password-generator.png)

### Browser Extension (AWS IAM 3-field fill)

![passwd-sso extension aws fill 1](docs/assets/passwd-sso-extension-aws-fill-1.png)
![passwd-sso extension aws fill 2](docs/assets/passwd-sso-extension-aws-fill-2.png)

</details>

## Features

### Vault & Entries

- **End-to-End Encryption** — AES-256-GCM; the server never sees plaintext passwords
- **Multiple Entry Types** — Passwords, secure notes, credit cards, identity, passkeys, bank accounts, software licenses, SSH keys
- **Custom Fields** — TEXT, HIDDEN, URL, BOOLEAN, DATE, MONTH_YEAR
- **Password Generator** — Random (8-128 chars) and diceware passphrases (3-10 words)
- **TOTP Authenticator** — Store/generate 2FA codes with camera QR capture
- **Attachments** — Encrypted file attachments (personal and team E2E)
- **Folders & Tags** — Nested color-coded tags, hierarchical folders, favorites, archive, soft-delete trash (30-day auto-purge)
- **Entry History** — Version history with comparison and restore
- **Bulk Operations** — Batch archive, trash, restore across multiple entries
- **Import / Export** — Bitwarden, 1Password, KeePassXC, Chrome CSV import; CSV/JSON export with optional AES-256-GCM encryption

### Authentication

- **SSO** — Google OIDC + SAML 2.0 (via [BoxyHQ SAML Jackson](https://github.com/boxyhq/jackson))
- **Passkey Sign-In** — Discoverable FIDO2 (WebAuthn); PRF-capable keys auto-unlock vault
- **Email + Security Key** — Non-discoverable credential via email lookup with timing-oracle mitigation
- **Magic Link** — Email-based passwordless authentication with locale-aware templates
- **Master Passphrase** — PBKDF2 (600k) or Argon2id (64 MB) + HKDF with Secret Key

### Security & Compliance

- **Security Audit (Watchtower)** — Breached (HIBP), weak, reused, old, HTTP-URL detection; dark-web monitoring with email alerts
- **Account Lockout** — Progressive lockout (5→15min, 10→1h, 15→24h)
- **Concurrent Session Limits** — Tenant-level max session cap with automatic oldest-session eviction
- **Rate Limiting** — Redis-backed on sensitive endpoints; optional Sentinel HA for production
- **CSP & Security Headers** — Nonce-based CSP, violation reporting, OWASP headers
- **Recovery Key** — 256-bit key (HKDF + AES-256-GCM) with Base32 encoding; recover vault without passphrase
- **Vault Reset** — Last-resort full deletion with explicit confirmation
- **Key Rotation** — Rotate encryption key with passphrase verification
- **Travel Mode** — Hide sensitive entries when crossing borders; remote disable restores access
- **Network Access Restriction** — CIDR allowlist and Tailscale integration per tenant
- **Audit Logs & Webhooks** — Personal/team/tenant logs with filters, CSV/JSONL download, webhook delivery
- **Audit Log Forwarding** — Structured JSON output via Fluent Bit sidecar for external collection
- **Break Glass** — Tenant admin emergency access to personal audit logs with time-limited grants
- **Error Tracking** — Sentry with recursive sensitive data scrubbing
- **CI Security** — CodeQL SAST, Trivy container scan, crypto domain ledger, npm audit
- **Reproducible Builds** — Docker base image digest pinning with build metadata verification

### Team & Organization

- **Team Vault** — E2E encrypted sharing (ECDH-P256) with RBAC (Owner/Admin/Member/Viewer)
- **Team Security Policies** — Sharing/export controls, reprompt requirements, password-policy guidance
- **Multi-Tenant Isolation** — PostgreSQL FORCE RLS on 33 tables with IdP claim-based tenant resolution
- **SCIM 2.0 Provisioning** — Tenant-scoped user/group sync (RFC 7644)
- **Directory Sync** — Azure AD, Google Workspace, Okta member sync
- **Tenant Admin** — Member management, SCIM tokens, admin vault reset, tenant settings
- **Share Links** — Time-limited sharing with access logs and visibility controls
- **Sends** — Ephemeral text/file sharing with automatic expiration
- **Emergency Access** — Request/approve temporary vault access with key exchange
- **Session Management** — Active session list, single/all revoke, auto-invalidation on member removal
- **Notifications** — In-app and email for emergency-access events and new-device logins

### Developer Tools

- **CLI** — `passwd-sso` with 13 commands; OS keychain integration, XDG-compliant config
- **SSH Agent** — `passwd-sso agent` proxies vault SSH keys via SSH agent protocol
- **CI/CD Secrets** — `env` and `run` commands inject vault secrets into environment/subprocess
- **Browser Extension** — Chrome/Edge MV3; autofill, inline suggestions, AWS 3-field, CC/address fill, new-login detect & save
- **REST API v1** — `/api/v1/*` with OpenAPI 3.1 spec
- **API Keys** — Scoped keys with SHA-256 hashed tokens and configurable expiration

### UI & Localization

- **i18n** — English and Japanese (next-intl)
- **Dark Mode** — Light / dark / system (next-themes)
- **Keyboard Shortcuts** — `/ or Cmd+K` search, `n` new, `?` help, `Esc` clear
- **Locale Persistence** — Saved to DB, used for emails/notifications

## Tech Stack

| Layer | Technology |
| --- | --- |
| Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript 5.9 |
| Database | PostgreSQL 16 |
| ORM | Prisma 7 (driver adapter with pg) |
| Auth | Auth.js v5 (database sessions) |
| SAML Bridge | BoxyHQ SAML Jackson (Docker) |
| UI | Tailwind CSS 4 + shadcn/ui + Radix UI |
| Encryption | Web Crypto API (vault E2E) + AES-256-GCM (server-side) |
| Cache / Rate Limit | Redis 7 |

## Architecture

```text
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

**Personal vault** — All data is encrypted **client-side** before reaching the server. The server stores only ciphertext.

**Team vault** — Shared passwords use **client-side E2E** encryption with ECDH-P256 member-key exchange.

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

Edit `.env.local` — key variables:

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Google OAuth credentials |
| `JACKSON_URL` | SAML Jackson URL (default: `http://localhost:5225`) |
| `AUTH_JACKSON_ID` / `AUTH_JACKSON_SECRET` | Jackson OIDC credentials |
| `SHARE_MASTER_KEY` | `openssl rand -hex 32` — for server-encrypted share links |
| `VERIFIER_PEPPER_KEY` | `openssl rand -hex 32` — passphrase verifier pepper (**required in prod**) |
| `REDIS_URL` | Redis URL for rate limiting (**required in prod**) |

<details>
<summary>All environment variables</summary>

| Variable | Description |
| --- | --- |
| `NEXT_PUBLIC_APP_NAME` | (Optional) Display name shown in the UI |
| `NEXT_PUBLIC_BASE_PATH` | (Optional) Sub-path for reverse proxy (e.g., `/passwd-sso`). Set before build |
| `APP_URL` | (Optional) External URL when behind reverse proxy/CDN (origin only) |
| `DATABASE_URL` | PostgreSQL connection string |
| `AUTH_URL` | Application origin (e.g., `http://localhost:3000`) |
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `AUTH_GOOGLE_ID` | Google OAuth client ID |
| `AUTH_GOOGLE_SECRET` | Google OAuth client secret |
| `GOOGLE_WORKSPACE_DOMAINS` | (Optional) Restrict to Google Workspace domain(s), comma-separated |
| `AUTH_TENANT_CLAIM_KEYS` | (Optional) IdP claim keys for tenant resolution (e.g. `tenant_id,organization`) |
| `JACKSON_URL` | SAML Jackson URL (default: `http://localhost:5225`) |
| `AUTH_JACKSON_ID` | Jackson OIDC client ID |
| `AUTH_JACKSON_SECRET` | Jackson OIDC client secret |
| `SAML_PROVIDER_NAME` | Sign-in page display name (e.g., "HENNGE") |
| `SHARE_MASTER_KEY` | `openssl rand -hex 32` — for server-encrypted share links/sends |
| `VERIFIER_PEPPER_KEY` | `openssl rand -hex 32` — passphrase verifier pepper (**required in prod**) |
| `DIRECTORY_SYNC_MASTER_KEY` | `openssl rand -hex 32` — directory sync credential encryption (**required in prod**) |
| `WEBAUTHN_RP_ID` | (Optional) Relying Party ID (your domain) |
| `WEBAUTHN_RP_NAME` | (Optional) Relying Party display name |
| `WEBAUTHN_RP_ORIGIN` | (Optional) RP origin for verification (e.g., `http://localhost:3000`) |
| `WEBAUTHN_PRF_SECRET` | `openssl rand -hex 32` — PRF salt derivation for passkey vault unlock |
| `OPENAPI_PUBLIC` | (Optional) Set to `false` to require auth for OpenAPI spec |
| `REDIS_URL` | Redis URL for rate limiting (**required in prod**) |
| `BLOB_BACKEND` | Attachment backend (`db` / `s3` / `azure` / `gcs`) |
| `AWS_REGION`, `S3_ATTACHMENTS_BUCKET` | Required when `BLOB_BACKEND=s3` |
| `AZURE_STORAGE_ACCOUNT`, `AZURE_BLOB_CONTAINER` | Required when `BLOB_BACKEND=azure` |
| `AZURE_STORAGE_CONNECTION_STRING` or `AZURE_STORAGE_SAS_TOKEN` | Required when `BLOB_BACKEND=azure` |
| `GCS_ATTACHMENTS_BUCKET` | Required when `BLOB_BACKEND=gcs` |
| `BLOB_OBJECT_PREFIX` | Optional key prefix for cloud object paths |
| `AUDIT_LOG_FORWARD` | (Optional) Emit structured JSON audit logs to stdout |
| `AUDIT_LOG_APP_NAME` | (Optional) App name for audit log forwarding |
| `EMAIL_PROVIDER` | (Optional) `resend` or `smtp` — leave empty to disable email |
| `EMAIL_FROM` | Sender address for emails |
| `RESEND_API_KEY` | Required when `EMAIL_PROVIDER=resend` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Required when `EMAIL_PROVIDER=smtp` |
| `DB_POOL_MAX`, `DB_POOL_*` | (Optional) PostgreSQL connection pool tuning |
| `NEXT_PUBLIC_CHROME_STORE_URL` | (Optional) Chrome Web Store URL for extension distribution |
| `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_DSN` | (Optional) Sentry DSN for error tracking |
| `SENTRY_AUTH_TOKEN` | (Optional) Sentry auth token for source map upload |

</details>

> **Redis is required in production.** In dev/test, omit `REDIS_URL` for in-memory fallback.

### 3. Start services

**Development:**

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d db jackson redis
npm run db:migrate
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

**Production:**

```bash
docker compose up -d
```

### 4. First-time setup

1. Sign in with Google or SAML SSO
2. Set up your master passphrase
3. Start adding passwords

## Browser Extension (Chrome/Edge)

MV3 extension in `extension/`.

```bash
cd extension && npm install && npm run build
```

1. Open `chrome://extensions` → Enable **Developer mode** → **Load unpacked** → select `extension/dist`
2. Set server URL in extension settings if needed
3. Connect, unlock vault, use autofill

## Security Model

Zero-knowledge architecture — the server stores only ciphertext and cannot decrypt user data.

- **Key derivation** — Passphrase → PBKDF2/Argon2id → wrapping key → wraps random 256-bit secret key
- **Domain separation** — Secret key → HKDF → separate encryption key + auth key
- **Secret Key** — Account-specific salt for defense against server compromise
- **AAD binding** — Additional Authenticated Data ties ciphertext to user and entry IDs
- **Session security** — Database sessions (not JWT), 8-hour timeout, auto-lock after 15 min idle or 5 min tab hidden
- **Clipboard clear** — Copied passwords auto-clear after 30 seconds
- **CSRF defense** — JSON body + SameSite cookie + CSP + Origin validation

For the full design, see the [Cryptography Whitepaper](docs/security/cryptography-whitepaper.md).

## Project Structure

```text
src/
├── app/[locale]/         # Pages (landing, dashboard, auth)
├── app/api/              # API routes (vault, passwords, tags, teams, SCIM, etc.)
├── components/           # UI components (passwords, team, vault, settings, etc.)
├── lib/                  # Core logic (crypto, auth, validation, rate limiting)
└── i18n/                 # next-intl routing
extension/                # Chrome/Edge MV3 browser extension
cli/                      # Node.js CLI tool
docs/                     # Documentation (architecture, security, operations, setup)
```

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Development server (Turbopack) |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm test` | Run tests once (vitest) |
| `npm run test:watch` | Tests in watch mode |
| `npm run test:coverage` | Tests with coverage |
| `npm run test:e2e` | Playwright E2E tests |
| `npm run db:migrate` | Prisma migrate (dev) |
| `npm run db:push` | Push schema without migration |
| `npm run db:seed` | Seed data |
| `npm run db:studio` | Prisma Studio GUI |
| `npm run generate:key` | Generate 256-bit hex key |
| `npm run generate:icons` | Generate app icons |

<details>
<summary>CI / security / load-test / license scripts</summary>

| Command | Description |
| --- | --- |
| `npm run check:team-auth-rls` | Verify team auth + RLS patterns |
| `npm run check:bypass-rls` | Detect RLS bypass in queries |
| `npm run check:crypto-domains` | Validate crypto domain separation |
| `npm run licenses:check` | Check app dependency licenses |
| `npm run licenses:check:strict` | Strict license check (CI) |
| `npm run licenses:check:ext` | Check extension dependency licenses |
| `npm run licenses:check:ext:strict` | Strict extension license check (CI) |
| `npm run licenses:check:cli` | Check CLI dependency licenses |
| `npm run licenses:check:cli:strict` | Strict CLI license check (CI) |
| `npm run test:cli` | Run CLI tests |
| `npm run test:load:smoke` | Load-test seed smoke checks |
| `npm run test:load:seed` | Seed load-test users/sessions |
| `npm run test:load` | k6 mixed-workload scenario |
| `npm run test:load:health` | k6 health endpoint scenario |
| `npm run test:load:cleanup` | Cleanup load-test data |
| `npm run scim:smoke` | SCIM smoke checks (requires `SCIM_TOKEN`) |

</details>

## Import Samples

- passwd-sso JSON: [`docs/assets/passwd-sso.json`](docs/assets/passwd-sso.json)
- passwd-sso CSV: [`docs/assets/passwd-sso.csv`](docs/assets/passwd-sso.csv)

## Documentation

- [Security Policy](SECURITY.md)
- [Cryptography Whitepaper](docs/security/cryptography-whitepaper.md) — full key hierarchy and crypto design
- [Threat Model (STRIDE)](docs/security/threat-model.md) — systematic threat analysis
- [Security Considerations](docs/security/considerations/en.md) / [日本語](docs/security/considerations/ja.md)
- [Docker Setup](docs/setup/docker/en.md) · [AWS](docs/setup/aws/en.md) · [Vercel](docs/setup/vercel/en.md) · [Azure](docs/setup/azure/en.md) · [GCP](docs/setup/gcp/en.md)
- [Terraform (AWS)](infra/terraform/README.md) / [日本語](infra/terraform/README.ja.md)
- [Deployment Operations](docs/operations/deployment.md)
- [Backup & Recovery](docs/operations/backup-recovery/en.md) / [日本語](docs/operations/backup-recovery/ja.md)
- [Redis HA](docs/operations/redis-ha.md) — Redis Sentinel/Cluster configuration
- [Audit Log Reference](docs/operations/audit-log-reference.md)
- [Incident Runbook](docs/operations/incident-runbook.md)
- [All docs](docs/README.md)

## License

MIT
