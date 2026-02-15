import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Each test uses vi.resetModules() + dynamic import to re-evaluate
 * the module-level parseEnv() call in env.ts with fresh process.env.
 */

const originalEnv = { ...process.env };

/** Minimal dev env that passes validation. */
function setMinimalDevEnv() {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  process.env.ORG_MASTER_KEY = "a".repeat(64);
  process.env.NODE_ENV = "development";
}

/** Full production env that passes all checks. */
function setFullProdEnv() {
  process.env.DATABASE_URL = "postgresql://prod:prod@db:5432/passwd";
  process.env.ORG_MASTER_KEY = "a".repeat(64);
  process.env.NODE_ENV = "production";
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
    expect(env.ORG_MASTER_KEY).toBe("a".repeat(64));
    expect(env.NODE_ENV).toBe("development");
    // Defaults
    expect(env.BLOB_BACKEND).toBe("db");
    expect(env.AUDIT_LOG_FORWARD).toBe(false);
    expect(env.AUDIT_LOG_APP_NAME).toBe("passwd-sso");
    expect(env.SAML_PROVIDER_NAME).toBe("SSO");
    expect(env.BLOB_OBJECT_PREFIX).toBe("");
  });

  it("throws when DATABASE_URL is missing", async () => {
    process.env.ORG_MASTER_KEY = "a".repeat(64);
    delete process.env.DATABASE_URL;
    await expect(import("@/lib/env")).rejects.toThrow("DATABASE_URL");
  });

  it("throws when ORG_MASTER_KEY is not 64-char hex", async () => {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.ORG_MASTER_KEY = "too-short";
    await expect(import("@/lib/env")).rejects.toThrow("ORG_MASTER_KEY");
  });

  it("trims whitespace from ORG_MASTER_KEY", async () => {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.ORG_MASTER_KEY = `  ${"a".repeat(64)}  `;
    const { env } = await import("@/lib/env");
    expect(env.ORG_MASTER_KEY).toBe("a".repeat(64));
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
    process.env.ORG_MASTER_KEY = "a".repeat(64);
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
    process.env.ORG_MASTER_KEY = "g".repeat(64); // 'g' is not hex
    await expect(import("@/lib/env")).rejects.toThrow("ORG_MASTER_KEY");
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

  // ─── Error aggregation ─────────────────────────────────

  it("reports all errors at once", async () => {
    // Missing both critical vars
    delete process.env.DATABASE_URL;
    delete process.env.ORG_MASTER_KEY;
    try {
      await import("@/lib/env");
      expect.fail("Should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("DATABASE_URL");
      expect(message).toContain("ORG_MASTER_KEY");
    }
  });
});
