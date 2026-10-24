import { describe, it, expect } from "vitest";
import {
  auditAnchorPublisherEnvSchema,
  envObject,
  envSchema,
  getSchemaShape,
  isValidAnchorS3Prefix,
} from "./env-schema";

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

  /**
   * Round-6, raised independently by Codex. `AUTH_TENANT_CLAIM_KEYS` was
   * `z.string().optional()`, so `","` booted fine and behaved exactly like
   * leaving the variable unset — falling through to the Google-only `hd`
   * fallback, which on a SAML deployment resolves no claim for any sign-in and
   * creates first-time users in their own bootstrap tenant as OWNER. An
   * operator who configured a claim-key list must not silently get the
   * behaviour of having configured none.
   */
  it.each([",", ",,", " , ", " ,, "])(
    "rejects an AUTH_TENANT_CLAIM_KEYS that is set but names no claim key (%j)",
    (value) => {
      const result = envObject.safeParse(baseEnv({ AUTH_TENANT_CLAIM_KEYS: value }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((i) => i.path[0] === "AUTH_TENANT_CLAIM_KEYS"),
        ).toBe(true);
      }
    },
  );

  // The allow side, including the two shapes deliberately NOT rejected: a
  // repeated key takes effect once, and a stray empty entry names exactly the
  // keys it appears to. Rejecting either would fail the boot of a deployment
  // that works today, for no behavioural gain.
  it.each([undefined, "", "organization", "org,tenant_id,hd", "org,,tenant", "org,org"])(
    "accepts an AUTH_TENANT_CLAIM_KEYS of %j",
    (value) => {
      const result = envObject.safeParse(baseEnv({ AUTH_TENANT_CLAIM_KEYS: value }));
      expect(result.success).toBe(true);
    },
  );

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

  it("rejects RETENTION_GC_INTERVAL_MS below min", () => {
    const result = envObject.safeParse(
      baseEnv({ RETENTION_GC_INTERVAL_MS: "1000" }),
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

  // A08-3: production deployment must enable the anchor publisher so
  // audit chain integrity is externally evidentiary (not detection-only).
  describe("A08-3: AUDIT_ANCHOR_PUBLISHER_ENABLED production gate", () => {
    const validProdBase = {
      NODE_ENV: "production",
      AUTH_SECRET: "x".repeat(32),
      AUTH_URL: "https://app.example.com",
      VERIFIER_PEPPER_KEY: VALID_HEX_64,
      SESSION_TOKEN_HMAC_KEY: VALID_HEX_64,
      REDIS_URL: "redis://localhost:6379",
      AUTH_GOOGLE_ID: "id",
      AUTH_GOOGLE_SECRET: "secret",
    };

    it("rejects production when AUDIT_ANCHOR_PUBLISHER_ENABLED is false (default)", () => {
      const result = envSchema.safeParse(baseEnv(validProdBase));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some(
            (i) => i.path[0] === "AUDIT_ANCHOR_PUBLISHER_ENABLED",
          ),
        ).toBe(true);
      }
    });

    it("rejects production when AUDIT_ANCHOR_PUBLISHER_ENABLED is the string \"false\"", () => {
      const result = envSchema.safeParse(
        baseEnv({ ...validProdBase, AUDIT_ANCHOR_PUBLISHER_ENABLED: "false" }),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some(
            (i) => i.path[0] === "AUDIT_ANCHOR_PUBLISHER_ENABLED",
          ),
        ).toBe(true);
      }
    });

    it("accepts production with the publisher enabled and neither anchor key (they are the publisher's)", () => {
      const result = envSchema.safeParse(
        baseEnv({
          ...validProdBase,
          AUDIT_ANCHOR_PUBLISHER_ENABLED: "true",
          AUDIT_ANCHOR_DESTINATION_FS_PATH: "/var/anchors",
        }),
      );
      expect(result.success).toBe(true);
    });

    it("rejects when ENABLED=true but no destination is configured", () => {
      const result = envSchema.safeParse(
        baseEnv({
          ...validProdBase,
          AUDIT_ANCHOR_PUBLISHER_ENABLED: "true",
        }),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some(
            (i) => i.path[0] === "AUDIT_ANCHOR_DESTINATION_S3_BUCKET",
          ),
        ).toBe(true);
      }
    });

    it("accepts production when publisher fully configured (fs destination)", () => {
      const result = envSchema.safeParse(
        baseEnv({
          ...validProdBase,
          AUDIT_ANCHOR_PUBLISHER_ENABLED: "true",
          AUDIT_ANCHOR_DESTINATION_FS_PATH: "/var/anchors",
        }),
      );
      expect(result.success).toBe(true);
    });

    it("accepts production with S3 destination", () => {
      const result = envSchema.safeParse(
        baseEnv({
          ...validProdBase,
          AUDIT_ANCHOR_PUBLISHER_ENABLED: "true",
          AUDIT_ANCHOR_DESTINATION_S3_BUCKET: "my-bucket",
        }),
      );
      expect(result.success).toBe(true);
    });

    it("accepts production with GitHub destination", () => {
      const result = envSchema.safeParse(
        baseEnv({
          ...validProdBase,
          AUDIT_ANCHOR_PUBLISHER_ENABLED: "true",
          AUDIT_ANCHOR_DESTINATION_GH_REPO: "owner/repo",
          AUDIT_ANCHOR_DESTINATION_GH_TOKEN: "ghp_xxx",
        }),
      );
      expect(result.success).toBe(true);
    });

    it("accepts development without publisher (no production gate)", () => {
      const result = envSchema.safeParse(baseEnv({ NODE_ENV: "development" }));
      expect(result.success).toBe(true);
    });
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

describe("envSchema: SSO provider set (jackson-providers parser)", () => {
  const PROD_BASE = {
    NODE_ENV: "production",
    AUTH_SECRET: "x".repeat(32),
    AUTH_URL: "https://app.example.com",
    VERIFIER_PEPPER_KEY: VALID_HEX_64,
    SESSION_TOKEN_HMAC_KEY: VALID_HEX_64,
    REDIS_URL: "redis://localhost:6379",
    AUDIT_ANCHOR_PUBLISHER_ENABLED: "true",
    AUDIT_ANCHOR_DESTINATION_FS_PATH: "/var/anchors",
  };
  const SECRET = "conn-secret-S3CR3T-77";
  const CONNECTIONS = JSON.stringify([
    { id: "acme", name: "Acme SSO", clientId: "acme-client", clientSecret: SECRET },
  ]);

  function issuesOf(env: Record<string, unknown>) {
    const result = envSchema.safeParse(env);
    return result.success ? [] : result.error.issues;
  }

  it("counts AUTH_JACKSON_CONNECTIONS alone as a production auth provider", () => {
    const issues = issuesOf(
      baseEnv({ ...PROD_BASE, JACKSON_URL: "http://jackson:5225", AUTH_JACKSON_CONNECTIONS: CONNECTIONS }),
    );
    expect(issues).toEqual([]);
  });

  it("still requires a provider in production without it (adjacent refusal)", () => {
    const issues = issuesOf(baseEnv(PROD_BASE));
    expect(issues.map((i) => i.message).join("\n")).toContain("At least one auth provider");
  });

  it("reports a refused Jackson config on its variable only, not also as 'no provider'", () => {
    const issues = issuesOf(
      baseEnv({ ...PROD_BASE, AUTH_JACKSON_CONNECTIONS: CONNECTIONS }),
    );
    expect(issues.map((i) => i.path[0])).toEqual(["JACKSON_URL"]);
  });

  describe.each(["production", "development", "test"])("NODE_ENV=%s", (nodeEnv) => {
    const base = nodeEnv === "production" ? { ...PROD_BASE } : { NODE_ENV: nodeEnv };
    const jackson = { JACKSON_URL: "http://jackson:5225", AUTH_JACKSON_CONNECTIONS: CONNECTIONS };

    it.each<[string, Record<string, string>, Record<string, string>, string]>([
      [
        "a placeholder entry client id",
        { AUTH_JACKSON_CONNECTIONS: CONNECTIONS.replace("acme-client", "dummy") },
        {},
        "AUTH_JACKSON_CONNECTIONS",
      ],
      [
        "an encoded legacy client id",
        { AUTH_JACKSON_ID: "tenant=a&product=b", AUTH_JACKSON_SECRET: SECRET, AUTH_JACKSON_CONNECTIONS: "" },
        { AUTH_JACKSON_ID: "tenant-a-product-b", AUTH_JACKSON_SECRET: SECRET, AUTH_JACKSON_CONNECTIONS: "" },
        "AUTH_JACKSON_ID",
      ],
      [
        "invalid connections JSON",
        { AUTH_JACKSON_CONNECTIONS: CONNECTIONS.slice(0, -1) },
        {},
        "AUTH_JACKSON_CONNECTIONS",
      ],
      [
        "a miscased binding mode",
        { AUTH_CLAIM_BINDING: "Strict" },
        { AUTH_CLAIM_BINDING: "strict" },
        "AUTH_CLAIM_BINDING",
      ],
      [
        "two claim providers without strict",
        { AUTH_GOOGLE_ID: "gid", AUTH_GOOGLE_SECRET: "gsecret" },
        { AUTH_GOOGLE_ID: "gid", AUTH_GOOGLE_SECRET: "gsecret", AUTH_CLAIM_BINDING: "strict" },
        "AUTH_CLAIM_BINDING",
      ],
    ])("refuses %s, allows the adjacent config", (_label, refused, allowed, variable) => {
      const refusedIssues = issuesOf(baseEnv({ ...base, ...jackson, ...refused }));
      expect(refusedIssues.map((i) => i.path[0])).toEqual([variable]);
      for (const issue of refusedIssues) {
        expect(issue.message).not.toContain(SECRET);
        expect(issue.message).not.toContain(CONNECTIONS.slice(0, 20));
      }

      expect(issuesOf(baseEnv({ ...base, ...jackson, ...allowed }))).toEqual([]);
    });
  });
});

describe("EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS (C1)", () => {
  const VALID_ID = "abcdefghijklmnopabcdefghijklmnop"; // 32 chars in [a-p]
  const VALID_ID_2 = "ponmlkjihgfedcbaponmlkjihgfedcba"; // also 32 in [a-p]

  it("accepts a single valid chrome-extension origin", () => {
    const result = envObject.safeParse(
      baseEnv({ EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS: `chrome-extension://${VALID_ID}` }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts CSV of multiple valid origins", () => {
    const result = envObject.safeParse(
      baseEnv({
        EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS: `chrome-extension://${VALID_ID},chrome-extension://${VALID_ID_2}`,
      }),
    );
    expect(result.success).toBe(true);
  });

  it("treats undefined as valid (optional)", () => {
    const result = envObject.safeParse(baseEnv({}));
    expect(result.success).toBe(true);
  });

  it("rejects empty string", () => {
    const result = envObject.safeParse(
      baseEnv({ EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS: "" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects uppercase characters in extension id", () => {
    const result = envObject.safeParse(
      baseEnv({ EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS: "chrome-extension://ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects digits in extension id (Chrome uses a-p only)", () => {
    const result = envObject.safeParse(
      baseEnv({ EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS: "chrome-extension://abcdefghij1234567890abcdefghij12" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects characters outside a-p (q-z forbidden)", () => {
    const result = envObject.safeParse(
      baseEnv({ EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS: "chrome-extension://qrstuvwxyzqrstuvwxyzqrstuvwxyzab" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects ids shorter than 32 chars", () => {
    const result = envObject.safeParse(
      baseEnv({ EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS: "chrome-extension://abc" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects ids longer than 32 chars", () => {
    const result = envObject.safeParse(
      baseEnv({
        EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS: `chrome-extension://${VALID_ID}a`,
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects CSV with trailing comma", () => {
    const result = envObject.safeParse(
      baseEnv({ EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS: `chrome-extension://${VALID_ID},` }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects CSV with spaces", () => {
    const result = envObject.safeParse(
      baseEnv({
        EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS: `chrome-extension://${VALID_ID}, chrome-extension://${VALID_ID_2}`,
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects non-chrome-extension scheme", () => {
    const result = envObject.safeParse(
      baseEnv({ EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS: `https://${VALID_ID}` }),
    );
    expect(result.success).toBe(false);
  });
});

// C9: nine vars that were read by app code but undeclared in the Zod schema.
// Each must parse when absent AND resolve to its documented default (or
// undefined, for vars with no sensible default / a documented degraded mode).
describe("C9 undeclared env vars", () => {
  it("parses with all nine absent and matches documented defaults", () => {
    const result = envObject.safeParse(baseEnv());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.COOKIE_PARTITIONED).toBe(false);
      expect(result.data.AUDIT_IDENTIFIER_PEPPER).toBeUndefined();
      expect(result.data.BREAKGLASS_COOLING_OFF_SECONDS).toBe(3600);
      expect(result.data.IOS_APP_TEAM_ID).toBeUndefined();
      expect(result.data.IOS_APP_BUNDLE_ID).toBe("jp.jpng.passwd-sso");
      expect(result.data.QUOTA_MAX_PASSWORDS_PER_USER).toBe(10_000);
      expect(result.data.QUOTA_MAX_ATTACHMENT_BYTES_PER_USER).toBe(1_073_741_824);
      expect(result.data.QUOTA_MAX_SHARE_LINKS_PER_USER).toBe(1_000);
      expect(result.data.QUOTA_MAX_WEBHOOKS_PER_TENANT).toBe(100);
    }
  });

  it("transforms COOKIE_PARTITIONED string to boolean", () => {
    const result = envObject.safeParse(baseEnv({ COOKIE_PARTITIONED: "true" }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.COOKIE_PARTITIONED).toBe(true);
    }
  });

  it("coerces BREAKGLASS_COOLING_OFF_SECONDS from string number", () => {
    const result = envObject.safeParse(
      baseEnv({ BREAKGLASS_COOLING_OFF_SECONDS: "0" }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.BREAKGLASS_COOLING_OFF_SECONDS).toBe(0);
    }
  });

  it("accepts an explicit AUDIT_IDENTIFIER_PEPPER and IOS_APP_TEAM_ID", () => {
    const pepper = "c".repeat(64);
    const result = envObject.safeParse(
      baseEnv({
        AUDIT_IDENTIFIER_PEPPER: pepper,
        IOS_APP_TEAM_ID: "ABCDE12345",
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.AUDIT_IDENTIFIER_PEPPER).toBe(pepper);
      expect(result.data.IOS_APP_TEAM_ID).toBe("ABCDE12345");
    }
  });

  it("rejects an AUDIT_IDENTIFIER_PEPPER that is not a 256-bit hex key", () => {
    for (const tooWeak of ["x", "c".repeat(31), "z".repeat(64)]) {
      const result = envObject.safeParse(baseEnv({ AUDIT_IDENTIFIER_PEPPER: tooWeak }));
      expect(result.success).toBe(false);
    }
  });

  it("is strictly narrower than the derivation site's floor, which is a deliberately different predicate", () => {
    // Round-1 Sec F5 added two independent guards, and they are NOT the same
    // predicate: the schema is hex64 (exactly 64 hex chars) while
    // src/lib/audit/auth-failure.ts:77,89 accepts any string of length >= 32.
    // That module reads process.env directly — worker processes never run the
    // full schema — so its floor has to hold for values the schema never saw.
    // Asserted rather than glossed, because the asymmetry only stays safe in
    // one direction.
    const DERIVATION_SITE_MIN_LENGTH = 32; // mirrors MIN_KEY_MATERIAL_LENGTH

    // Rejected by the schema, accepted by the derivation site.
    const nonHexPassphrase = "z".repeat(40);
    expect(nonHexPassphrase.length).toBeGreaterThanOrEqual(DERIVATION_SITE_MIN_LENGTH);
    expect(
      envObject.safeParse(baseEnv({ AUDIT_IDENTIFIER_PEPPER: nonHexPassphrase })).success,
    ).toBe(false);

    // The containment that makes the divergence safe: everything the schema
    // admits also clears the derivation floor, so no schema-validated
    // deployment can end up with an under-length HMAC key. Loosening hex64
    // below 32 characters reds here.
    const accepted = envObject.safeParse(baseEnv({ AUDIT_IDENTIFIER_PEPPER: "c".repeat(64) }));
    expect(accepted.success).toBe(true);
    if (accepted.success) {
      expect(accepted.data.AUDIT_IDENTIFIER_PEPPER?.length).toBeGreaterThanOrEqual(
        DERIVATION_SITE_MIN_LENGTH,
      );
    }
  });

  it("coerces QUOTA_MAX_PASSWORDS_PER_USER from string number", () => {
    const result = envObject.safeParse(
      baseEnv({ QUOTA_MAX_PASSWORDS_PER_USER: "5000" }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.QUOTA_MAX_PASSWORDS_PER_USER).toBe(5000);
    }
  });

  it("never appears as production-required (NF2 — no new startup requirement)", () => {
    // superRefine has no addIssue path keyed to any of the nine; a production
    // parse with only the pre-existing required fields set must still succeed
    // once those pre-existing requirements are met.
    const result = envSchema.safeParse(
      baseEnv({
        NODE_ENV: "production",
        AUTH_SECRET: "x".repeat(32),
        AUTH_URL: "https://app.example.com",
        VERIFIER_PEPPER_KEY: VALID_HEX_64,
        SESSION_TOKEN_HMAC_KEY: VALID_HEX_64,
        REDIS_URL: "redis://localhost:6379",
        AUTH_GOOGLE_ID: "id",
        AUTH_GOOGLE_SECRET: "secret",
        AUDIT_ANCHOR_PUBLISHER_ENABLED: "true",
        AUDIT_ANCHOR_DESTINATION_FS_PATH: "/var/anchors",
      }),
    );
    expect(result.success).toBe(true);
  });
});

describe("AUDIT_ANCHOR_PUBLISHER_ENABLED parsing", () => {
  it.each([
    ["true", true],
    ["false", false],
    [undefined, false],
  ])("parses %s as %s", (value, expected) => {
    const result = envObject.safeParse(baseEnv({ AUDIT_ANCHOR_PUBLISHER_ENABLED: value }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.AUDIT_ANCHOR_PUBLISHER_ENABLED).toBe(expected);
  });

  it("rejects a value that is neither true nor false", () => {
    const result = envObject.safeParse(baseEnv({ AUDIT_ANCHOR_PUBLISHER_ENABLED: "yes" }));
    expect(result.success).toBe(false);
  });
});

describe("AUDIT_ANCHOR_DESTINATION_S3_PREFIX", () => {
  it.each(["a", "a/b", "a.b", ".a", "audit-anchors", "x_y/z-1"])("accepts %j", (prefix) => {
    expect(isValidAnchorS3Prefix(prefix)).toBe(true);
    expect(envObject.safeParse(baseEnv({ AUDIT_ANCHOR_DESTINATION_S3_PREFIX: prefix })).success).toBe(true);
  });

  it.each(["*", "?", "/a", "a/", "a//b", ".", "..", "a/../b", "a/./b", "a b"])("refuses %j", (prefix) => {
    expect(isValidAnchorS3Prefix(prefix)).toBe(false);
    expect(envObject.safeParse(baseEnv({ AUDIT_ANCHOR_DESTINATION_S3_PREFIX: prefix })).success).toBe(false);
  });

  it("accepts unset and empty (writes at the bucket root)", () => {
    expect(envObject.safeParse(baseEnv()).success).toBe(true);
    expect(envObject.safeParse(baseEnv({ AUDIT_ANCHOR_DESTINATION_S3_PREFIX: "" })).success).toBe(true);
  });

  it("the predicate itself refuses the empty string, which the schema admits before it", () => {
    expect(isValidAnchorS3Prefix("")).toBe(false);
  });
});

describe("auditAnchorPublisherEnvSchema", () => {
  const DEPLOYMENT_ID = "550e8400-e29b-41d4-a716-446655440000";
  const PUBLISHER_URL = "postgresql://passwd_anchor_publisher:p@db:5432/passwd_sso";
  const enabled = {
    AUDIT_ANCHOR_PUBLISHER_ENABLED: "true",
    DEPLOYMENT_ID,
    AUDIT_ANCHOR_SIGNING_KEY: VALID_HEX_64,
    AUDIT_ANCHOR_TAG_SECRET: VALID_HEX_64,
  };

  function issuePaths(env: Record<string, unknown>): string[] {
    const result = auditAnchorPublisherEnvSchema.safeParse(env);
    return result.success ? [] : result.error.issues.map((i) => i.path.join("."));
  }

  it("accepts production with the publisher URL and no DATABASE_URL", () => {
    expect(issuePaths({ NODE_ENV: "production", ...enabled, AUDIT_ANCHOR_PUBLISHER_DATABASE_URL: PUBLISHER_URL })).toEqual([]);
  });

  it("requires the publisher URL in production, with no DATABASE_URL fallback", () => {
    expect(
      issuePaths({ NODE_ENV: "production", ...enabled, DATABASE_URL: "postgresql://app:p@db:5432/passwd_sso" }),
    ).toEqual(["AUDIT_ANCHOR_PUBLISHER_DATABASE_URL"]);
  });

  it.each(["DEPLOYMENT_ID", "AUDIT_ANCHOR_SIGNING_KEY", "AUDIT_ANCHOR_TAG_SECRET"])(
    "requires %s when enabled",
    (name) => {
      const env: Record<string, unknown> = {
        NODE_ENV: "production",
        ...enabled,
        AUDIT_ANCHOR_PUBLISHER_DATABASE_URL: PUBLISHER_URL,
      };
      delete env[name];
      expect(issuePaths(env)).toEqual([name]);
    },
  );

  it("falls back to DATABASE_URL outside production, and requires one of the two", () => {
    expect(issuePaths({ NODE_ENV: "development", ...enabled, DATABASE_URL: "postgresql://localhost/x" })).toEqual([]);
    expect(issuePaths({ NODE_ENV: "development", ...enabled, DATABASE_URL: "  " })).toEqual(["DATABASE_URL"]);
  });

  it("requires nothing when the publisher is disabled", () => {
    expect(issuePaths({ NODE_ENV: "production", AUDIT_ANCHOR_PUBLISHER_ENABLED: "false" })).toEqual([]);
  });

  it("applies the prefix rule", () => {
    expect(
      issuePaths({
        NODE_ENV: "production",
        ...enabled,
        AUDIT_ANCHOR_PUBLISHER_DATABASE_URL: PUBLISHER_URL,
        AUDIT_ANCHOR_DESTINATION_S3_PREFIX: "a//b",
      }),
    ).toEqual(["AUDIT_ANCHOR_DESTINATION_S3_PREFIX"]);
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
