/**
 * Environment variable SCHEMAS — side-effect-free.
 *
 * This module exports the Zod definitions ONLY — it does NOT run
 * parseEnv() at import time. Import from here when you need to validate
 * a subset of env vars (e.g. the audit-outbox worker via envObject.pick())
 * or when you need the raw ZodObject shape for the generator/drift-checker.
 *
 * For the singleton validated `env` (which DOES run parseEnv at import),
 * import from "@/lib/env" instead — that module has the side effect that
 * Next.js instrumentation relies on.
 *
 * Schema is split into two exports:
 *   envObject — plain ZodObject (pickable, iterable via .shape). Zod 4
 *               throws on .pick() of a refined schema, so the worker
 *               and tests MUST import envObject, not envSchema (F16).
 *   envSchema — envObject.superRefine(...) — adds cross-field production
 *               requirements. Used by parseEnv() at server boot.
 */

import { z } from "zod";
import { HEX64_RE } from "@/lib/validations/common";

// ─── Reusable validators ────────────────────────────────────

/** Non-empty string. Trims whitespace before checking length. */
const nonEmpty = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1));

/** 64-char hex string (256-bit key). Trims whitespace before validation. */
const hex64 = z
  .string()
  .transform((s) => s.trim())
  .pipe(
    z
      .string()
      .regex(HEX64_RE, "Must be a 64-character hex string (256 bits)"),
  );

// ─── Schema ─────────────────────────────────────────────────

export const envObject = z.object({
  // --- Worker process (A29) ---
  // Dedicated DB URL for the audit-outbox worker; falls back to DATABASE_URL.
  OUTBOX_WORKER_DATABASE_URL: z
    .string()
    .transform((s) => s.trim())
    .pipe(
      z.string().refine(
        (s) => {
          try {
            new URL(s);
            return true;
          } catch {
            return false;
          }
        },
        { message: "OUTBOX_WORKER_DATABASE_URL must be a valid URL" },
      ),
    )
    .optional(),

  // --- DCR cleanup worker ---
  // Dedicated DB URL for the dcr-cleanup worker role; falls back to DATABASE_URL.
  DCR_CLEANUP_DATABASE_URL: z
    .string()
    .transform((s) => s.trim())
    .pipe(
      z.string().refine(
        (s) => {
          try {
            new URL(s);
            return true;
          } catch {
            return false;
          }
        },
        { message: "DCR_CLEANUP_DATABASE_URL must be a valid URL" },
      ),
    )
    .optional(),
  DCR_CLEANUP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(3_600_000),
  DCR_CLEANUP_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(1000),
  DCR_CLEANUP_EMIT_HEARTBEAT_AUDIT: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // --- Critical (always required) ---
  DATABASE_URL: nonEmpty,
  // SUPERUSER URL for Prisma CLI (migrate, studio). Optional — falls back to DATABASE_URL.
  MIGRATION_DATABASE_URL: z
    .string()
    .transform((s) => s.trim())
    .pipe(
      z.string().refine(
        (s) => {
          try {
            new URL(s);
            return true;
          } catch {
            return false;
          }
        },
        { message: "MIGRATION_DATABASE_URL must be a valid URL" },
      ),
    )
    .optional(),
  SHARE_MASTER_KEY: hex64.optional(),

  // --- Key rotation ---
  // V1..V10 modeled explicitly (D6-split F16+S4). V11..V100 fall through to
  // process.env[...] in superRefine — the variadic regex-pattern allowlist
  // in scripts/env-allowlist.ts documents this exception.
  // CURRENT_VERSION.max stays 100 to preserve boot compatibility (F17/NF-5).
  SHARE_MASTER_KEY_V1: hex64.optional(),
  SHARE_MASTER_KEY_V2: hex64.optional(),
  SHARE_MASTER_KEY_V3: hex64.optional(),
  SHARE_MASTER_KEY_V4: hex64.optional(),
  SHARE_MASTER_KEY_V5: hex64.optional(),
  SHARE_MASTER_KEY_V6: hex64.optional(),
  SHARE_MASTER_KEY_V7: hex64.optional(),
  SHARE_MASTER_KEY_V8: hex64.optional(),
  SHARE_MASTER_KEY_V9: hex64.optional(),
  SHARE_MASTER_KEY_V10: hex64.optional(),
  SHARE_MASTER_KEY_CURRENT_VERSION: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(1),

  // --- Standard ---
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // --- Production-required (validated in superRefine) ---
  VERIFIER_PEPPER_KEY: hex64.optional(),
  // V2..V10 modeled explicitly. V11..V100 fall through to process.env[...] via
  // allowlist regex in scripts/env-allowlist.ts (same pattern as SHARE_MASTER_KEY_V*).
  VERIFIER_PEPPER_KEY_V2: hex64.optional(),
  VERIFIER_PEPPER_KEY_V3: hex64.optional(),
  VERIFIER_PEPPER_KEY_V4: hex64.optional(),
  VERIFIER_PEPPER_KEY_V5: hex64.optional(),
  VERIFIER_PEPPER_KEY_V6: hex64.optional(),
  VERIFIER_PEPPER_KEY_V7: hex64.optional(),
  VERIFIER_PEPPER_KEY_V8: hex64.optional(),
  VERIFIER_PEPPER_KEY_V9: hex64.optional(),
  VERIFIER_PEPPER_KEY_V10: hex64.optional(),
  REDIS_URL: nonEmpty.optional(),

  // --- Application URL ---
  APP_URL: z
    .string()
    .transform((s) => s.trim())
    .pipe(
      z.string().refine(
        (s) => {
          try {
            new URL(s);
            return true;
          } catch {
            return false;
          }
        },
        { message: "Must be a valid URL" },
      ),
    )
    .optional(),

  // --- Reverse proxy / client IP extraction ---
  TRUSTED_PROXIES: z.string().optional(),
  TRUST_PROXY_HEADERS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // --- Auth.js core ---
  AUTH_SECRET: z.string().optional(),
  AUTH_URL: z
    .string()
    .transform((s) => s.trim())
    .pipe(
      z.string().refine(
        (s) => {
          try {
            new URL(s);
            return true;
          } catch {
            return false;
          }
        },
        { message: "Must be a valid URL" },
      ),
    )
    .optional(),
  // Legacy Auth.js v4 name; referenced as fallback in src/app/api/sessions/helpers.ts:10
  NEXTAUTH_URL: nonEmpty.optional(),

  // --- Auth providers (superRefine: at least one provider set in prod) ---
  AUTH_GOOGLE_ID: nonEmpty.optional(),
  AUTH_GOOGLE_SECRET: nonEmpty.optional(),
  AUTH_JACKSON_ID: nonEmpty.optional(),
  AUTH_JACKSON_SECRET: nonEmpty.optional(),
  JACKSON_URL: nonEmpty.optional(),
  GOOGLE_WORKSPACE_DOMAINS: z.string().optional(),
  AUTH_TENANT_CLAIM_KEYS: z.string().optional(),
  SAML_PROVIDER_NAME: z.string().default("SSO"),

  // --- Email (Magic Link / Resend / SMTP) ---
  EMAIL_PROVIDER: z.enum(["resend", "smtp"]).optional(),
  EMAIL_FROM: z.string().optional(),
  RESEND_API_KEY: nonEmpty.optional(),
  SMTP_HOST: nonEmpty.optional(),
  // NF-5 F22: empty-string SMTP_PORT now rejects at boot (previously → NaN).
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),

  // --- Optional with defaults ---
  CSP_MODE: z.enum(["strict", "dev"]).optional(),
  BLOB_BACKEND: z.enum(["db", "s3", "azure", "gcs"]).default("db"),
  BLOB_OBJECT_PREFIX: z.string().default(""),
  AUDIT_LOG_FORWARD: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  AUDIT_LOG_APP_NAME: z.string().default("passwd-sso"),

  // --- Conditional: Cloud blob storage ---
  AWS_REGION: nonEmpty.optional(),
  S3_ATTACHMENTS_BUCKET: nonEmpty.optional(),
  AZURE_STORAGE_ACCOUNT: nonEmpty.optional(),
  AZURE_BLOB_CONTAINER: nonEmpty.optional(),
  AZURE_STORAGE_CONNECTION_STRING: nonEmpty.optional(),
  AZURE_STORAGE_SAS_TOKEN: nonEmpty.optional(),
  GCS_ATTACHMENTS_BUCKET: nonEmpty.optional(),

  // --- WebAuthn ---
  WEBAUTHN_RP_ID: z.string().optional().default(""),
  WEBAUTHN_RP_NAME: z.string().optional(),
  WEBAUTHN_RP_ORIGIN: nonEmpty.optional(),
  WEBAUTHN_PRF_SECRET: hex64.optional(),

  // --- Directory Sync ---
  DIRECTORY_SYNC_MASTER_KEY: hex64.optional(),

  // --- Public REST API ---
  OPENAPI_PUBLIC: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // --- Key provider ---
  KEY_PROVIDER: z.string().default("env"),
  SM_CACHE_TTL_MS: z.coerce.number().int().min(10000).max(3600000).optional(),
  // Cloud provider endpoints — conditionally required via superRefine.
  AZURE_KV_URL: nonEmpty.optional(),
  GCP_PROJECT_ID: nonEmpty.optional(),

  // --- Redis Sentinel (HA overlay) ---
  REDIS_SENTINEL: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  REDIS_SENTINEL_HOSTS: z.string().optional(),
  REDIS_SENTINEL_MASTER_NAME: z.string().default("mymaster"),
  REDIS_SENTINEL_PASSWORD: z.string().optional(),
  REDIS_SENTINEL_TLS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // --- Audit outbox worker tuning (A20-A28) ---
  // Defaults match src/lib/constants/audit/audit.ts envInt(...) calls.
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(10000).default(500),
  OUTBOX_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60000)
    .default(1000),
  OUTBOX_PROCESSING_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(10000)
    .max(3600000)
    .default(300000),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(8),
  OUTBOX_RETENTION_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  OUTBOX_FAILED_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3650)
    .default(90),
  OUTBOX_READY_PENDING_THRESHOLD: z.coerce.number().int().min(100).default(10000),
  OUTBOX_READY_OLDEST_THRESHOLD_SECS: z.coerce
    .number()
    .int()
    .min(30)
    .max(86400)
    .default(600),
  OUTBOX_REAPER_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(5000)
    .max(3600000)
    .default(30000),

  // --- Logger (A1) ---
  // pino log levels. Production debug/trace ban DEFERRED to follow-up PR (S15).
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),

  // --- Health check (A2) ---
  // Default STAYS "false" — see NF-5 / S3. Unset → degraded-but-available.
  HEALTH_REDIS_REQUIRED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // --- Operational (A12-A14) ---
  TAILSCALE_API_BASE: z.string().optional(),
  TAILSCALE_SOCKET: z.string().optional(),
  // SENTRY_DSN public-key segment is project-sensitive — sidecar marks secret: true.
  SENTRY_DSN: z.string().optional(),

  // --- Public (client-inlined, A30-A33) ---
  // Next.js inlines NEXT_PUBLIC_* into the client bundle at build time.
  // Server-side defaults are a safety net; consumer-side `??` fallbacks
  // MUST be preserved (F20/NF-5) because the client cannot observe the
  // server-side Zod default.
  NEXT_PUBLIC_APP_NAME: z.string().default("passwd-sso"),
  NEXT_PUBLIC_BASE_PATH: z.string().default(""),
  NEXT_PUBLIC_CHROME_STORE_URL: z.string().optional(),
  NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),

  // --- DB connection pool tuning (optional) ---
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  DB_POOL_CONNECTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(60000)
    .default(5000),
  DB_POOL_IDLE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(600000)
    .default(30000),
  DB_POOL_MAX_LIFETIME_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(86400)
    .default(1800),
  DB_POOL_STATEMENT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(300000)
    .default(30000),
});

// envSchema — envObject with cross-field superRefine rules. Refined schemas
// cannot be .pick()'d in Zod 4 (F16), so tests and the worker MUST import
// envObject, not envSchema.
export const envSchema = envObject.superRefine((data, ctx) => {
  const isProd = data.NODE_ENV === "production";

  // ── Production-required checks ──────────────────────────

  if (isProd) {
    if (!data.AUTH_SECRET || data.AUTH_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AUTH_SECRET"],
        message:
          "AUTH_SECRET is required in production (minimum 32 characters)",
      });
    }

    if (!data.AUTH_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AUTH_URL"],
        message: "AUTH_URL is required in production",
      });
    }

    if (!data.VERIFIER_PEPPER_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["VERIFIER_PEPPER_KEY"],
        message: "VERIFIER_PEPPER_KEY is required in production",
      });
    }

    if (!data.REDIS_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["REDIS_URL"],
        message: "REDIS_URL is required in production for rate limiting",
      });
    }

    // At least one auth provider must be fully configured
    const hasGoogle = !!(data.AUTH_GOOGLE_ID && data.AUTH_GOOGLE_SECRET);
    const hasJackson = !!(
      data.AUTH_JACKSON_ID &&
      data.AUTH_JACKSON_SECRET &&
      data.JACKSON_URL
    );
    const hasEmail = !!data.EMAIL_PROVIDER;

    if (!hasGoogle && !hasJackson && !hasEmail) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AUTH_GOOGLE_ID"],
        message:
          "At least one auth provider must be configured in production: " +
          "Google (AUTH_GOOGLE_ID + AUTH_GOOGLE_SECRET), " +
          "SAML Jackson (AUTH_JACKSON_ID + AUTH_JACKSON_SECRET + JACKSON_URL), or " +
          "Email (EMAIL_PROVIDER)",
      });
    }

    // SMTP_HOST required when EMAIL_PROVIDER=smtp in production.
    // SMTP_HOST is now a first-class field (A6) — no more process.env escape hatch (D6).
    if (data.EMAIL_PROVIDER === "smtp" && !data.SMTP_HOST) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SMTP_HOST"],
        message:
          "SMTP_HOST is required when EMAIL_PROVIDER=smtp in production",
      });
    }

    // RESEND_API_KEY required when EMAIL_PROVIDER=resend in production (A5).
    if (data.EMAIL_PROVIDER === "resend" && !data.RESEND_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RESEND_API_KEY"],
        message:
          "RESEND_API_KEY is required when EMAIL_PROVIDER=resend in production",
      });
    }
  }

  // ── Cloud key provider requirements (A10-A11, always enforced) ──
  if (data.KEY_PROVIDER === "azure-kv" && !data.AZURE_KV_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["AZURE_KV_URL"],
      message: "AZURE_KV_URL is required when KEY_PROVIDER=azure-kv",
    });
  }
  if (data.KEY_PROVIDER === "gcp-sm" && !data.GCP_PROJECT_ID) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["GCP_PROJECT_ID"],
      message: "GCP_PROJECT_ID is required when KEY_PROVIDER=gcp-sm",
    });
  }

  // ── Redis Sentinel requirements (A15-A19) ──
  if (data.REDIS_SENTINEL && !data.REDIS_SENTINEL_HOSTS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["REDIS_SENTINEL_HOSTS"],
      message:
        "REDIS_SENTINEL_HOSTS is required when REDIS_SENTINEL=true (comma-separated host:port pairs)",
    });
  }

  // ── Key rotation: current version key must exist (env provider only) ───────
  const currentVersion = data.SHARE_MASTER_KEY_CURRENT_VERSION;
  if (data.KEY_PROVIDER === "env") {
    if (currentVersion === 1) {
      const v1Key = data.SHARE_MASTER_KEY_V1 ?? data.SHARE_MASTER_KEY;
      if (!v1Key || !HEX64_RE.test(v1Key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["SHARE_MASTER_KEY"],
          message:
            "SHARE_MASTER_KEY or SHARE_MASTER_KEY_V1 is required (64-char hex)",
        });
      }
    } else if (currentVersion >= 2 && currentVersion <= 10) {
      // V2..V10: schema-resident fields (D6-split S4 Option a).
      const vMap: Record<number, string | undefined> = {
        2: data.SHARE_MASTER_KEY_V2,
        3: data.SHARE_MASTER_KEY_V3,
        4: data.SHARE_MASTER_KEY_V4,
        5: data.SHARE_MASTER_KEY_V5,
        6: data.SHARE_MASTER_KEY_V6,
        7: data.SHARE_MASTER_KEY_V7,
        8: data.SHARE_MASTER_KEY_V8,
        9: data.SHARE_MASTER_KEY_V9,
        10: data.SHARE_MASTER_KEY_V10,
      };
      const vNKey = vMap[currentVersion];
      if (!vNKey || !HEX64_RE.test(vNKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["SHARE_MASTER_KEY_CURRENT_VERSION"],
          message: `SHARE_MASTER_KEY_V${currentVersion} is required (64-char hex) when CURRENT_VERSION=${currentVersion}`,
        });
      }
    } else {
      // V11..V100: documented exception — falls through to process.env[...]
      // with allowlist-regex coverage in scripts/env-allowlist.ts.
      const vNRaw = process.env[`SHARE_MASTER_KEY_V${currentVersion}`];
      const vNKey = vNRaw?.trim();
      if (!vNKey || !HEX64_RE.test(vNKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["SHARE_MASTER_KEY_CURRENT_VERSION"],
          message: `SHARE_MASTER_KEY_V${currentVersion} is required (64-char hex) when CURRENT_VERSION=${currentVersion}`,
        });
      }
    }
  }

  // Blob backend and key provider validation is delegated to each
  // provider's own validateConfig()/validateKeys() — no vendor-specific
  // checks here. See:
  //   - src/lib/blob-store/config.ts (blob backend)
  //   - src/lib/key-provider/*.ts (key provider)
});

// ─── Type export ────────────────────────────────────────────

// Env is inferred from envObject (the ZodObject before superRefine) so that
// keyof Env resolves to the literal union of schema keys — required by the
// sidecar's Record<keyof z.infer<typeof envObject>, SidecarEntry> constraint.
export type Env = z.infer<typeof envObject>;

// Helper for drift-checker and generator: always returns the plain .shape,
// insulating callers from whether they hold envObject or envSchema.
export const getSchemaShape = () => envObject.shape;
