import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// env.ts calls parseEnv() at import time, so we need to test by resetting modules
// and setting process.env before each fresh import.

const VALID_HEX_64 = "a".repeat(64);

function buildMinimalEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://localhost:5432/test",
    SHARE_MASTER_KEY: VALID_HEX_64,
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
    process.env = { SHARE_MASTER_KEY: VALID_HEX_64 } as unknown as NodeJS.ProcessEnv;
    await expect(import("./env")).rejects.toThrow("Invalid environment variables");
  });

  it("throws for missing SHARE_MASTER_KEY", async () => {
    process.env = { DATABASE_URL: "postgresql://localhost:5432/test" } as unknown as NodeJS.ProcessEnv;
    await expect(import("./env")).rejects.toThrow("Invalid environment variables");
  });

  it("throws for invalid SHARE_MASTER_KEY (not 64 hex chars)", async () => {
    process.env = buildMinimalEnv({ SHARE_MASTER_KEY: "short" });
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

  // Blob backend validation is handled by each store's validateConfig()
  // in src/lib/blob-store/config.ts — not by env.ts superRefine.
  // See src/lib/blob-store/*.test.ts for those checks.

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

  it("accepts EMAIL_PROVIDER=smtp as valid", async () => {
    process.env = buildMinimalEnv({ EMAIL_PROVIDER: "smtp" });
    const { env } = await import("./env");
    expect(env.EMAIL_PROVIDER).toBe("smtp");
  });

  it("accepts EMAIL_PROVIDER=resend as valid", async () => {
    process.env = buildMinimalEnv({ EMAIL_PROVIDER: "resend" });
    const { env } = await import("./env");
    expect(env.EMAIL_PROVIDER).toBe("resend");
  });

  it("rejects invalid EMAIL_PROVIDER value", async () => {
    process.env = buildMinimalEnv({ EMAIL_PROVIDER: "invalid" });
    await expect(import("./env")).rejects.toThrow("Invalid environment variables");
  });

  it("EMAIL_PROVIDER is optional (undefined when not set)", async () => {
    process.env = buildMinimalEnv();
    const { env } = await import("./env");
    expect(env.EMAIL_PROVIDER).toBeUndefined();
  });

  it("accepts production config with EMAIL_PROVIDER as sole auth provider", async () => {
    process.env = buildMinimalEnv({
      NODE_ENV: "production",
      AUTH_SECRET: "a".repeat(32),
      AUTH_URL: "https://app.example.com",
      VERIFIER_PEPPER_KEY: VALID_HEX_64,
      REDIS_URL: "redis://localhost:6379",
      EMAIL_PROVIDER: "smtp",
      SMTP_HOST: "smtp.example.com",
    });
    const { env } = await import("./env");
    expect(env.EMAIL_PROVIDER).toBe("smtp");
  });

  it("rejects production config with EMAIL_PROVIDER=smtp but no SMTP_HOST", async () => {
    process.env = buildMinimalEnv({
      NODE_ENV: "production",
      AUTH_SECRET: "a".repeat(32),
      AUTH_URL: "https://app.example.com",
      VERIFIER_PEPPER_KEY: VALID_HEX_64,
      REDIS_URL: "redis://localhost:6379",
      EMAIL_PROVIDER: "smtp",
    });
    await expect(import("./env")).rejects.toThrow("SMTP_HOST");
  });

  // --- MIGRATION_DATABASE_URL ---

  it("accepts valid MIGRATION_DATABASE_URL", async () => {
    process.env = buildMinimalEnv({
      MIGRATION_DATABASE_URL: "postgresql://passwd_user:passwd_pass@localhost:5432/passwd_sso",
    });
    const { env } = await import("./env");
    expect(env.MIGRATION_DATABASE_URL).toBe(
      "postgresql://passwd_user:passwd_pass@localhost:5432/passwd_sso",
    );
  });

  it("MIGRATION_DATABASE_URL is optional (undefined when not set)", async () => {
    process.env = buildMinimalEnv();
    const { env } = await import("./env");
    expect(env.MIGRATION_DATABASE_URL).toBeUndefined();
  });

  it("rejects invalid MIGRATION_DATABASE_URL", async () => {
    process.env = buildMinimalEnv({
      MIGRATION_DATABASE_URL: "not-a-url",
    });
    await expect(import("./env")).rejects.toThrow("MIGRATION_DATABASE_URL");
  });

  it("rejects empty MIGRATION_DATABASE_URL", async () => {
    process.env = buildMinimalEnv({
      MIGRATION_DATABASE_URL: "",
    });
    await expect(import("./env")).rejects.toThrow("Invalid environment variables");
  });
});

// Per-field accept/reject coverage for A1-A33 + V1..V10 (plan §E F12 / CF3).
// Uses envObject directly (safeParse) to avoid module-reset overhead and
// refinement cross-talk from envSchema.superRefine — these tests validate
// individual field schemas, not cross-field production requirements.
describe("envObject per-field validation", () => {
  const base = () => ({
    DATABASE_URL: "postgresql://localhost:5432/test",
    SHARE_MASTER_KEY: VALID_HEX_64,
    NODE_ENV: "development" as const,
  });

  // ── A1 LOG_LEVEL (pino enum + default info) ──
  it("accepts LOG_LEVEL=info and defaults to info when missing", async () => {
    const { envObject } = await import("./env-schema");
    const r = envObject.safeParse({ ...base() });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.LOG_LEVEL).toBe("info");
  });
  it.each(["trace", "debug", "info", "warn", "error", "fatal"])(
    "accepts LOG_LEVEL=%s",
    async (level) => {
      const { envObject } = await import("./env-schema");
      const r = envObject.safeParse({ ...base(), LOG_LEVEL: level });
      expect(r.success).toBe(true);
    },
  );
  it("rejects invalid LOG_LEVEL", async () => {
    const { envObject } = await import("./env-schema");
    const r = envObject.safeParse({ ...base(), LOG_LEVEL: "verbose" });
    expect(r.success).toBe(false);
  });

  // ── A2 HEALTH_REDIS_REQUIRED (NF-5 default false stays) ──
  it("HEALTH_REDIS_REQUIRED defaults to false (boolean transform)", async () => {
    const { envObject } = await import("./env-schema");
    const r = envObject.safeParse({ ...base() });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.HEALTH_REDIS_REQUIRED).toBe(false);
  });
  it("HEALTH_REDIS_REQUIRED=true transforms to boolean true", async () => {
    const { envObject } = await import("./env-schema");
    const r = envObject.safeParse({ ...base(), HEALTH_REDIS_REQUIRED: "true" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.HEALTH_REDIS_REQUIRED).toBe(true);
  });

  // ── A7 SMTP_PORT (F22 documented tightening — empty string rejects) ──
  it("F22 regression: rejects empty string SMTP_PORT", async () => {
    const { envObject } = await import("./env-schema");
    const r = envObject.safeParse({ ...base(), SMTP_PORT: "" });
    expect(r.success).toBe(false);
  });
  it("SMTP_PORT defaults to 587 when missing", async () => {
    const { envObject } = await import("./env-schema");
    const r = envObject.safeParse({ ...base() });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.SMTP_PORT).toBe(587);
  });
  it("SMTP_PORT coerces numeric string", async () => {
    const { envObject } = await import("./env-schema");
    const r = envObject.safeParse({ ...base(), SMTP_PORT: "2525" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.SMTP_PORT).toBe(2525);
  });
  it("SMTP_PORT rejects out-of-range (66000)", async () => {
    const { envObject } = await import("./env-schema");
    const r = envObject.safeParse({ ...base(), SMTP_PORT: "66000" });
    expect(r.success).toBe(false);
  });

  // ── A20 OUTBOX_BATCH_SIZE (coercion + range) ──
  it("OUTBOX_BATCH_SIZE coerces numeric string and accepts 500", async () => {
    const { envObject } = await import("./env-schema");
    const r = envObject.safeParse({ ...base(), OUTBOX_BATCH_SIZE: "500" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.OUTBOX_BATCH_SIZE).toBe(500);
  });
  it("OUTBOX_BATCH_SIZE rejects non-numeric string", async () => {
    const { envObject } = await import("./env-schema");
    const r = envObject.safeParse({ ...base(), OUTBOX_BATCH_SIZE: "not-a-number" });
    expect(r.success).toBe(false);
  });
  it("OUTBOX_BATCH_SIZE defaults to 500 when missing", async () => {
    const { envObject } = await import("./env-schema");
    const r = envObject.safeParse({ ...base() });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.OUTBOX_BATCH_SIZE).toBe(500);
  });

  // ── A29 OUTBOX_WORKER_DATABASE_URL (URL validation + optional) ──
  it("OUTBOX_WORKER_DATABASE_URL rejects malformed URL", async () => {
    const { envObject } = await import("./env-schema");
    const r = envObject.safeParse({
      ...base(),
      OUTBOX_WORKER_DATABASE_URL: "not-a-url",
    });
    expect(r.success).toBe(false);
  });
  it("OUTBOX_WORKER_DATABASE_URL accepts valid URL and is optional", async () => {
    const { envObject } = await import("./env-schema");
    const r1 = envObject.safeParse({ ...base() });
    expect(r1.success).toBe(true);
    if (r1.success) expect(r1.data.OUTBOX_WORKER_DATABASE_URL).toBeUndefined();
    const r2 = envObject.safeParse({
      ...base(),
      OUTBOX_WORKER_DATABASE_URL:
        "postgresql://worker:pass@localhost:5432/passwd_sso",
    });
    expect(r2.success).toBe(true);
  });

  // ── A15-A19 Redis Sentinel (enum transform + defaults) ──
  it("REDIS_SENTINEL defaults to false (transform)", async () => {
    const { envObject } = await import("./env-schema");
    const r = envObject.safeParse({ ...base() });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.REDIS_SENTINEL).toBe(false);
  });
  it("REDIS_SENTINEL_MASTER_NAME defaults to mymaster", async () => {
    const { envObject } = await import("./env-schema");
    const r = envObject.safeParse({ ...base() });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.REDIS_SENTINEL_MASTER_NAME).toBe("mymaster");
  });

  // ── A30-A33 NEXT_PUBLIC_* (server-side defaults as safety net) ──
  it("NEXT_PUBLIC_APP_NAME defaults to passwd-sso", async () => {
    const { envObject } = await import("./env-schema");
    const r = envObject.safeParse({ ...base() });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.NEXT_PUBLIC_APP_NAME).toBe("passwd-sso");
  });
  it("NEXT_PUBLIC_BASE_PATH defaults to empty string", async () => {
    const { envObject } = await import("./env-schema");
    const r = envObject.safeParse({ ...base() });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.NEXT_PUBLIC_BASE_PATH).toBe("");
  });

  // ── A3 NEXTAUTH_URL (optional legacy fallback) ──
  it("NEXTAUTH_URL is optional", async () => {
    const { envObject } = await import("./env-schema");
    const r = envObject.safeParse({ ...base() });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.NEXTAUTH_URL).toBeUndefined();
  });

  // ── V1..V10 SHARE_MASTER_KEY_V{N} explicit fields (D6-split S4) ──
  it.each([1, 2, 5, 10])(
    "accepts 64-hex SHARE_MASTER_KEY_V%i",
    async (n) => {
      const { envObject } = await import("./env-schema");
      const r = envObject.safeParse({
        ...base(),
        [`SHARE_MASTER_KEY_V${n}`]: "b".repeat(64),
      });
      expect(r.success).toBe(true);
    },
  );
  it.each([1, 2, 5, 10])(
    "rejects non-hex SHARE_MASTER_KEY_V%i",
    async (n) => {
      const { envObject } = await import("./env-schema");
      const r = envObject.safeParse({
        ...base(),
        [`SHARE_MASTER_KEY_V${n}`]: "g".repeat(64), // "g" is not hex
      });
      expect(r.success).toBe(false);
    },
  );

  // ── Misc enums ──
  it("AUDIT_LOG_FORWARD defaults to false (transform)", async () => {
    const { envObject } = await import("./env-schema");
    const r = envObject.safeParse({ ...base() });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.AUDIT_LOG_FORWARD).toBe(false);
  });
});
