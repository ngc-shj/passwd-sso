import type { envObject } from "@/lib/env-schema";
import type { z } from "zod";

// T22: enumerated groups — typos become compile errors.
export const GROUPS = [
  "Application",
  "Database",
  "Auth",
  "Auth providers",
  "Vault keys",
  "WebAuthn",
  "Blob storage",
  "Email",
  "Logging",
  "Health",
  "Redis",
  "Outbox worker",
  "Key provider",
  "DB pool",
  "Reverse proxy",
  "Public (client-inlined)",
  "Sentry",
  "Tailscale",
  "Operational",
] as const;

export type Group = (typeof GROUPS)[number];

export type SidecarEntry = {
  group: Group;
  order: number;
  description: string;
  example?: string;
  secret?: boolean;
  scope?: "runtime" | "build" | "framework-set";
};

export const descriptions: Record<
  keyof z.infer<typeof envObject>,
  SidecarEntry
> = {
  // ── Application ──────────────────────────────────────────────────────────

  NODE_ENV: {
    group: "Application",
    order: 1,
    description: "Runtime mode. Controls superRefine production requirements.",
    example: "development",
  },
  APP_URL: {
    group: "Application",
    order: 2,
    description:
      "Canonical base URL of this deployment (e.g. https://app.example.com).\n" +
      "Used for absolute URL construction in emails and redirects.",
    example: "http://localhost:3000",
  },
  OPENAPI_PUBLIC: {
    group: "Application",
    order: 3,
    description:
      "Expose OpenAPI spec at /api/v1/openapi.json. Default: true.\n" +
      "Set to false to restrict API spec access in production.",
    example: "true",
  },
  CSP_MODE: {
    group: "Application",
    order: 4,
    description:
      "Content Security Policy mode. 'strict' for production, 'dev' to relax\n" +
      "inline-script restrictions during development.",
    example: "strict",
  },

  // ── Database ─────────────────────────────────────────────────────────────

  DATABASE_URL: {
    group: "Database",
    order: 1,
    description:
      "PostgreSQL connection URL for the application role (passwd_app).\n" +
      "Must NOT have superuser privileges — RLS enforcement depends on this.",
    example: "postgresql://passwd_app:pass@localhost:5432/passwd_sso",
  },
  MIGRATION_DATABASE_URL: {
    group: "Database",
    order: 2,
    description:
      "Superuser PostgreSQL URL for Prisma CLI (migrate, studio).\n" +
      "Optional — falls back to DATABASE_URL if unset.",
    example: "postgresql://passwd_user:pass@localhost:5432/passwd_sso",
  },
  OUTBOX_WORKER_DATABASE_URL: {
    group: "Database",
    order: 3,
    description:
      "PostgreSQL connection URL for the audit-outbox worker role (passwd_outbox_worker).\n" +
      "Least privilege: SELECT/UPDATE/DELETE on audit_outbox, INSERT on audit_logs.\n" +
      "Optional — falls back to DATABASE_URL if unset.",
    example: "postgresql://passwd_outbox_worker:pass@localhost:5432/passwd_sso",
  },

  // ── Auth ─────────────────────────────────────────────────────────────────

  AUTH_SECRET: {
    group: "Auth",
    order: 1,
    description:
      "Auth.js secret used to sign session cookies and tokens.\n" +
      "Required in production (minimum 32 characters).",
    secret: true,
  },
  AUTH_URL: {
    group: "Auth",
    order: 2,
    description:
      "Canonical callback URL for Auth.js (e.g. https://app.example.com).\n" +
      "Required in production.",
    example: "http://localhost:3000",
  },
  NEXTAUTH_URL: {
    group: "Auth",
    order: 3,
    description:
      "Legacy Auth.js v4 base URL. Used as fallback for AUTH_URL in session helpers.\n" +
      "Optional — prefer AUTH_URL for new deployments.",
    example: "http://localhost:3000",
  },

  // ── Auth providers ────────────────────────────────────────────────────────

  AUTH_GOOGLE_ID: {
    group: "Auth providers",
    order: 1,
    description: "Google OAuth 2.0 client ID for OIDC sign-in.",
    example: "123456789-abc.apps.googleusercontent.com",
  },
  AUTH_GOOGLE_SECRET: {
    group: "Auth providers",
    order: 2,
    description: "Google OAuth 2.0 client secret.",
    secret: true,
  },
  GOOGLE_WORKSPACE_DOMAINS: {
    group: "Auth providers",
    order: 3,
    description:
      "Comma-separated list of Google Workspace domains allowed to sign in.\n" +
      "Leave empty to allow any Google account.",
    example: "example.com,partner.example.com",
  },
  AUTH_JACKSON_ID: {
    group: "Auth providers",
    order: 4,
    description: "OIDC client ID registered in BoxyHQ SAML Jackson.",
    example: "saml-jackson-client",
  },
  AUTH_JACKSON_SECRET: {
    group: "Auth providers",
    order: 5,
    description: "OIDC client secret registered in BoxyHQ SAML Jackson.",
    secret: true,
  },
  JACKSON_URL: {
    group: "Auth providers",
    order: 6,
    description:
      "Base URL of the BoxyHQ SAML Jackson instance (OIDC proxy).\n" +
      "Required when AUTH_JACKSON_ID and AUTH_JACKSON_SECRET are set.",
    example: "http://localhost:5225",
  },
  AUTH_TENANT_CLAIM_KEYS: {
    group: "Auth providers",
    order: 7,
    description:
      "Comma-separated JWT claim keys used to extract the tenant identifier\n" +
      "from the OIDC token (e.g. 'tenant,org_id').",
    example: "tenant",
  },
  SAML_PROVIDER_NAME: {
    group: "Auth providers",
    order: 8,
    description: "Display name for the SAML/SSO button on the sign-in page. Default: SSO.",
    example: "SSO",
  },

  // ── Vault keys ────────────────────────────────────────────────────────────

  SHARE_MASTER_KEY: {
    group: "Vault keys",
    order: 1,
    description:
      "256-bit master key (64-char hex) for encrypting ShareLink payloads.\n" +
      "Equivalent to SHARE_MASTER_KEY_V1 when SHARE_MASTER_KEY_CURRENT_VERSION=1.",
    secret: true,
  },
  SHARE_MASTER_KEY_V1: {
    group: "Vault keys",
    order: 2,
    description: "Version-1 ShareLink master key (64-char hex). Supersedes SHARE_MASTER_KEY.",
    secret: true,
  },
  SHARE_MASTER_KEY_V2: {
    group: "Vault keys",
    order: 3,
    description:
      "Version-2 ShareLink master key (64-char hex).\n" +
      "Used only when SHARE_MASTER_KEY_CURRENT_VERSION=2.",
    secret: true,
  },
  SHARE_MASTER_KEY_V3: {
    group: "Vault keys",
    order: 4,
    description:
      "Version-3 ShareLink master key (64-char hex).\n" +
      "Used only when SHARE_MASTER_KEY_CURRENT_VERSION=3.",
    secret: true,
  },
  SHARE_MASTER_KEY_V4: {
    group: "Vault keys",
    order: 5,
    description:
      "Version-4 ShareLink master key (64-char hex).\n" +
      "Used only when SHARE_MASTER_KEY_CURRENT_VERSION=4.",
    secret: true,
  },
  SHARE_MASTER_KEY_V5: {
    group: "Vault keys",
    order: 6,
    description:
      "Version-5 ShareLink master key (64-char hex).\n" +
      "Used only when SHARE_MASTER_KEY_CURRENT_VERSION=5.",
    secret: true,
  },
  SHARE_MASTER_KEY_V6: {
    group: "Vault keys",
    order: 7,
    description:
      "Version-6 ShareLink master key (64-char hex).\n" +
      "Used only when SHARE_MASTER_KEY_CURRENT_VERSION=6.",
    secret: true,
  },
  SHARE_MASTER_KEY_V7: {
    group: "Vault keys",
    order: 8,
    description:
      "Version-7 ShareLink master key (64-char hex).\n" +
      "Used only when SHARE_MASTER_KEY_CURRENT_VERSION=7.",
    secret: true,
  },
  SHARE_MASTER_KEY_V8: {
    group: "Vault keys",
    order: 9,
    description:
      "Version-8 ShareLink master key (64-char hex).\n" +
      "Used only when SHARE_MASTER_KEY_CURRENT_VERSION=8.",
    secret: true,
  },
  SHARE_MASTER_KEY_V9: {
    group: "Vault keys",
    order: 10,
    description:
      "Version-9 ShareLink master key (64-char hex).\n" +
      "Used only when SHARE_MASTER_KEY_CURRENT_VERSION=9.",
    secret: true,
  },
  SHARE_MASTER_KEY_V10: {
    group: "Vault keys",
    order: 11,
    description:
      "Version-10 ShareLink master key (64-char hex).\n" +
      "Used only when SHARE_MASTER_KEY_CURRENT_VERSION=10.",
    secret: true,
  },
  SHARE_MASTER_KEY_CURRENT_VERSION: {
    group: "Vault keys",
    order: 12,
    description:
      "Active ShareLink key version (1–100). Default: 1.\n" +
      "Increment during key rotation; old versions are kept for decryption.",
    example: "1",
  },
  VERIFIER_PEPPER_KEY: {
    group: "Vault keys",
    order: 13,
    description:
      "256-bit pepper key (64-char hex) for HMAC verification of vault data.\n" +
      "Required in production.",
    secret: true,
  },
  DIRECTORY_SYNC_MASTER_KEY: {
    group: "Vault keys",
    order: 15,
    description: "256-bit master key (64-char hex) for encrypting directory-sync credentials.",
    secret: true,
  },

  // ── WebAuthn ──────────────────────────────────────────────────────────────

  WEBAUTHN_RP_ID: {
    group: "WebAuthn",
    order: 1,
    description:
      "Relying Party ID for WebAuthn (passkey) authentication. Default: empty string.\n" +
      "Must match the effective domain of APP_URL (e.g. 'app.example.com').",
    example: "localhost",
  },
  WEBAUTHN_RP_NAME: {
    group: "WebAuthn",
    order: 2,
    description: "Human-readable Relying Party name shown in passkey dialogs.",
    example: "passwd-sso",
  },
  WEBAUTHN_RP_ORIGIN: {
    group: "WebAuthn",
    order: 3,
    description:
      "Origin used for WebAuthn verification (must include scheme + host + port).\n" +
      "Defaults to APP_URL when unset.",
    example: "http://localhost:3000",
  },
  WEBAUTHN_PRF_SECRET: {
    group: "WebAuthn",
    order: 4,
    description:
      "256-bit secret (64-char hex) used to derive the PRF extension salt.\n" +
      "Enables vault auto-unlock after passkey sign-in.",
    secret: true,
  },

  // ── Blob storage ──────────────────────────────────────────────────────────

  BLOB_BACKEND: {
    group: "Blob storage",
    order: 1,
    description: "Attachment storage backend. Default: db (stored in PostgreSQL).",
    example: "db",
  },
  BLOB_OBJECT_PREFIX: {
    group: "Blob storage",
    order: 2,
    description:
      "Key prefix for blob objects in S3/Azure/GCS. Default: empty string.\n" +
      "Useful for multi-tenant bucket sharing.",
    example: "",
  },
  AWS_REGION: {
    group: "Blob storage",
    order: 3,
    description: "AWS region for S3 attachment bucket. Required when BLOB_BACKEND=s3.",
    example: "us-east-1",
  },
  S3_ATTACHMENTS_BUCKET: {
    group: "Blob storage",
    order: 4,
    description: "S3 bucket name for attachments. Required when BLOB_BACKEND=s3.",
    example: "my-passwd-sso-attachments",
  },
  AZURE_STORAGE_ACCOUNT: {
    group: "Blob storage",
    order: 5,
    description: "Azure Storage account name. Required when BLOB_BACKEND=azure.",
    example: "mystorageaccount",
  },
  AZURE_BLOB_CONTAINER: {
    group: "Blob storage",
    order: 6,
    description: "Azure Blob container name for attachments. Required when BLOB_BACKEND=azure.",
    example: "attachments",
  },
  AZURE_STORAGE_CONNECTION_STRING: {
    group: "Blob storage",
    order: 7,
    description:
      "Azure Storage connection string (includes account key).\n" +
      "Mutually exclusive with AZURE_STORAGE_SAS_TOKEN.",
    secret: true,
  },
  AZURE_STORAGE_SAS_TOKEN: {
    group: "Blob storage",
    order: 8,
    description:
      "Azure Shared Access Signature token for scoped blob access.\n" +
      "Mutually exclusive with AZURE_STORAGE_CONNECTION_STRING.",
    secret: true,
  },
  GCS_ATTACHMENTS_BUCKET: {
    group: "Blob storage",
    order: 9,
    description: "Google Cloud Storage bucket for attachments. Required when BLOB_BACKEND=gcs.",
    example: "my-passwd-sso-attachments",
  },

  // ── Email ─────────────────────────────────────────────────────────────────

  EMAIL_PROVIDER: {
    group: "Email",
    order: 1,
    description: "Email delivery provider. One of: resend, smtp.",
    example: "smtp",
  },
  EMAIL_FROM: {
    group: "Email",
    order: 2,
    description:
      "Sender address for transactional email. Default: noreply@localhost.\n" +
      "Used for Magic Link and notification emails.",
    example: "noreply@example.com",
  },
  RESEND_API_KEY: {
    group: "Email",
    order: 3,
    description:
      "Resend API key for transactional email. Required when EMAIL_PROVIDER=resend.",
    secret: true,
  },
  SMTP_HOST: {
    group: "Email",
    order: 4,
    description: "SMTP server hostname. Required when EMAIL_PROVIDER=smtp in production.",
    example: "smtp.example.com",
  },
  SMTP_PORT: {
    group: "Email",
    order: 5,
    description: "SMTP server port. Default: 587 (STARTTLS).",
    example: "587",
  },
  SMTP_USER: {
    group: "Email",
    order: 6,
    description: "SMTP authentication username.",
    example: "smtp-user@example.com",
  },
  SMTP_PASS: {
    group: "Email",
    order: 7,
    description: "SMTP authentication password.",
    secret: true,
  },

  // ── Logging ───────────────────────────────────────────────────────────────

  LOG_LEVEL: {
    group: "Logging",
    order: 1,
    description:
      "pino log level. Default: info.\n" +
      "Valid values: trace, debug, info, warn, error, fatal.",
    example: "info",
  },
  AUDIT_LOG_FORWARD: {
    group: "Logging",
    order: 2,
    description:
      "Forward audit log entries to an external sink (e.g. SIEM) via HTTP. Default: false.",
    example: "false",
  },
  AUDIT_LOG_APP_NAME: {
    group: "Logging",
    order: 3,
    description: "Application name tag embedded in forwarded audit log entries. Default: passwd-sso.",
    example: "passwd-sso",
  },

  // ── Health ────────────────────────────────────────────────────────────────

  HEALTH_REDIS_REQUIRED: {
    group: "Health",
    order: 1,
    description:
      "When true, the /api/health/ready probe returns 503 if Redis is unreachable.\n" +
      "Default: false (Redis failure → degraded but available).",
    example: "false",
  },

  // ── Redis ─────────────────────────────────────────────────────────────────

  REDIS_URL: {
    group: "Redis",
    order: 1,
    description:
      "Redis connection URL for rate limiting and session caching.\n" +
      "Required in production.",
    example: "redis://localhost:6379",
  },
  REDIS_SENTINEL: {
    group: "Redis",
    order: 2,
    description:
      "Enable Redis Sentinel high-availability mode. Default: false.\n" +
      "When true, REDIS_SENTINEL_HOSTS is required.",
    example: "false",
  },
  REDIS_SENTINEL_HOSTS: {
    group: "Redis",
    order: 3,
    description:
      "Comma-separated sentinel host:port pairs. Required when REDIS_SENTINEL=true.\n" +
      "Example: sentinel1:26379,sentinel2:26379",
    example: "sentinel1:26379,sentinel2:26379",
  },
  REDIS_SENTINEL_MASTER_NAME: {
    group: "Redis",
    order: 4,
    description: "Redis Sentinel master group name. Default: mymaster.",
    example: "mymaster",
  },
  REDIS_SENTINEL_PASSWORD: {
    group: "Redis",
    order: 5,
    description: "Password for Redis Sentinel authentication.",
    secret: true,
  },
  REDIS_SENTINEL_TLS: {
    group: "Redis",
    order: 6,
    description: "Enable TLS for Redis Sentinel connections. Default: false.",
    example: "false",
  },

  // ── Outbox worker ─────────────────────────────────────────────────────────

  OUTBOX_BATCH_SIZE: {
    group: "Outbox worker",
    order: 1,
    description: "Number of audit outbox rows processed per batch. Default: 500.",
    example: "500",
  },
  OUTBOX_POLL_INTERVAL_MS: {
    group: "Outbox worker",
    order: 2,
    description: "Interval between outbox drain polls in milliseconds. Default: 1000.",
    example: "1000",
  },
  OUTBOX_PROCESSING_TIMEOUT_MS: {
    group: "Outbox worker",
    order: 3,
    description:
      "Maximum processing time before a row is considered stalled (ms). Default: 300000.",
    example: "300000",
  },
  OUTBOX_MAX_ATTEMPTS: {
    group: "Outbox worker",
    order: 4,
    description: "Maximum delivery attempts before a row is marked FAILED. Default: 8.",
    example: "8",
  },
  OUTBOX_RETENTION_HOURS: {
    group: "Outbox worker",
    order: 5,
    description: "Hours to retain successfully processed outbox rows. Default: 24.",
    example: "24",
  },
  OUTBOX_FAILED_RETENTION_DAYS: {
    group: "Outbox worker",
    order: 6,
    description: "Days to retain FAILED outbox rows for inspection. Default: 90.",
    example: "90",
  },
  OUTBOX_READY_PENDING_THRESHOLD: {
    group: "Outbox worker",
    order: 7,
    description:
      "Alert threshold: number of PENDING rows before worker logs a warning. Default: 10000.",
    example: "10000",
  },
  OUTBOX_READY_OLDEST_THRESHOLD_SECS: {
    group: "Outbox worker",
    order: 8,
    description:
      "Alert threshold: age in seconds of the oldest PENDING row before warning. Default: 600.",
    example: "600",
  },
  OUTBOX_REAPER_INTERVAL_MS: {
    group: "Outbox worker",
    order: 9,
    description: "Interval for the reaper loop that purges old rows (ms). Default: 30000.",
    example: "30000",
  },

  // ── Key provider ─────────────────────────────────────────────────────────

  KEY_PROVIDER: {
    group: "Key provider",
    order: 1,
    description:
      "Secret key provider backend. Default: env (reads from environment variables).\n" +
      "Alternatives: azure-kv (Azure Key Vault), gcp-sm (GCP Secret Manager).",
    example: "env",
  },
  SM_CACHE_TTL_MS: {
    group: "Key provider",
    order: 2,
    description:
      "TTL in milliseconds for the cloud secret manager key cache.\n" +
      "Valid range: 10000–3600000. Optional — defaults to provider-internal value.",
    example: "300000",
  },
  AZURE_KV_URL: {
    group: "Key provider",
    order: 3,
    description:
      "Azure Key Vault base URL. Required when KEY_PROVIDER=azure-kv.\n" +
      "Format: https://<vault-name>.vault.azure.net",
    example: "https://my-vault.vault.azure.net",
  },
  GCP_PROJECT_ID: {
    group: "Key provider",
    order: 4,
    description:
      "Google Cloud project ID. Required when KEY_PROVIDER=gcp-sm.\n" +
      "Used to construct Secret Manager resource names.",
    example: "my-gcp-project",
  },

  // ── DB pool ───────────────────────────────────────────────────────────────

  DB_POOL_MAX: {
    group: "DB pool",
    order: 1,
    description: "Maximum pg.Pool connections. Default: 20.",
    example: "20",
  },
  DB_POOL_CONNECTION_TIMEOUT_MS: {
    group: "DB pool",
    order: 2,
    description: "Milliseconds before a connection attempt times out. Default: 5000.",
    example: "5000",
  },
  DB_POOL_IDLE_TIMEOUT_MS: {
    group: "DB pool",
    order: 3,
    description: "Milliseconds an idle connection is kept before release. Default: 30000.",
    example: "30000",
  },
  DB_POOL_MAX_LIFETIME_SECONDS: {
    group: "DB pool",
    order: 4,
    description: "Maximum lifetime of a pooled connection in seconds. Default: 1800.",
    example: "1800",
  },
  DB_POOL_STATEMENT_TIMEOUT_MS: {
    group: "DB pool",
    order: 5,
    description:
      "Per-query statement timeout in milliseconds. Default: 30000.\n" +
      "Set to 0 to disable.",
    example: "30000",
  },

  // ── Reverse proxy ─────────────────────────────────────────────────────────

  TRUSTED_PROXIES: {
    group: "Reverse proxy",
    order: 1,
    description:
      "Comma-separated list of trusted reverse-proxy CIDR ranges or IPs.\n" +
      "Used to extract the real client IP from X-Forwarded-For.",
    example: "10.0.0.0/8,172.16.0.0/12",
  },
  TRUST_PROXY_HEADERS: {
    group: "Reverse proxy",
    order: 2,
    description:
      "When true, trust X-Forwarded-For and related proxy headers. Default: false.\n" +
      "Only enable when the app is behind a trusted reverse proxy.",
    example: "false",
  },

  // ── Public (client-inlined) ───────────────────────────────────────────────

  NEXT_PUBLIC_APP_NAME: {
    group: "Public (client-inlined)",
    order: 1,
    description:
      "Application display name, inlined into the client bundle at build time. Default: passwd-sso.",
    example: "passwd-sso",
    scope: "build",
  },
  NEXT_PUBLIC_BASE_PATH: {
    group: "Public (client-inlined)",
    order: 2,
    description:
      "Base path prefix for the app (e.g. /vault). Default: empty.\n" +
      "Inlined at build time; consumer-side fallback MUST be preserved.",
    example: "",
    scope: "build",
  },
  NEXT_PUBLIC_CHROME_STORE_URL: {
    group: "Public (client-inlined)",
    order: 3,
    description:
      "Chrome Web Store URL for the browser extension. Optional.\n" +
      "When set, the header shows an 'Install extension' link.",
    example: "https://chrome.google.com/webstore/detail/<ext-id>",
    scope: "build",
  },
  NEXT_PUBLIC_SENTRY_DSN: {
    group: "Public (client-inlined)",
    order: 4,
    description:
      "Sentry DSN for client-side (browser) error reporting. Optional.\n" +
      "Use a dedicated client-scope DSN; do NOT reuse SENTRY_DSN.",
    example: "https://public@sentry.example.com/2",
    scope: "build",
  },

  // ── Sentry ────────────────────────────────────────────────────────────────

  SENTRY_DSN: {
    group: "Sentry",
    order: 1,
    description:
      "Server-only Sentry DSN for server-side error reporting.\n" +
      "DO NOT reuse NEXT_PUBLIC_SENTRY_DSN — use a dedicated server DSN\n" +
      "with narrower scope for server error reporting (S17).",
    secret: true,
  },

  // ── Tailscale ─────────────────────────────────────────────────────────────

  TAILSCALE_API_BASE: {
    group: "Tailscale",
    order: 1,
    description:
      "Tailscale control-plane API base URL. Optional — used by the Tailscale client.\n" +
      "Default: https://api.tailscale.com",
    example: "https://api.tailscale.com",
  },
  TAILSCALE_SOCKET: {
    group: "Tailscale",
    order: 2,
    description:
      "Path to the Tailscale local API Unix socket. Optional.\n" +
      "Default: /var/run/tailscale/tailscaled.sock",
    example: "/var/run/tailscale/tailscaled.sock",
  },

  // ── Operational ───────────────────────────────────────────────────────────
};
