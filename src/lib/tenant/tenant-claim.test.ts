import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { extractTenantClaimValue, parseTenantClaimKeys, slugifyTenant } from "./tenant-claim";

describe("tenant-claim", () => {
  const original = process.env.AUTH_TENANT_CLAIM_KEYS;

  beforeEach(() => {
    delete process.env.AUTH_TENANT_CLAIM_KEYS;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.AUTH_TENANT_CLAIM_KEYS;
    } else {
      process.env.AUTH_TENANT_CLAIM_KEYS = original;
    }
    vi.restoreAllMocks();
  });

  it("uses default claim keys when env is unset", () => {
    expect(parseTenantClaimKeys()).toContain("tenant_id");
  });

  it("parses custom claim keys from env", () => {
    process.env.AUTH_TENANT_CLAIM_KEYS = "tenant,org_id";
    expect(parseTenantClaimKeys()).toEqual(["tenant", "org_id"]);
  });

  it("extracts tenant from configured claim", () => {
    process.env.AUTH_TENANT_CLAIM_KEYS = "tenant";
    const v = extractTenantClaimValue(
      { provider: "saml-jackson", type: "oidc", providerAccountId: "x" },
      { tenant: "acme" },
    );
    expect(v).toBe("acme");
  });

  it("falls back to google hd claim", () => {
    const v = extractTenantClaimValue(
      { provider: "google", type: "oauth", providerAccountId: "x" },
      { hd: "example.com" },
    );
    expect(v).toBe("example.com");
  });

  it("returns null for claim values exceeding 255 characters", () => {
    const longValue = "x".repeat(256);
    const v = extractTenantClaimValue(
      { provider: "saml-jackson", type: "oidc", providerAccountId: "x" },
      { tenant_id: longValue },
    );
    expect(v).toBeNull();
  });

  it("accepts claim value of exactly 255 characters", () => {
    process.env.AUTH_TENANT_CLAIM_KEYS = "tenant_id";
    const exactValue = "x".repeat(255);
    const v = extractTenantClaimValue(
      { provider: "saml-jackson", type: "oidc", providerAccountId: "x" },
      { tenant_id: exactValue },
    );
    expect(v).toBe(exactValue);
  });

  it("strips NULL bytes from claim values", () => {
    process.env.AUTH_TENANT_CLAIM_KEYS = "tenant_id";
    const v = extractTenantClaimValue(
      { provider: "saml-jackson", type: "oidc", providerAccountId: "x" },
      { tenant_id: "acme\0corp" },
    );
    expect(v).toBe("acmecorp");
  });

  it("returns null when claim value is only NULL bytes", () => {
    process.env.AUTH_TENANT_CLAIM_KEYS = "tenant_id";
    const v = extractTenantClaimValue(
      { provider: "saml-jackson", type: "oidc", providerAccountId: "x" },
      { tenant_id: "\0\0\0" },
    );
    expect(v).toBeNull();
  });

  it("slugifies tenant strings", () => {
    expect(slugifyTenant(" ACME Corp. ")).toBe("acme-corp");
  });

  it("returns null for non-string claim values (number, boolean, object)", () => {
    process.env.AUTH_TENANT_CLAIM_KEYS = "tenant_id";
    const account = { provider: "saml-jackson", type: "oidc" as const, providerAccountId: "x" };
    expect(extractTenantClaimValue(account, { tenant_id: 42 })).toBeNull();
    expect(extractTenantClaimValue(account, { tenant_id: true })).toBeNull();
    expect(extractTenantClaimValue(account, { tenant_id: { nested: "value" } })).toBeNull();
  });

  it("returns null for whitespace-only claim values", () => {
    process.env.AUTH_TENANT_CLAIM_KEYS = "tenant_id";
    const v = extractTenantClaimValue(
      { provider: "saml-jackson", type: "oidc", providerAccountId: "x" },
      { tenant_id: "   " },
    );
    expect(v).toBeNull();
  });

  it("strips control characters from claim values (boundary)", () => {
    process.env.AUTH_TENANT_CLAIM_KEYS = "tenant_id";
    const v = extractTenantClaimValue(
      { provider: "saml-jackson", type: "oidc", providerAccountId: "x" },
      { tenant_id: "\0abc\x1f\x7f\x9fdef\0" },
    );
    expect(v).toBe("abcdef");
  });

  it("slugifyTenant generates SHA-256 fallback for empty-after-strip input", () => {
    const slug = slugifyTenant("日本語テスト");
    expect(slug).toMatch(/^[0-9a-f]{24}$/);
  });

  it("slugifyTenant prepends t- for reserved bootstrap- prefix", () => {
    expect(slugifyTenant("Bootstrap-Corp")).toBe("t-bootstrap-corp");
  });

  it("slugifyTenant prepends t- for reserved u- prefix", () => {
    expect(slugifyTenant("U-Corp")).toBe("t-u-corp");
  });
});
