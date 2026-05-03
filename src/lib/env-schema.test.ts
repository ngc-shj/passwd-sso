import { describe, it, expect } from "vitest";
import { envObject, envSchema, getSchemaShape } from "./env-schema";

const VALID_HEX_64 = "a".repeat(64);
const SHORT_HEX = "a".repeat(63);

function baseEnv(overrides: Record<string, unknown> = {}) {
  return {
    DATABASE_URL: "postgresql://localhost:5432/test",
    SHARE_MASTER_KEY: VALID_HEX_64,
    NODE_ENV: "development",
    ...overrides,
  };
}

describe("envObject (raw schema, no superRefine)", () => {
  it("parses a minimal valid env", () => {
    const result = envObject.safeParse(baseEnv());
    expect(result.success).toBe(true);
  });

  it("rejects an invalid SHARE_MASTER_KEY (not 64 hex)", () => {
    const result = envObject.safeParse(baseEnv({ SHARE_MASTER_KEY: SHORT_HEX }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => i.path[0] === "SHARE_MASTER_KEY",
      );
      expect(issue).toBeDefined();
    }
  });

  it("rejects empty DATABASE_URL", () => {
    const result = envObject.safeParse({
      DATABASE_URL: "",
      SHARE_MASTER_KEY: VALID_HEX_64,
    });
    expect(result.success).toBe(false);
  });

  it("trims whitespace from hex64 keys before validation", () => {
    const result = envObject.safeParse(
      baseEnv({ SHARE_MASTER_KEY: `  ${VALID_HEX_64}  ` }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.SHARE_MASTER_KEY).toBe(VALID_HEX_64);
    }
  });

  it("trims whitespace from nonEmpty fields before validation", () => {
    const result = envObject.safeParse(
      baseEnv({ DATABASE_URL: "  postgresql://localhost/db  " }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.DATABASE_URL).toBe("postgresql://localhost/db");
    }
  });

  it("defaults NODE_ENV to development when missing", () => {
    const result = envObject.safeParse({
      DATABASE_URL: "postgresql://localhost/test",
      SHARE_MASTER_KEY: VALID_HEX_64,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.NODE_ENV).toBe("development");
    }
  });

  it("rejects unknown NODE_ENV values", () => {
    const result = envObject.safeParse(baseEnv({ NODE_ENV: "staging" }));
    expect(result.success).toBe(false);
  });

  it("rejects malformed APP_URL", () => {
    const result = envObject.safeParse(baseEnv({ APP_URL: "not a url" }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path[0] === "APP_URL"),
      ).toBe(true);
    }
  });

  it("accepts a valid APP_URL", () => {
    const result = envObject.safeParse(
      baseEnv({ APP_URL: "https://app.example.com" }),
    );
    expect(result.success).toBe(true);
  });

  it("coerces SHARE_MASTER_KEY_CURRENT_VERSION as integer (default 1)", () => {
    const result = envObject.safeParse(baseEnv());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.SHARE_MASTER_KEY_CURRENT_VERSION).toBe(1);
    }
  });

  it("coerces SHARE_MASTER_KEY_CURRENT_VERSION from string number", () => {
    const result = envObject.safeParse(
      baseEnv({ SHARE_MASTER_KEY_CURRENT_VERSION: "5" }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.SHARE_MASTER_KEY_CURRENT_VERSION).toBe(5);
    }
  });

  it("rejects SHARE_MASTER_KEY_CURRENT_VERSION above max=100", () => {
    const result = envObject.safeParse(
      baseEnv({ SHARE_MASTER_KEY_CURRENT_VERSION: "101" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects SHARE_MASTER_KEY_CURRENT_VERSION below min=1", () => {
    const result = envObject.safeParse(
      baseEnv({ SHARE_MASTER_KEY_CURRENT_VERSION: "0" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects empty SMTP_PORT (NF-5 F22)", () => {
    const result = envObject.safeParse(baseEnv({ SMTP_PORT: "" }));
    expect(result.success).toBe(false);
  });

  it("rejects out-of-range SMTP_PORT", () => {
    const result = envObject.safeParse(baseEnv({ SMTP_PORT: "99999" }));
    expect(result.success).toBe(false);
  });

  it("transforms TRUST_PROXY_HEADERS string to boolean", () => {
    const r1 = envObject.safeParse(baseEnv({ TRUST_PROXY_HEADERS: "true" }));
    const r2 = envObject.safeParse(baseEnv({ TRUST_PROXY_HEADERS: "false" }));
    expect(r1.success && r1.data.TRUST_PROXY_HEADERS).toBe(true);
    expect(r2.success && r2.data.TRUST_PROXY_HEADERS).toBe(false);
  });

  it("rejects non-boolean TRUST_PROXY_HEADERS string", () => {
    const result = envObject.safeParse(
      baseEnv({ TRUST_PROXY_HEADERS: "yes" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects unknown EMAIL_PROVIDER enum value", () => {
    const result = envObject.safeParse(baseEnv({ EMAIL_PROVIDER: "sendgrid" }));
    expect(result.success).toBe(false);
  });

  it("rejects unknown BLOB_BACKEND enum value", () => {
    const result = envObject.safeParse(baseEnv({ BLOB_BACKEND: "minio" }));
    expect(result.success).toBe(false);
  });

  it("defaults BLOB_BACKEND to db when missing", () => {
    const result = envObject.safeParse(baseEnv());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.BLOB_BACKEND).toBe("db");
    }
  });

  it("rejects DEPLOYMENT_ID that is not a UUID", () => {
    const result = envObject.safeParse(
      baseEnv({ DEPLOYMENT_ID: "not-a-uuid" }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts a valid DEPLOYMENT_ID UUID", () => {
    const result = envObject.safeParse(
      baseEnv({ DEPLOYMENT_ID: "550e8400-e29b-41d4-a716-446655440000" }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects DCR_CLEANUP_INTERVAL_MS below min", () => {
    const result = envObject.safeParse(
      baseEnv({ DCR_CLEANUP_INTERVAL_MS: "1000" }),
    );
    expect(result.success).toBe(false);
  });
});

describe("envSchema (with superRefine cross-field rules)", () => {
  it("parses a minimal dev env", () => {
    const result = envSchema.safeParse(baseEnv());
    expect(result.success).toBe(true);
  });

  it("requires AUTH_SECRET in production", () => {
    const result = envSchema.safeParse(
      baseEnv({
        NODE_ENV: "production",
        AUTH_URL: "https://app.example.com",
        VERIFIER_PEPPER_KEY: VALID_HEX_64,
        REDIS_URL: "redis://localhost:6379",
        AUTH_GOOGLE_ID: "id",
        AUTH_GOOGLE_SECRET: "secret",
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path[0] === "AUTH_SECRET"),
      ).toBe(true);
    }
  });

  it("requires at least one auth provider in production", () => {
    const result = envSchema.safeParse(
      baseEnv({
        NODE_ENV: "production",
        AUTH_SECRET: "x".repeat(32),
        AUTH_URL: "https://app.example.com",
        VERIFIER_PEPPER_KEY: VALID_HEX_64,
        REDIS_URL: "redis://localhost:6379",
      }),
    );
    expect(result.success).toBe(false);
  });

  it("requires SMTP_HOST when EMAIL_PROVIDER=smtp in production", () => {
    const result = envSchema.safeParse(
      baseEnv({
        NODE_ENV: "production",
        AUTH_SECRET: "x".repeat(32),
        AUTH_URL: "https://app.example.com",
        VERIFIER_PEPPER_KEY: VALID_HEX_64,
        REDIS_URL: "redis://localhost:6379",
        EMAIL_PROVIDER: "smtp",
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path[0] === "SMTP_HOST"),
      ).toBe(true);
    }
  });

  it("requires AZURE_KV_URL when KEY_PROVIDER=azure-kv (any NODE_ENV)", () => {
    const result = envSchema.safeParse(
      baseEnv({ KEY_PROVIDER: "azure-kv" }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path[0] === "AZURE_KV_URL"),
      ).toBe(true);
    }
  });

  it("requires GCP_PROJECT_ID when KEY_PROVIDER=gcp-sm (any NODE_ENV)", () => {
    const result = envSchema.safeParse(baseEnv({ KEY_PROVIDER: "gcp-sm" }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path[0] === "GCP_PROJECT_ID"),
      ).toBe(true);
    }
  });

  it("requires REDIS_SENTINEL_HOSTS when REDIS_SENTINEL=true", () => {
    const result = envSchema.safeParse(baseEnv({ REDIS_SENTINEL: "true" }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (i) => i.path[0] === "REDIS_SENTINEL_HOSTS",
        ),
      ).toBe(true);
    }
  });

  it("rejects when env KEY_PROVIDER lacks SHARE_MASTER_KEY_V<n> for current version", () => {
    const result = envSchema.safeParse({
      DATABASE_URL: "postgresql://localhost/test",
      NODE_ENV: "development",
      KEY_PROVIDER: "env",
      SHARE_MASTER_KEY_CURRENT_VERSION: "3",
    });
    expect(result.success).toBe(false);
  });

  it("accepts SHARE_MASTER_KEY_V2 when current version is 2", () => {
    const result = envSchema.safeParse({
      DATABASE_URL: "postgresql://localhost/test",
      NODE_ENV: "development",
      KEY_PROVIDER: "env",
      SHARE_MASTER_KEY_CURRENT_VERSION: "2",
      SHARE_MASTER_KEY_V2: "b".repeat(64),
    });
    expect(result.success).toBe(true);
  });
});

describe("getSchemaShape", () => {
  it("returns the envObject .shape (pickable)", () => {
    const shape = getSchemaShape();
    expect(shape).toBeDefined();
    expect(shape.DATABASE_URL).toBeDefined();
    expect(shape.NODE_ENV).toBeDefined();
    expect(shape.SHARE_MASTER_KEY).toBeDefined();
  });

  it("returns the same shape as envObject.shape", () => {
    expect(getSchemaShape()).toBe(envObject.shape);
  });
});
