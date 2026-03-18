/**
 * Startup-time environment variable validation.
 *
 * Validates ALL env vars at server startup via Zod schema.
 * Imported by src/instrumentation.ts → register().
 *
 * Phase 1: Validation only. Existing process.env references are unchanged.
 * Phase 2 (future): Migrate consumers to import { env } from "@/lib/env".
 */

import { z } from "zod";

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
      .regex(
        /^[0-9a-fA-F]{64}$/,
        "Must be a 64-character hex string (256 bits)",
      ),
  );

// ─── Schema ─────────────────────────────────────────────────

const envSchema = z
  .object({
    // --- Critical (always required) ---
    DATABASE_URL: nonEmpty,
    SHARE_MASTER_KEY: hex64.optional(),

    // --- Key rotation ---
    SHARE_MASTER_KEY_CURRENT_VERSION: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(1),
    ADMIN_API_TOKEN: hex64.optional(),

    // --- Standard ---
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),

    // --- Production-required (validated in superRefine) ---
    VERIFIER_PEPPER_KEY: hex64.optional(),
    REDIS_URL: nonEmpty.optional(),

    // --- Application URL ---
    // External URL for reverse proxy deployments (e.g. https://public.example.com).
    // Takes priority over AUTH_URL for CORS, CSRF, SCIM, and server-side links.
    // Optional — falls back to AUTH_URL when not set.
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

    // --- Auth providers (superRefine: at least one provider set in prod) ---
    AUTH_GOOGLE_ID: nonEmpty.optional(),
    AUTH_GOOGLE_SECRET: nonEmpty.optional(),
    AUTH_JACKSON_ID: nonEmpty.optional(),
    AUTH_JACKSON_SECRET: nonEmpty.optional(),
    JACKSON_URL: nonEmpty.optional(),
    GOOGLE_WORKSPACE_DOMAINS: z.string().optional(),
    AUTH_TENANT_CLAIM_KEYS: z.string().optional(),
    SAML_PROVIDER_NAME: z.string().default("SSO"),

    // --- Email authentication (Magic Link) ---
    EMAIL_PROVIDER: z.enum(["resend", "smtp"]).optional(),

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
    // Vendor-specific validation is handled by each provider's validateKeys().
    KEY_PROVIDER: z.string().default("env"),
    SM_CACHE_TTL_MS: z.coerce.number().int().min(10000).max(3600000).optional(),

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
  })
  .superRefine((data, ctx) => {
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

      // SMTP_HOST required when EMAIL_PROVIDER=smtp in production
      if (data.EMAIL_PROVIDER === "smtp") {
        const smtpHost = process.env.SMTP_HOST?.trim();
        if (!smtpHost) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["EMAIL_PROVIDER"],
            message:
              "SMTP_HOST is required when EMAIL_PROVIDER=smtp in production",
          });
        }
      }
    }

    // ── Key rotation: current version key must exist (env provider only) ───────
    const currentVersion = data.SHARE_MASTER_KEY_CURRENT_VERSION;
    // Cloud providers (aws-sm, azure-kv, gcp-sm) manage keys externally
    if (data.KEY_PROVIDER === "env") {
      const hex64Re = /^[0-9a-fA-F]{64}$/;

      if (currentVersion === 1) {
        // V1: SHARE_MASTER_KEY_V1 or SHARE_MASTER_KEY must exist
        const v1Raw =
          process.env.SHARE_MASTER_KEY_V1 ?? process.env.SHARE_MASTER_KEY;
        const v1Key = v1Raw?.trim();
        if (!v1Key || !hex64Re.test(v1Key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["SHARE_MASTER_KEY"],
            message:
              "SHARE_MASTER_KEY or SHARE_MASTER_KEY_V1 is required (64-char hex)",
          });
        }
      } else {
        // V2+: SHARE_MASTER_KEY_V{N} must exist
        const vNRaw = process.env[`SHARE_MASTER_KEY_V${currentVersion}`];
        const vNKey = vNRaw?.trim();
        if (!vNKey || !hex64Re.test(vNKey)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["SHARE_MASTER_KEY_CURRENT_VERSION"],
            message: `SHARE_MASTER_KEY_V${currentVersion} is required (64-char hex) when CURRENT_VERSION=${currentVersion}`,
          });
        }
      }
    }

    // Production: ADMIN_API_TOKEN required when key rotation is enabled
    if (isProd && currentVersion >= 2 && !data.ADMIN_API_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ADMIN_API_TOKEN"],
        message:
          "ADMIN_API_TOKEN is required in production when SHARE_MASTER_KEY_CURRENT_VERSION >= 2",
      });
    }

    // Blob backend and key provider validation is delegated to each
    // provider's own validateConfig()/validateKeys() — no vendor-specific
    // checks in env.ts. See:
    //   - src/lib/blob-store/config.ts (blob backend)
    //   - src/lib/key-provider/*.ts (key provider)
  });

// ─── Type export ────────────────────────────────────────────

export type Env = z.infer<typeof envSchema>;

// ─── Parse and validate ─────────────────────────────────────

function parseEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    const banner =
      "\n" +
      "=".repeat(60) +
      "\n" +
      " ENVIRONMENT VARIABLE VALIDATION FAILED\n" +
      "=".repeat(60) +
      "\n" +
      formatted +
      "\n" +
      "=".repeat(60);

    // Log to stderr for visibility in container logs
    console.error(banner);

    throw new Error(`Invalid environment variables:\n${formatted}`);
  }

  return result.data;
}

// ─── Singleton ──────────────────────────────────────────────

export const env = parseEnv();
