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
    ORG_MASTER_KEY: hex64,

    // --- Standard ---
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),

    // --- Production-required (validated in superRefine) ---
    VERIFIER_PEPPER_KEY: hex64.optional(),
    REDIS_URL: nonEmpty.optional(),

    // --- Auth.js core ---
    AUTH_SECRET: z.string().optional(),
    AUTH_URL: z
      .string()
      .refine(
        (s) => {
          try {
            new URL(s);
            return true;
          } catch {
            return false;
          }
        },
        { message: "Must be a valid URL" },
      )
      .optional(),

    // --- Auth providers (superRefine: at least one provider set in prod) ---
    AUTH_GOOGLE_ID: nonEmpty.optional(),
    AUTH_GOOGLE_SECRET: nonEmpty.optional(),
    AUTH_JACKSON_ID: nonEmpty.optional(),
    AUTH_JACKSON_SECRET: nonEmpty.optional(),
    JACKSON_URL: nonEmpty.optional(),
    GOOGLE_WORKSPACE_DOMAIN: z.string().optional(),
    SAML_PROVIDER_NAME: z.string().default("SSO"),

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

      if (!hasGoogle && !hasJackson) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AUTH_GOOGLE_ID"],
          message:
            "At least one auth provider must be configured in production: " +
            "Google (AUTH_GOOGLE_ID + AUTH_GOOGLE_SECRET) or " +
            "SAML Jackson (AUTH_JACKSON_ID + AUTH_JACKSON_SECRET + JACKSON_URL)",
        });
      }
    }

    // ── Conditional: Blob backend ───────────────────────────

    if (data.BLOB_BACKEND === "s3") {
      if (!data.AWS_REGION) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AWS_REGION"],
          message: "AWS_REGION is required when BLOB_BACKEND=s3",
        });
      }
      if (!data.S3_ATTACHMENTS_BUCKET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["S3_ATTACHMENTS_BUCKET"],
          message: "S3_ATTACHMENTS_BUCKET is required when BLOB_BACKEND=s3",
        });
      }
    }

    if (data.BLOB_BACKEND === "azure") {
      if (!data.AZURE_STORAGE_ACCOUNT) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AZURE_STORAGE_ACCOUNT"],
          message:
            "AZURE_STORAGE_ACCOUNT is required when BLOB_BACKEND=azure",
        });
      }
      if (!data.AZURE_BLOB_CONTAINER) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AZURE_BLOB_CONTAINER"],
          message:
            "AZURE_BLOB_CONTAINER is required when BLOB_BACKEND=azure",
        });
      }
      if (
        !data.AZURE_STORAGE_CONNECTION_STRING &&
        !data.AZURE_STORAGE_SAS_TOKEN
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AZURE_STORAGE_CONNECTION_STRING"],
          message:
            "AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_SAS_TOKEN " +
            "is required when BLOB_BACKEND=azure",
        });
      }
    }

    if (data.BLOB_BACKEND === "gcs") {
      if (!data.GCS_ATTACHMENTS_BUCKET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["GCS_ATTACHMENTS_BUCKET"],
          message:
            "GCS_ATTACHMENTS_BUCKET is required when BLOB_BACKEND=gcs",
        });
      }
    }
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
