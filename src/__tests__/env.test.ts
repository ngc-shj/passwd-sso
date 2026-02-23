import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Each test uses vi.resetModules() + dynamic import to re-evaluate
 * the module-level parseEnv() call in env.ts with fresh process.env.
 */

const originalEnv = { ...process.env };

/** Minimal dev env that passes validation. */
function setMinimalDevEnv() {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  process.env.SHARE_MASTER_KEY = "a".repeat(64);
  (process.env as Record<string, string | undefined>).NODE_ENV = "development";
}

/** Full production env that passes all checks. */
function setFullProdEnv() {
  process.env.DATABASE_URL = "postgresql://prod:prod@db:5432/passwd";
  process.env.SHARE_MASTER_KEY = "a".repeat(64);
  (process.env as Record<string, string | undefined>).NODE_ENV = "production";
  process.env.VERIFIER_PEPPER_KEY = "b".repeat(64);
  process.env.REDIS_URL = "redis://redis:6379";
  process.env.AUTH_SECRET = "x".repeat(32);
  process.env.AUTH_URL = "https://app.example.com";
  process.env.AUTH_GOOGLE_ID = "google-id";
  process.env.AUTH_GOOGLE_SECRET = "google-secret";
}

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
}

describe("env validation", () => {
  beforeEach(() => {
    vi.resetModules();
    resetEnv();
  });

  afterEach(() => {
    resetEnv();
  });

  // ─── Basic validation ───────────────────────────────────

  it("parses valid minimal dev config", async () => {
    setMinimalDevEnv();
    const { env } = await import("@/lib/env");
    expect(env.DATABASE_URL).toBe(
      "postgresql://test:test@localhost:5432/test",
    );
    expect(env.SHARE_MASTER_KEY).toBe("a".repeat(64));
    expect(env.NODE_ENV).toBe("development");
    // Defaults
    expect(env.BLOB_BACKEND).toBe("db");
    expect(env.AUDIT_LOG_FORWARD).toBe(false);
    expect(env.AUDIT_LOG_APP_NAME).toBe("passwd-sso");
    expect(env.SAML_PROVIDER_NAME).toBe("SSO");
    expect(env.BLOB_OBJECT_PREFIX).toBe("");
  });

  it("throws when DATABASE_URL is missing", async () => {
    process.env.SHARE_MASTER_KEY = "a".repeat(64);
    delete process.env.DATABASE_URL;
    await expect(import("@/lib/env")).rejects.toThrow("DATABASE_URL");
  });

  it("throws when SHARE_MASTER_KEY is not 64-char hex", async () => {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.SHARE_MASTER_KEY = "too-short";
    await expect(import("@/lib/env")).rejects.toThrow("SHARE_MASTER_KEY");
  });

  it("trims whitespace from SHARE_MASTER_KEY", async () => {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.SHARE_MASTER_KEY = `  ${"a".repeat(64)}  `;
    const { env } = await import("@/lib/env");
    expect(env.SHARE_MASTER_KEY).toBe("a".repeat(64));
  });

  // ─── Production checks ─────────────────────────────────

  it("requires VERIFIER_PEPPER_KEY in production", async () => {
    setFullProdEnv();
    delete process.env.VERIFIER_PEPPER_KEY;
    await expect(import("@/lib/env")).rejects.toThrow("VERIFIER_PEPPER_KEY");
  });

  it("requires REDIS_URL in production", async () => {
    setFullProdEnv();
    delete process.env.REDIS_URL;
    await expect(import("@/lib/env")).rejects.toThrow("REDIS_URL");
  });

  it("requires AUTH_SECRET in production", async () => {
    setFullProdEnv();
    delete process.env.AUTH_SECRET;
    await expect(import("@/lib/env")).rejects.toThrow("AUTH_SECRET");
  });

  it("rejects AUTH_SECRET shorter than 32 chars in production", async () => {
    setFullProdEnv();
    process.env.AUTH_SECRET = "short";
    await expect(import("@/lib/env")).rejects.toThrow("AUTH_SECRET");
  });

  it("requires AUTH_URL in production", async () => {
    setFullProdEnv();
    delete process.env.AUTH_URL;
    await expect(import("@/lib/env")).rejects.toThrow("AUTH_URL");
  });

  // ─── Auth provider checks ──────────────────────────────

  it("throws when no auth provider is configured in production", async () => {
    setFullProdEnv();
    delete process.env.AUTH_GOOGLE_ID;
    delete process.env.AUTH_GOOGLE_SECRET;
    delete process.env.AUTH_JACKSON_ID;
    delete process.env.AUTH_JACKSON_SECRET;
    delete process.env.JACKSON_URL;
    await expect(import("@/lib/env")).rejects.toThrow(
      "At least one auth provider",
    );
  });

  it("passes with Google only in production", async () => {
    setFullProdEnv();
    // Google is set, Jackson is not
    delete process.env.AUTH_JACKSON_ID;
    delete process.env.AUTH_JACKSON_SECRET;
    delete process.env.JACKSON_URL;
    const { env } = await import("@/lib/env");
    expect(env.NODE_ENV).toBe("production");
    expect(env.AUTH_GOOGLE_ID).toBe("google-id");
  });

  it("passes with Jackson only in production", async () => {
    setFullProdEnv();
    // Remove Google, add Jackson
    delete process.env.AUTH_GOOGLE_ID;
    delete process.env.AUTH_GOOGLE_SECRET;
    process.env.AUTH_JACKSON_ID = "jackson-id";
    process.env.AUTH_JACKSON_SECRET = "jackson-secret";
    process.env.JACKSON_URL = "http://jackson:5225";
    const { env } = await import("@/lib/env");
    expect(env.NODE_ENV).toBe("production");
    expect(env.AUTH_JACKSON_ID).toBe("jackson-id");
  });

  // ─── Blob backend conditional checks ───────────────────

  it("requires S3 vars when BLOB_BACKEND=s3", async () => {
    setMinimalDevEnv();
    process.env.BLOB_BACKEND = "s3";
    await expect(import("@/lib/env")).rejects.toThrow("AWS_REGION");
  });

  it("requires Azure vars when BLOB_BACKEND=azure", async () => {
    setMinimalDevEnv();
    process.env.BLOB_BACKEND = "azure";
    await expect(import("@/lib/env")).rejects.toThrow(
      "AZURE_STORAGE_ACCOUNT",
    );
  });

  it("requires GCS vars when BLOB_BACKEND=gcs", async () => {
    setMinimalDevEnv();
    process.env.BLOB_BACKEND = "gcs";
    await expect(import("@/lib/env")).rejects.toThrow(
      "GCS_ATTACHMENTS_BUCKET",
    );
  });

  // ─── Whitespace and format checks ──────────────────────

  it("rejects whitespace-only DATABASE_URL", async () => {
    process.env.DATABASE_URL = "   ";
    process.env.SHARE_MASTER_KEY = "a".repeat(64);
    await expect(import("@/lib/env")).rejects.toThrow("DATABASE_URL");
  });

  it("rejects invalid AUTH_URL format in production", async () => {
    setFullProdEnv();
    process.env.AUTH_URL = "not-a-url";
    await expect(import("@/lib/env")).rejects.toThrow("AUTH_URL");
  });

  it("trims whitespace from VERIFIER_PEPPER_KEY", async () => {
    setFullProdEnv();
    process.env.VERIFIER_PEPPER_KEY = `  ${"b".repeat(64)}  `;
    const { env } = await import("@/lib/env");
    expect(env.VERIFIER_PEPPER_KEY).toBe("b".repeat(64));
  });

  it("rejects hex64 with non-hex characters", async () => {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.SHARE_MASTER_KEY = "g".repeat(64); // 'g' is not hex
    await expect(import("@/lib/env")).rejects.toThrow("SHARE_MASTER_KEY");
  });

  // ─── Transforms and defaults ───────────────────────────

  it("transforms AUDIT_LOG_FORWARD to boolean true", async () => {
    setMinimalDevEnv();
    process.env.AUDIT_LOG_FORWARD = "true";
    const { env } = await import("@/lib/env");
    expect(env.AUDIT_LOG_FORWARD).toBe(true);
  });

  it("transforms AUDIT_LOG_FORWARD to boolean false by default", async () => {
    setMinimalDevEnv();
    delete process.env.AUDIT_LOG_FORWARD;
    const { env } = await import("@/lib/env");
    expect(env.AUDIT_LOG_FORWARD).toBe(false);
  });

  it("accepts valid full production config", async () => {
    setFullProdEnv();
    const { env } = await import("@/lib/env");
    expect(env.NODE_ENV).toBe("production");
    expect(env.VERIFIER_PEPPER_KEY).toBe("b".repeat(64));
    expect(env.REDIS_URL).toBe("redis://redis:6379");
    expect(env.AUTH_SECRET).toBe("x".repeat(32));
    expect(env.AUTH_URL).toBe("https://app.example.com");
  });

  // ─── DB pool variable defaults ─────────────────────────

  it("applies pool variable defaults in dev config", async () => {
    setMinimalDevEnv();
    const { env } = await import("@/lib/env");
    expect(env.DB_POOL_MAX).toBe(20);
    expect(env.DB_POOL_CONNECTION_TIMEOUT_MS).toBe(5000);
    expect(env.DB_POOL_IDLE_TIMEOUT_MS).toBe(30000);
    expect(env.DB_POOL_MAX_LIFETIME_SECONDS).toBe(1800);
    expect(env.DB_POOL_STATEMENT_TIMEOUT_MS).toBe(30000);
  });

  it("accepts custom pool variable values", async () => {
    setMinimalDevEnv();
    process.env.DB_POOL_MAX = "50";
    process.env.DB_POOL_CONNECTION_TIMEOUT_MS = "10000";
    process.env.DB_POOL_IDLE_TIMEOUT_MS = "60000";
    process.env.DB_POOL_MAX_LIFETIME_SECONDS = "3600";
    process.env.DB_POOL_STATEMENT_TIMEOUT_MS = "15000";
    const { env } = await import("@/lib/env");
    expect(env.DB_POOL_MAX).toBe(50);
    expect(env.DB_POOL_CONNECTION_TIMEOUT_MS).toBe(10000);
    expect(env.DB_POOL_IDLE_TIMEOUT_MS).toBe(60000);
    expect(env.DB_POOL_MAX_LIFETIME_SECONDS).toBe(3600);
    expect(env.DB_POOL_STATEMENT_TIMEOUT_MS).toBe(15000);
  });

  it("rejects non-numeric DB_POOL_MAX", async () => {
    setMinimalDevEnv();
    process.env.DB_POOL_MAX = "abc";
    await expect(import("@/lib/env")).rejects.toThrow("DB_POOL_MAX");
  });

  it("rejects DB_POOL_MAX below minimum (0)", async () => {
    setMinimalDevEnv();
    process.env.DB_POOL_MAX = "0";
    await expect(import("@/lib/env")).rejects.toThrow("DB_POOL_MAX");
  });

  it("rejects DB_POOL_MAX above maximum (201)", async () => {
    setMinimalDevEnv();
    process.env.DB_POOL_MAX = "201";
    await expect(import("@/lib/env")).rejects.toThrow("DB_POOL_MAX");
  });

  it("rejects DB_POOL_CONNECTION_TIMEOUT_MS above maximum", async () => {
    setMinimalDevEnv();
    process.env.DB_POOL_CONNECTION_TIMEOUT_MS = "60001";
    await expect(import("@/lib/env")).rejects.toThrow(
      "DB_POOL_CONNECTION_TIMEOUT_MS",
    );
  });

  it("rejects DB_POOL_IDLE_TIMEOUT_MS above maximum", async () => {
    setMinimalDevEnv();
    process.env.DB_POOL_IDLE_TIMEOUT_MS = "600001";
    await expect(import("@/lib/env")).rejects.toThrow(
      "DB_POOL_IDLE_TIMEOUT_MS",
    );
  });

  it("rejects DB_POOL_MAX_LIFETIME_SECONDS above maximum", async () => {
    setMinimalDevEnv();
    process.env.DB_POOL_MAX_LIFETIME_SECONDS = "86401";
    await expect(import("@/lib/env")).rejects.toThrow(
      "DB_POOL_MAX_LIFETIME_SECONDS",
    );
  });

  it("rejects DB_POOL_STATEMENT_TIMEOUT_MS above maximum", async () => {
    setMinimalDevEnv();
    process.env.DB_POOL_STATEMENT_TIMEOUT_MS = "300001";
    await expect(import("@/lib/env")).rejects.toThrow(
      "DB_POOL_STATEMENT_TIMEOUT_MS",
    );
  });

  // ─── Error aggregation ─────────────────────────────────

  it("reports all errors at once", async () => {
    // Missing critical var
    delete process.env.DATABASE_URL;
    try {
      await import("@/lib/env");
      expect.fail("Should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("DATABASE_URL");
    }
  });

  it("requires SHARE_MASTER_KEY or SHARE_MASTER_KEY_V1 for V1", async () => {
    setMinimalDevEnv();
    delete process.env.SHARE_MASTER_KEY;
    delete process.env.SHARE_MASTER_KEY_V1;
    try {
      await import("@/lib/env");
      expect.fail("Should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("SHARE_MASTER_KEY");
    }
  });

  it("accepts SHARE_MASTER_KEY_V1 without SHARE_MASTER_KEY", async () => {
    setMinimalDevEnv();
    delete process.env.SHARE_MASTER_KEY;
    process.env.SHARE_MASTER_KEY_V1 = "b".repeat(64);
    const { env } = await import("@/lib/env");
    expect(env.SHARE_MASTER_KEY).toBeUndefined();
  });

  // ─── V2+ key rotation scenarios ──────────────────────────

  it("accepts CURRENT_VERSION=2 with V2 key", async () => {
    setMinimalDevEnv();
    process.env.SHARE_MASTER_KEY_CURRENT_VERSION = "2";
    process.env.SHARE_MASTER_KEY_V2 = "c".repeat(64);
    const { env } = await import("@/lib/env");
    expect(env.SHARE_MASTER_KEY_CURRENT_VERSION).toBe(2);
  });

  it("throws when CURRENT_VERSION=2 but V2 key is missing", async () => {
    setMinimalDevEnv();
    process.env.SHARE_MASTER_KEY_CURRENT_VERSION = "2";
    await expect(import("@/lib/env")).rejects.toThrow("SHARE_MASTER_KEY_V2");
  });

  it("throws when CURRENT_VERSION=2 and V2 key is invalid hex", async () => {
    setMinimalDevEnv();
    process.env.SHARE_MASTER_KEY_CURRENT_VERSION = "2";
    process.env.SHARE_MASTER_KEY_V2 = "not-hex-at-all";
    await expect(import("@/lib/env")).rejects.toThrow("SHARE_MASTER_KEY_V2");
  });

  it("defaults CURRENT_VERSION to 1 when not set", async () => {
    setMinimalDevEnv();
    delete process.env.SHARE_MASTER_KEY_CURRENT_VERSION;
    const { env } = await import("@/lib/env");
    expect(env.SHARE_MASTER_KEY_CURRENT_VERSION).toBe(1);
  });

  it("throws when CURRENT_VERSION exceeds max (101)", async () => {
    setMinimalDevEnv();
    process.env.SHARE_MASTER_KEY_CURRENT_VERSION = "101";
    await expect(import("@/lib/env")).rejects.toThrow(
      "SHARE_MASTER_KEY_CURRENT_VERSION"
    );
  });
});
