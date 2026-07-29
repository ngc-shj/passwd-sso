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

  // Round-2 F-C: AUTH_TENANT_CLAIM_KEYS is operator-typed free text. A key that
  // differs from `hd` only in case used to escape the provider gate entirely,
  // so `HD` was read from ANY provider, un-attested, while the operator
  // believed they had configured attested-only mode.
  it.each(["HD", "Hd", "hD"])(
    "AUTH_TENANT_CLAIM_KEYS=%s still gates on the google provider",
    (key) => {
      vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", key);
      const v = extractTenantClaimValue(
        { provider: "saml-jackson", type: "oidc", providerAccountId: "x" },
        { [key]: "attacker.example" },
      );
      expect(v).toBeNull();
    },
  );

  it("AUTH_TENANT_CLAIM_KEYS=HD still resolves the Google hosted domain", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "HD");
    // The key itself is not case-folded — Google spells the attribute `hd`, so
    // `profile["HD"]` is empty and the attested fallback at the bottom of
    // extractTenantClaimValue supplies the value, as it does when the variable
    // is unset.
    const v = extractTenantClaimValue(
      { provider: "google", type: "oauth", providerAccountId: "x" },
      { hd: "example.com" },
    );
    expect(v).toBe("example.com");
  });

  it("does not case-fold non-hd claim keys", () => {
    // parseTenantClaimKeys must keep camelCase keys verbatim: profile attribute
    // names are case-sensitive, and `tenantId` is one of the shipped defaults.
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenantId");
    expect(parseTenantClaimKeys()).toEqual(["tenantId"]);
    const v = extractTenantClaimValue(
      { provider: "saml-jackson", type: "oidc", providerAccountId: "x" },
      { tenantId: "acme" },
    );
    expect(v).toBe("acme");
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

  it("rejects a claim value containing a NULL byte instead of stripping it (F-D)", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    const v = extractTenantClaimValue(
      { provider: "saml-jackson", type: "oidc", providerAccountId: "x" },
      { tenant_id: "acme\0corp" },
    );
    // Stripping would have produced "acmecorp" — a value that selects, or
    // creates, the acmecorp tenant with no record of the character removed.
    expect(v).toBeNull();
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

  it("rejects control characters in claim values (boundary)", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    const v = extractTenantClaimValue(
      { provider: "saml-jackson", type: "oidc", providerAccountId: "x" },
      { tenant_id: "\0abc\x1f\x7f\x9fdef\0" },
    );
    // Stripping would have produced "abcdef" — see the F-D table below.
    expect(v).toBeNull();
  });

  it("rejects bidi override and zero-width characters in claim values (RS6)", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    // U+202E (RIGHT-TO-LEFT OVERRIDE) can visually reverse the characters that
    // follow it when rendered to an operator; U+200B (ZERO WIDTH SPACE) is
    // invisible. Neither may reach the matching key OR the operator's terminal.
    const v = extractTenantClaimValue(
      { provider: "saml-jackson", type: "oidc", providerAccountId: "x" },
      { tenant_id: "alias\u202Eexample\u200Bcorp" },
    );
    expect(v).toBeNull();
  });

  // Round-2 F-D: this function's output IS the matching key and the stored
  // externalId/name, so a member of the unsafe class must DENY the claim, not
  // canonicalise it into a NEIGHBOURING one. One case per member, because the
  // hazard is per-character: a class that quietly lost one member would still
  // pass a single combined fixture through the remaining ones.
  it.each([
    ["U+0000 NULL", 0x0000],
    ["U+001F UNIT SEPARATOR", 0x001f],
    ["U+007F DELETE", 0x007f],
    ["U+009F APPLICATION PROGRAM COMMAND", 0x009f],
    ["U+00AD SOFT HYPHEN", 0x00ad],
    ["U+061C ARABIC LETTER MARK", 0x061c],
    ["U+180E MONGOLIAN VOWEL SEPARATOR", 0x180e],
    ["U+200B ZERO WIDTH SPACE", 0x200b],
    ["U+200F RIGHT-TO-LEFT MARK", 0x200f],
    ["U+2028 LINE SEPARATOR", 0x2028],
    ["U+2029 PARAGRAPH SEPARATOR", 0x2029],
    ["U+202E RIGHT-TO-LEFT OVERRIDE", 0x202e],
    ["U+2060 WORD JOINER", 0x2060],
    ["U+2066 LEFT-TO-RIGHT ISOLATE", 0x2066],
    ["U+FEFF ZERO WIDTH NO-BREAK SPACE", 0xfeff],
  ])("rejects a claim whose only difference from an existing one is %s", (_label, cp) => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    const v = extractTenantClaimValue(
      { provider: "saml-jackson", type: "oidc", providerAccountId: "x" },
      { tenant_id: `alias${String.fromCodePoint(cp as number)}.example` },
    );
    // The stripping implementation returned "alias.example" for every row —
    // selecting the existing alias.example tenant with nothing recorded, and
    // invisible to `preflight`'s non-ASCII report because the character was
    // gone before storage.
    expect(v).toBeNull();
  });

  it("still trims surrounding whitespace from an otherwise clean value", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    const v = extractTenantClaimValue(
      { provider: "saml-jackson", type: "oidc", providerAccountId: "x" },
      { tenant_id: "  alias.example  " },
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
