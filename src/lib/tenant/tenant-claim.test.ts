import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractTenantClaimValue, parseTenantClaimKeys, slugifyTenant } from "./tenant-claim";

const SAML_ACCOUNT = { provider: "saml-jackson", type: "oidc" as const, providerAccountId: "x" };
const GOOGLE_ACCOUNT = { provider: "google", type: "oauth" as const, providerAccountId: "x" };

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
    const v = extractTenantClaimValue(SAML_ACCOUNT, { tenant: "acme" });
    expect(v).toEqual({ kind: "value", value: "acme" });
  });

  it("falls back to google hd claim", () => {
    const v = extractTenantClaimValue(GOOGLE_ACCOUNT, { hd: "example.com" });
    expect(v).toEqual({ kind: "value", value: "example.com" });
  });

  it("AUTH_TENANT_CLAIM_KEYS=hd selects the Google hosted-domain claim and nothing else", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "hd");
    const v = extractTenantClaimValue(GOOGLE_ACCOUNT, {
      hd: "example.com",
      organization: "self-asserted-corp",
    });
    // The attested claim wins, and the self-asserted attribute the default
    // list would have preferred is not consulted at all (round-1 M4).
    expect(v).toEqual({ kind: "value", value: "example.com" });
  });

  it("AUTH_TENANT_CLAIM_KEYS=hd ignores an hd attribute from a non-Google provider", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "hd");
    // `hd` means "Google asserted this hosted domain". A SAML profile carrying
    // a field of the same name is self-asserted, so it must not resolve. It is
    // "none", not "malformed": the attribute was never read for this provider,
    // so nothing was asserted TO US to refuse.
    const v = extractTenantClaimValue(SAML_ACCOUNT, { hd: "attacker.example" });
    expect(v).toEqual({ kind: "none" });
  });

  // Round-2 F-C: AUTH_TENANT_CLAIM_KEYS is operator-typed free text. A key that
  // differs from `hd` only in case used to escape the provider gate entirely,
  // so `HD` was read from ANY provider, un-attested, while the operator
  // believed they had configured attested-only mode.
  it.each(["HD", "Hd", "hD"])(
    "AUTH_TENANT_CLAIM_KEYS=%s still gates on the google provider",
    (key) => {
      vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", key);
      const v = extractTenantClaimValue(SAML_ACCOUNT, { [key]: "attacker.example" });
      expect(v).toEqual({ kind: "none" });
    },
  );

  it("AUTH_TENANT_CLAIM_KEYS=HD still resolves the Google hosted domain", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "HD");
    // The key itself is not case-folded — Google spells the attribute `hd`, so
    // `profile["HD"]` is empty and the attested fallback at the bottom of
    // extractTenantClaimValue supplies the value, as it does when the variable
    // is unset.
    const v = extractTenantClaimValue(GOOGLE_ACCOUNT, { hd: "example.com" });
    expect(v).toEqual({ kind: "value", value: "example.com" });
  });

  it("does not case-fold non-hd claim keys", () => {
    // parseTenantClaimKeys must keep camelCase keys verbatim: profile attribute
    // names are case-sensitive, and `tenantId` is one of the shipped defaults.
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenantId");
    expect(parseTenantClaimKeys()).toEqual(["tenantId"]);
    const v = extractTenantClaimValue(SAML_ACCOUNT, { tenantId: "acme" });
    expect(v).toEqual({ kind: "value", value: "acme" });
  });

  it("unset AUTH_TENANT_CLAIM_KEYS keeps the default list ahead of the hd fallback", () => {
    const v = extractTenantClaimValue(GOOGLE_ACCOUNT, {
      organization: "acme",
      hd: "example.com",
    });
    expect(v).toEqual({ kind: "value", value: "acme" });
    expect(parseTenantClaimKeys()).toEqual([
      "tenant_id",
      "tenantId",
      "organization",
      "org",
      "company",
      "company_id",
    ]);
  });

  it("accepts claim value of exactly 255 characters", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    const exactValue = "x".repeat(255);
    const v = extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: exactValue });
    expect(v).toEqual({ kind: "value", value: exactValue });
  });

  it("still trims surrounding whitespace from an otherwise clean value", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    const v = extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: "  alias.example  " });
    expect(v).toEqual({ kind: "value", value: "alias.example" });
  });

  // ---------------------------------------------------------------------
  // Absent vs. malformed (round-3 S3-1 / F3)
  //
  // Both consumers read "no claim" as an ALLOW — src/auth.ts falls through to
  // the claim-less path, and the adapter's createUser hands out a fresh
  // bootstrap tenant with role OWNER. So the ONLY inputs that may report
  // "none" are the ones where the IdP asserted nothing at all. Anything the
  // IdP did assert and we could not use must be distinguishable, or the
  // refusal silently becomes an allow.
  // ---------------------------------------------------------------------

  describe("absent — nothing was asserted", () => {
    it("reports none when the profile is absent entirely", () => {
      expect(extractTenantClaimValue(SAML_ACCOUNT, null)).toEqual({ kind: "none" });
      expect(extractTenantClaimValue(SAML_ACCOUNT, undefined)).toEqual({ kind: "none" });
    });

    it("reports none when no configured key is present in the profile", () => {
      vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
      expect(extractTenantClaimValue(SAML_ACCOUNT, { sub: "u1" })).toEqual({ kind: "none" });
    });

    it("reports none for an explicitly null or undefined attribute value", () => {
      vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
      // JSON null is the conventional encoding of "this attribute has no
      // value" — the same thing omission says. An attacker who can send it
      // gains nothing they could not get by omitting the attribute, which is
      // the test that separates this arm from the ones below.
      expect(extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: null })).toEqual({ kind: "none" });
      expect(extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: undefined })).toEqual({
        kind: "none",
      });
    });
  });

  describe("malformed — a value was asserted and we cannot use it", () => {
    it("reports malformed for non-string claim values (number, boolean, object)", () => {
      vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
      expect(extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: 42 })).toEqual({
        kind: "malformed",
      });
      expect(extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: true })).toEqual({
        kind: "malformed",
      });
      expect(extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: { nested: "value" } })).toEqual({
        kind: "malformed",
      });
    });

    it("reports malformed for an array-valued attribute", () => {
      vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
      // A SAML attribute can arrive multi-valued. Reading it as "no claim" is
      // the evasion: the same actor who can set the attribute can wrap it in
      // an array and keep the membership the asserted value would deny.
      expect(extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: ["beta.example"] })).toEqual({
        kind: "malformed",
      });
    });

    it("reports malformed for whitespace-only claim values", () => {
      vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
      expect(extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: "   " })).toEqual({
        kind: "malformed",
      });
      expect(extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: "" })).toEqual({
        kind: "malformed",
      });
    });

    it("reports malformed for claim values exceeding 255 characters", () => {
      const longValue = "x".repeat(256);
      expect(extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: longValue })).toEqual({
        kind: "malformed",
      });
    });

    it("reports malformed for a claim value containing a NULL byte instead of stripping it (F-D)", () => {
      vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
      // Stripping would have produced "acmecorp" — a value that selects, or
      // creates, the acmecorp tenant with no record of the character removed.
      expect(extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: "acme\0corp" })).toEqual({
        kind: "malformed",
      });
    });

    it("reports malformed when the claim value is only NULL bytes", () => {
      vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
      expect(extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: "\0\0\0" })).toEqual({
        kind: "malformed",
      });
    });

    it("reports malformed for control characters in claim values (boundary)", () => {
      vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
      // Stripping would have produced "abcdef" — see the F-D table below.
      expect(
        extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: "\0abc\x1f\x7f\x9fdef\0" }),
      ).toEqual({ kind: "malformed" });
    });

    it("reports malformed for bidi override and zero-width characters (RS6)", () => {
      vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
      // U+202E (RIGHT-TO-LEFT OVERRIDE) can visually reverse the characters that
      // follow it when rendered to an operator; U+200B (ZERO WIDTH SPACE) is
      // invisible. Neither may reach the matching key OR the operator's terminal.
      expect(
        extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: "alias\u202Eexample\u200Bcorp" }),
      ).toEqual({ kind: "malformed" });
    });

    it("reports malformed for a mangled Google hosted domain", () => {
      // The attested fallback is not exempt: a `hd` that cannot be used is
      // still a refusal, not an absence.
      expect(extractTenantClaimValue(GOOGLE_ACCOUNT, { hd: "example\u200B.com" })).toEqual({
        kind: "malformed",
      });
    });
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
  ])(
    "reports malformed, not none, for a claim whose only difference from an existing one is %s",
    (_label, cp) => {
      vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
      const v = extractTenantClaimValue(SAML_ACCOUNT, {
        tenant_id: `alias${String.fromCodePoint(cp as number)}.example`,
      });
      // Round 2 returned the SAME null here as for an absent attribute, and
      // both consumers read that null as "the IdP presented no claim" — an
      // allow. The kind is the whole point of the assertion.
      expect(v).toEqual({ kind: "malformed" });
    },
  );

  // The four rows of the round-3 S3-1 table, at the ingest boundary. Rows 1
  // and 3 must keep resolving (the deny happens downstream, on the resolved
  // value); rows 2 and 4 must be refusals rather than absences.
  it.each([
    ["a registered claim for another tenant", "beta.example", { kind: "value", value: "beta.example" }],
    ["the same claim with a zero-width space", "beta.example\u200B", { kind: "malformed" }],
    ["an unregistered claim", "xyz", { kind: "value", value: "xyz" }],
    ["the same unregistered claim with a soft hyphen", "xyz\u00AD", { kind: "malformed" }],
  ])("%s extracts as expected", (_label, asserted, expected) => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    expect(extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: asserted })).toEqual(expected);
  });

  it("a usable later key still wins over an earlier malformed one", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id,organization");
    // Refusing the whole extraction on the first unusable key would deny
    // sign-ins for profiles that carry a perfectly good claim under another
    // configured key. Only an extraction that found NO usable value at all is
    // a refusal.
    const v = extractTenantClaimValue(SAML_ACCOUNT, {
      tenant_id: "  ",
      organization: "acme.example",
    });
    expect(v).toEqual({ kind: "value", value: "acme.example" });
  });

  it("reports malformed when every configured key is unusable", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id,organization");
    const v = extractTenantClaimValue(SAML_ACCOUNT, {
      tenant_id: "alias\u200B.example",
      organization: 42,
    });
    expect(v).toEqual({ kind: "malformed" });
  });

  it("an absent key alongside a malformed one still reports malformed", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id,organization");
    const v = extractTenantClaimValue(SAML_ACCOUNT, { organization: "alias\u200B.example" });
    expect(v).toEqual({ kind: "malformed" });
  });

  it("slugifies tenant strings", () => {
    expect(slugifyTenant(" ACME Corp. ")).toBe("acme-corp");
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
