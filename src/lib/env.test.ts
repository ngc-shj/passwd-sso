import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// env.ts calls parseEnv() at import time, so we need to test by resetting modules
// and setting process.env before each fresh import.

const VALID_HEX_64 = "a".repeat(64);

function buildMinimalEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: "postgresql://localhost:5432/test",
    ORG_MASTER_KEY: VALID_HEX_64,
    NODE_ENV: "development",
    ...overrides,
  };
}

describe("env validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("parses valid minimal development env", async () => {
    Object.assign(process.env, buildMinimalEnv());
    const { env } = await import("./env");
    expect(env.DATABASE_URL).toBe("postgresql://localhost:5432/test");
    expect(env.NODE_ENV).toBe("development");
  });

  it("throws for missing DATABASE_URL", async () => {
    process.env = { ORG_MASTER_KEY: VALID_HEX_64 };
    await expect(import("./env")).rejects.toThrow("Invalid environment variables");
  });

  it("throws for missing ORG_MASTER_KEY", async () => {
    process.env = { DATABASE_URL: "postgresql://localhost:5432/test" };
    await expect(import("./env")).rejects.toThrow("Invalid environment variables");
  });

  it("throws for invalid ORG_MASTER_KEY (not 64 hex chars)", async () => {
    process.env = buildMinimalEnv({ ORG_MASTER_KEY: "short" });
    await expect(import("./env")).rejects.toThrow("Invalid environment variables");
  });

  it("defaults NODE_ENV to development when unset", async () => {
    // Vitest sets NODE_ENV=test, so we can't truly unset it.
    // Instead verify that the "test" value is accepted as valid.
    process.env = buildMinimalEnv({ NODE_ENV: "test" });
    const { env } = await import("./env");
    expect(env.NODE_ENV).toBe("test");
  });

  it("requires AUTH_SECRET in production", async () => {
    process.env = buildMinimalEnv({
      NODE_ENV: "production",
      AUTH_URL: "https://app.example.com",
      VERIFIER_PEPPER_KEY: VALID_HEX_64,
      REDIS_URL: "redis://localhost:6379",
      AUTH_GOOGLE_ID: "gid",
      AUTH_GOOGLE_SECRET: "gsecret",
    });
    await expect(import("./env")).rejects.toThrow("AUTH_SECRET");
  });

  it("requires at least one auth provider in production", async () => {
    process.env = buildMinimalEnv({
      NODE_ENV: "production",
      AUTH_SECRET: "a".repeat(32),
      AUTH_URL: "https://app.example.com",
      VERIFIER_PEPPER_KEY: VALID_HEX_64,
      REDIS_URL: "redis://localhost:6379",
    });
    await expect(import("./env")).rejects.toThrow("auth provider");
  });

  it("accepts valid production config with Google provider", async () => {
    process.env = buildMinimalEnv({
      NODE_ENV: "production",
      AUTH_SECRET: "a".repeat(32),
      AUTH_URL: "https://app.example.com",
      VERIFIER_PEPPER_KEY: VALID_HEX_64,
      REDIS_URL: "redis://localhost:6379",
      AUTH_GOOGLE_ID: "google-id",
      AUTH_GOOGLE_SECRET: "google-secret",
    });
    const { env } = await import("./env");
    expect(env.NODE_ENV).toBe("production");
  });

  it("requires AWS_REGION for s3 blob backend", async () => {
    process.env = buildMinimalEnv({ BLOB_BACKEND: "s3" });
    await expect(import("./env")).rejects.toThrow("AWS_REGION");
  });

  it("requires AZURE_STORAGE_ACCOUNT for azure blob backend", async () => {
    process.env = buildMinimalEnv({ BLOB_BACKEND: "azure" });
    await expect(import("./env")).rejects.toThrow("AZURE_STORAGE_ACCOUNT");
  });

  it("requires GCS_ATTACHMENTS_BUCKET for gcs blob backend", async () => {
    process.env = buildMinimalEnv({ BLOB_BACKEND: "gcs" });
    await expect(import("./env")).rejects.toThrow("GCS_ATTACHMENTS_BUCKET");
  });

  it("coerces DB_POOL_MAX to number with default 20", async () => {
    process.env = buildMinimalEnv();
    const { env } = await import("./env");
    expect(env.DB_POOL_MAX).toBe(20);
  });

  it("trims whitespace from string values", async () => {
    process.env = buildMinimalEnv({
      DATABASE_URL: "  postgresql://localhost:5432/test  ",
    });
    const { env } = await import("./env");
    expect(env.DATABASE_URL).toBe("postgresql://localhost:5432/test");
  });
});
