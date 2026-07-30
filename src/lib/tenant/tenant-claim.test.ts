import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractTenantClaimValue, parseTenantClaimKeys, slugifyTenant } from "./tenant-claim";
import { MAX_TENANT_CLAIM_LENGTH } from "@/lib/validations/common.server";

const SAML_ACCOUNT = {
  provider: "saml-jackson",
  type: "oidc" as const,
  providerAccountId: "x",
};
const GOOGLE_ACCOUNT = {
  provider: "google",
  type: "oauth" as const,
  providerAccountId: "x",
};

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
    expect(v).toEqual({ kind: "claim", value: "acme" });
  });

  it("falls back to google hd claim", () => {
    const v = extractTenantClaimValue(GOOGLE_ACCOUNT, { hd: "example.com" });
    expect(v).toEqual({ kind: "claim", value: "example.com" });
  });

  it("AUTH_TENANT_CLAIM_KEYS=hd selects the Google hosted-domain claim and nothing else", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "hd");
    const v = extractTenantClaimValue(GOOGLE_ACCOUNT, {
      hd: "example.com",
      organization: "self-asserted-corp",
    });
    // The attested claim wins, and the self-asserted attribute the default
    // list would have preferred is not consulted at all (round-1 M4).
    expect(v).toEqual({ kind: "claim", value: "example.com" });
  });

  it("AUTH_TENANT_CLAIM_KEYS=hd ignores an hd attribute from a non-Google provider", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "hd");
    // `hd` means "Google asserted this hosted domain". A SAML profile carrying
    // a field of the same name is self-asserted, so it must not resolve.
    //
    // ABSENT, not malformed: the provider gate is a refusal to READ a key, not
    // a judgement on a value. Classifying it as malformed would deny every
    // sign-in from a SAML profile that merely happens to carry a field named
    // `hd`, which is a lockout of the shape this PR exists to fix.
    const v = extractTenantClaimValue(SAML_ACCOUNT, { hd: "attacker.example" });
    expect(v).toEqual({ kind: "absent" });
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
      expect(v).toEqual({ kind: "absent" });
    },
  );

  it("AUTH_TENANT_CLAIM_KEYS=HD still resolves the Google hosted domain", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "HD");
    // The key itself is not case-folded — Google spells the attribute `hd`, so
    // `profile["HD"]` is empty and the attested fallback at the bottom of
    // extractTenantClaimValue supplies the value, as it does when the variable
    // is unset.
    const v = extractTenantClaimValue(GOOGLE_ACCOUNT, { hd: "example.com" });
    expect(v).toEqual({ kind: "claim", value: "example.com" });
  });

  it("does not case-fold non-hd claim keys", () => {
    // parseTenantClaimKeys must keep camelCase keys verbatim: profile attribute
    // names are case-sensitive, and `tenantId` is one of the shipped defaults.
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenantId");
    expect(parseTenantClaimKeys()).toEqual(["tenantId"]);
    const v = extractTenantClaimValue(SAML_ACCOUNT, { tenantId: "acme" });
    expect(v).toEqual({ kind: "claim", value: "acme" });
  });

  it("unset AUTH_TENANT_CLAIM_KEYS keeps the default list ahead of the hd fallback", () => {
    const v = extractTenantClaimValue(GOOGLE_ACCOUNT, {
      organization: "acme",
      hd: "example.com",
    });
    expect(v).toEqual({ kind: "claim", value: "acme" });
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
    expect(v).toEqual({ kind: "claim", value: exactValue });
  });

  // ── Absent: nothing was asserted, so the sign-in proceeds claim-less ──────
  //
  // This arm is an ALLOW at both consumers, which is why the boundary between
  // it and `malformed` is the whole subject of round-3 M1 and of round-4's
  // corrections to it. A cause belongs here only when it is indistinguishable
  // from the IdP omitting the attribute.

  it("reports an absent claim when no configured key is present on the profile", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    expect(extractTenantClaimValue(SAML_ACCOUNT, { email: "u@example.com" })).toEqual({
      kind: "absent",
    });
  });

  it("reports an absent claim when there is no profile at all", () => {
    expect(extractTenantClaimValue(SAML_ACCOUNT, null)).toEqual({ kind: "absent" });
    expect(extractTenantClaimValue()).toEqual({ kind: "absent" });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
  ])("reports an absent claim when the key is present but %s", (_label, value) => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    expect(extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: value })).toEqual({
      kind: "absent",
    });
  });

  // Round-4 F2 + S6 (converged). Round 3 classified these `malformed` and
  // DENIED. SAML attributes are multi-valued by specification and BoxyHQ
  // Jackson surfaces them into the OIDC profile as JSON arrays, so a
  // deployment whose `organization` — a shipped default key — arrives as
  // `["acme"]` went from working to denying every sign-in. Denying also buys
  // nothing an omission does not already give away.
  it.each([
    ["number", 42],
    ["boolean", true],
    ["object", { nested: "value" }],
    ["array of one string", ["acme"]],
    ["empty array", []],
  ])("reports an absent claim for a non-string %s value", (_label, value) => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    expect(extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: value })).toEqual({
      kind: "absent",
    });
  });

  it("falls through a non-string key to a later key that carries a real claim", () => {
    // The lockout F2/S6 named, as a test: `groups` arrives as an array and
    // `hd` carries the real value. Round 3 stopped at `groups` and denied.
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "groups,hd");
    const v = extractTenantClaimValue(GOOGLE_ACCOUNT, {
      groups: ["engineering", "all"],
      hd: "example.com",
    });
    expect(v).toEqual({ kind: "claim", value: "example.com" });
  });

  // Round-4 T2. `\t \n \r \v \f` are C0 controls, so they are members of the
  // unsafe class as well as whitespace — and round 3 ran the unsafe test
  // BEFORE the trim, so a pretty-printed SAML `<AttributeValue>` (the ordinary
  // shape of SAML XML) was refused and the sign-in denied. Round 3's tests
  // sampled the one member that behaved differently, U+0020, and its comment
  // asserted the whole class. Parameterised now, per member.
  const ASCII_WHITESPACE: ReadonlyArray<[string, string]> = [
    ["space", " "],
    ["tab", "\t"],
    ["newline", "\n"],
    ["carriage return", "\r"],
    ["vertical tab", "\v"],
    ["form feed", "\f"],
    ["CRLF", "\r\n"],
  ];

  it.each(ASCII_WHITESPACE)("trims surrounding %s from an otherwise clean value", (_label, ws) => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    const v = extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: `${ws}alias.example${ws}` });
    expect(v).toEqual({ kind: "claim", value: "alias.example" });
  });

  it.each(ASCII_WHITESPACE)("reports an absent claim for a value that is only %s", (_label, ws) => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    // An empty assertion is not an assertion — IdPs emit empty attributes for
    // unset fields, so denying here would lock out working deployments (NF2).
    expect(extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: ws })).toEqual({ kind: "absent" });
  });

  it("reports an absent claim for an empty string", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    expect(extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: "" })).toEqual({ kind: "absent" });
  });

  it("keeps walking the key list past an absent key", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id,organization");
    const v = extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: "  ", organization: "acme" });
    expect(v).toEqual({ kind: "claim", value: "acme" });
  });

  // ── Malformed: a string this deployment refuses ───────────────────────────
  //
  // Round-3 M1. Every case here used to return the same `null` as the absent
  // cases above, and both consumers read that as "no claim presented" — an
  // allow. Measured against round 2, `beta.example` + U+200B went from a
  // `tenant_mismatch` denial to a sign-in into the user's existing tenant,
  // and on the first-ever-sign-in path to a fresh bootstrap tenant with role
  // OWNER. The precondition is only control of the asserted attribute.
  //
  // The refusal carries a DIAGNOSIS, never the value (round-4 S1/S2): the
  // value is what an actor controls, and rendering it into `metadata.claim`
  // put attacker-chosen bytes on the path to a jsonb write, where a truncated
  // surrogate pair silently killed the whole audit row.

  it("reports a malformed claim for values exceeding 255 characters", () => {
    const longValue = "x".repeat(256);
    const v = extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: longValue });
    expect(v).toEqual({
      kind: "malformed",
      diagnosis: `refused: 256 characters (max ${MAX_TENANT_CLAIM_LENGTH})`,
    });
  });

  it("reports a malformed claim whose diagnosis never contains the refused value", () => {
    // The property S1 turns on: nothing an actor chose reaches the audit row.
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    const secret = "a".repeat(300) + "\u{1F600}";
    const v = extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: secret });
    if (v.kind !== "malformed") throw new Error(`expected malformed, got ${v.kind}`);
    expect(v.diagnosis).not.toContain("aaa");
    expect(v.diagnosis).not.toContain("\u{1F600}");
    // Printable ASCII only, so it cannot carry a lone surrogate into jsonb.
    expect(/^[\x20-\x7E]+$/.test(v.diagnosis)).toBe(true);
    expect(v.diagnosis.isWellFormed()).toBe(true);
  });

  it("reports a malformed claim for a NULL byte instead of stripping it (F-D)", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    const v = extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: "acme\0corp" });
    // Stripping would have produced "acmecorp" — a value that selects, or
    // creates, the acmecorp tenant with no record of the character removed.
    expect(v).toEqual({ kind: "malformed", diagnosis: "refused: contains U+0000" });
  });

  it("reports a malformed claim for control characters, naming up to three", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    const v = extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: "\0abc\x1f\x7f\x9fdef\0" });
    expect(v).toEqual({
      kind: "malformed",
      diagnosis: "refused: contains U+0000, U+001F, U+007F and 1 more",
    });
  });

  it("reports a malformed claim for bidi override and zero-width characters (RS6)", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    // U+202E (RIGHT-TO-LEFT OVERRIDE) can visually reverse the characters that
    // follow it when rendered to an operator; U+200B (ZERO WIDTH SPACE) is
    // invisible. Neither may reach the matching key OR the operator's terminal.
    const v = extractTenantClaimValue(SAML_ACCOUNT, {
      tenant_id: "alias\u202Eexample\u200Bcorp",
    });
    expect(v).toEqual({
      kind: "malformed",
      diagnosis: "refused: contains U+200B, U+202E",
    });
  });

  // Round-4 T2's other half: whitespace the ASCII trim leaves but `.trim()`
  // would take. Accepting it would mean the value MATCHED on (after
  // normalizeTenantClaim's `.trim()`) is not the value asserted — the same
  // canonicalisation hazard as the unsafe class, which is why it refuses
  // rather than silently stripping.
  it.each([
    ["U+00A0 NO-BREAK SPACE", "\u00A0"],
    ["U+2003 EM SPACE", "\u2003"],
    ["U+3000 IDEOGRAPHIC SPACE", "\u3000"],
  ])("reports a malformed claim for a leading %s", (_label, ws) => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    const v = extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: `${ws}alias.example` });
    expect(v).toEqual({
      kind: "malformed",
      diagnosis: "refused: leading or trailing non-ASCII whitespace",
    });
  });

  it("refuses a U+FEFF-prefixed claim rather than trimming it onto its neighbour", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    // U+FEFF is BOTH `.trim()` whitespace and a member of the unsafe class.
    // A JS `.trim()` here would have produced `alias.example` and selected the
    // existing tenant — the exact F-D hazard, reintroduced by the T2 fix if
    // that fix had used `.trim()`.
    const v = extractTenantClaimValue(SAML_ACCOUNT, { tenant_id: "\uFEFFalias.example" });
    expect(v).toEqual({ kind: "malformed", diagnosis: "refused: contains U+FEFF" });
  });

  // Round-2 F-D: this function's usable output IS the matching key and the
  // stored externalId/name, so a member of the unsafe class must DENY the
  // claim, not canonicalise it into a NEIGHBOURING one. One case per member,
  // because the hazard is per-character: a class that quietly lost one member
  // would still pass a single combined fixture through the remaining ones.
  it.each([
    ["U+0000", 0x0000],
    ["U+001F", 0x001f],
    ["U+007F", 0x007f],
    ["U+009F", 0x009f],
    ["U+00AD", 0x00ad],
    ["U+061C", 0x061c],
    ["U+180E", 0x180e],
    ["U+200B", 0x200b],
    ["U+200F", 0x200f],
    ["U+2028", 0x2028],
    ["U+2029", 0x2029],
    ["U+202E", 0x202e],
    ["U+2060", 0x2060],
    ["U+2066", 0x2066],
    ["U+FEFF", 0xfeff],
  ])("refuses a claim whose only difference from an existing one is %s", (label, cp) => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id");
    // Interior, not at the edges: an edge C0 whitespace character is trimmed
    // (T2) and an edge U+FEFF has its own case above. This is the
    // canonicalisation hazard proper.
    const v = extractTenantClaimValue(SAML_ACCOUNT, {
      tenant_id: `alias${String.fromCodePoint(cp as number)}.example`,
    });
    // The stripping implementation returned "alias.example" for every row —
    // selecting the existing alias.example tenant with nothing recorded, and
    // invisible to `preflight`'s non-ASCII report because the character was
    // gone before storage.
    expect(v).toEqual({ kind: "malformed", diagnosis: `refused: contains ${label}` });
  });

  it("stops the key walk at the first malformed value", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "tenant_id,organization");
    // Falling through to `organization` would make the tenant depend on which
    // higher-priority key happened to be unreadable — a REFUSED value is an
    // assertion this deployment will not honour, unlike a non-string, which
    // carries no claim at all and does fall through.
    const v = extractTenantClaimValue(SAML_ACCOUNT, {
      tenant_id: "beta.example\u200B",
      organization: "acme",
    });
    expect(v).toEqual({ kind: "malformed", diagnosis: "refused: contains U+200B" });
  });

  it("does not reach the google hd fallback past a malformed configured key", () => {
    vi.stubEnv("AUTH_TENANT_CLAIM_KEYS", "organization");
    const v = extractTenantClaimValue(GOOGLE_ACCOUNT, {
      organization: "beta.example\u200B",
      hd: "example.com",
    });
    expect(v).toEqual({ kind: "malformed", diagnosis: "refused: contains U+200B" });
  });

  it("reports a malformed hd claim reached through the fallback", () => {
    const v = extractTenantClaimValue(GOOGLE_ACCOUNT, { hd: "exa\u00ADmple.com" });
    expect(v).toEqual({ kind: "malformed", diagnosis: "refused: contains U+00AD" });
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
