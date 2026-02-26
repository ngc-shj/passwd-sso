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

  it("slugifies tenant strings", () => {
    expect(slugifyTenant(" ACME Corp. ")).toBe("acme-corp");
  });
});
