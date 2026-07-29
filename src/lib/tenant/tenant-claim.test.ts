import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractTenantClaimValue, parseTenantClaimKeys, slugifyTenant } from "./tenant-claim";

describe("tenant-claim", () => {
  beforeEach(() => {
    // Assert the precondition instead of inheriting an ambient absence: the
    // default-key cases below are only meaningful when the var really is
    // unset, and an environment that supplies it (a CI job-level env block,
    // an operator's .env) would silently test a different key list —
    // round-1 CR1. "" is falsy at parseTenantClaimKeys's read site, so it is
    // a faithful "unset"; setup.ts's afterEach (vi.unstubAllEnvs()) reverts
    // it, and individual tests override it with vi.stubEnv.
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "");
  });

  it("uses default claim keys when env is unset", () => {
    expect(parseTenantClaimKeys()).toContain("tenant_id");
  });

  it("parses custom claim keys from env", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant,org_id");
    expect(parseTenantClaimKeys()).toEqual(["tenant", "org_id"]);
  });

  it("extracts tenant from configured claim", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant");
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

  it("AUTH_TENANT_CLAIM_KEYS=hd selects the Google hosted-domain claim and nothing else", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "hd");
    const v = extractTenantClaimValue(
      { provider: "google", type: "oauth", providerAccountId: "x" },
      { hd: "example.com", organization: "self-asserted-corp" },
    );
    // The attested claim wins, and the self-asserted attribute the default
    // list would have preferred is not consulted at all (round-1 M4).
    expect(v).toBe("example.com");
  });

  it("AUTH_TENANT_CLAIM_KEYS=hd ignores an hd attribute from a non-Google provider", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "hd");
    // `hd` means "Google asserted this hosted domain". A SAML profile carrying
    // a field of the same name is self-asserted, so it must not resolve.
    const v = extractTenantClaimValue(
      { provider: "saml-jackson", type: "oidc", providerAccountId: "x" },
      { hd: "attacker.example" },
    );
    expect(v).toBeNull();
  });

  it("unset AUTH_TENANT_CLAIM_KEYS keeps the default list ahead of the hd fallback", () => {
    const v = extractTenantClaimValue(
      { provider: "google", type: "oauth", providerAccountId: "x" },
      { organization: "acme", hd: "example.com" },
    );
    expect(v).toBe("acme");
    expect(parseTenantClaimKeys()).toEqual([
      "tenant_id",
      "tenantId",
      "organization",
      "org",
      "company",
      "company_id",
    ]);
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
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    const exactValue = "x".repeat(255);
    const v = extractTenantClaimValue(
      { provider: "saml-jackson", type: "oidc", providerAccountId: "x" },
      { tenant_id: exactValue },
    );
    expect(v).toBe(exactValue);
  });

  it("strips NULL bytes from claim values", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    const v = extractTenantClaimValue(
      { provider: "saml-jackson", type: "oidc", providerAccountId: "x" },
      { tenant_id: "acme\0corp" },
    );
    expect(v).toBe("acmecorp");
  });

  it("returns null when claim value is only NULL bytes", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
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
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    const account = { provider: "saml-jackson", type: "oidc" as const, providerAccountId: "x" };
    expect(extractTenantClaimValue(account, { tenant_id: 42 })).toBeNull();
    expect(extractTenantClaimValue(account, { tenant_id: true })).toBeNull();
    expect(extractTenantClaimValue(account, { tenant_id: { nested: "value" } })).toBeNull();
  });

  it("returns null for whitespace-only claim values", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    const v = extractTenantClaimValue(
      { provider: "saml-jackson", type: "oidc", providerAccountId: "x" },
      { tenant_id: "   " },
    );
    expect(v).toBeNull();
  });

  it("strips control characters from claim values (boundary)", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    const v = extractTenantClaimValue(
      { provider: "saml-jackson", type: "oidc", providerAccountId: "x" },
      { tenant_id: "\0abc\x1f\x7f\x9fdef\0" },
    );
    expect(v).toBe("abcdef");
  });

  it("strips bidi override and zero-width characters from claim values (RS6)", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    // U+202E (RIGHT-TO-LEFT OVERRIDE) can visually reverse the characters that
    // follow it when rendered to an operator; U+200B (ZERO WIDTH SPACE) is
    // invisible. Both must be stripped from the value that gets displayed.
    const v = extractTenantClaimValue(
      { provider: "saml-jackson", type: "oidc", providerAccountId: "x" },
      { tenant_id: "alias\u202Eexample\u200Bcorp" },
    );
    expect(v).toBe("aliasexamplecorp");
  });

  it("strips the formatting characters the delegation boundary also rejects (Sec F6)", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    // The six members the two copies of this class both missed before they
    // were merged: U+2028/U+2029 (line/paragraph separators), U+2060 (word
    // joiner), U+180E, U+00AD (soft hyphen), U+061C (Arabic letter mark).
    // Each is invisible or line-breaking on the operator's terminal.
    const widened = [0x2028, 0x2029, 0x2060, 0x180e, 0x00ad, 0x061c]
      .map((cp) => String.fromCodePoint(cp))
      .join("");
    const v = extractTenantClaimValue(
      { provider: "saml-jackson", type: "oidc", providerAccountId: "x" },
      { tenant_id: `alias${widened}.example` },
    );
    expect(v).toBe("alias.example");
  });

  it("strips before trimming, so a space hidden behind a zero-width char is removed (Func F5)", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    // U+200B is not White_Space, so trimming first stops at it and leaves the
    // space in front of the value — which then becomes Tenant.name and the
    // fallback's exact-match key.
    const zwsp = String.fromCodePoint(0x200b);
    const v = extractTenantClaimValue(
      { provider: "saml-jackson", type: "oidc", providerAccountId: "x" },
      { tenant_id: ` ${zwsp} alias.example ` },
    );
    expect(v).toBe("alias.example");
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
