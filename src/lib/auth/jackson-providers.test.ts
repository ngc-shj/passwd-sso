import { describe, expect, it } from "vitest";
import {
  CLAIM_BINDING_MODE,
  JACKSON_LEGACY_PROVIDER_ID,
  PROVIDER_ID_PATTERN,
  ProviderConfigError,
  assertClaimBindingBootConfig,
  countClaimProviders,
  deriveClaimBindingMode,
  isGoogleProviderConfigured,
  isJacksonProviderId,
  isProviderIdShape,
  parseJacksonProviders,
  type ProviderEnv,
} from "./jackson-providers";

const JACKSON_URL = "http://jackson.test:5225";
// Distinctive values so "no secret in any message" can search for them.
const LEGACY_ID = "legacy-client-7f3a91";
const LEGACY_SECRET = "legacy-secret-S3CR3T-1";
const SECRET_A = "entry-a-secret-S3CR3T-2";
const SECRET_B = "entry-b-secret-S3CR3T-3";
const SECRETS = [LEGACY_SECRET, SECRET_A, SECRET_B];

type Entry = { id?: unknown; name?: unknown; clientId?: unknown; clientSecret?: unknown; [k: string]: unknown };

function entryA(overrides: Partial<Entry> = {}): Entry {
  return { id: "a", name: "Acme SSO", clientId: "client-a-0b1c", clientSecret: SECRET_A, ...overrides };
}

function entryB(overrides: Partial<Entry> = {}): Entry {
  return { id: "b", name: "Beta SSO", clientId: "client-b-9d8e", clientSecret: SECRET_B, ...overrides };
}

function legacyEnv(overrides: Record<string, string | undefined> = {}): ProviderEnv {
  return { JACKSON_URL, AUTH_JACKSON_ID: LEGACY_ID, AUTH_JACKSON_SECRET: LEGACY_SECRET, ...overrides };
}

function connectionsEnv(entries: unknown, overrides: Record<string, string | undefined> = {}): ProviderEnv {
  return { JACKSON_URL, AUTH_JACKSON_CONNECTIONS: JSON.stringify(entries), ...overrides };
}

function refusalOf(fn: () => unknown): ProviderConfigError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ProviderConfigError) return error;
    throw error;
  }
  throw new Error("expected a ProviderConfigError, got none");
}

function expectNoSecretIn(error: ProviderConfigError, env: ProviderEnv) {
  for (const secret of SECRETS) expect(error.message).not.toContain(secret);
  if (env.AUTH_JACKSON_CONNECTIONS) expect(error.message).not.toContain(env.AUTH_JACKSON_CONNECTIONS);
}

describe("parseJacksonProviders", () => {
  it("returns no provider when nothing is configured", () => {
    expect(parseJacksonProviders({})).toEqual([]);
  });

  it("builds the legacy provider under the saml-jackson id", () => {
    expect(parseJacksonProviders(legacyEnv({ SAML_PROVIDER_NAME: "Corp" }))).toEqual([
      { id: "saml-jackson", name: "Corp", issuer: JACKSON_URL, clientId: LEGACY_ID, clientSecret: LEGACY_SECRET },
    ]);
  });

  it("names the legacy provider SSO when SAML_PROVIDER_NAME is unset", () => {
    expect(parseJacksonProviders(legacyEnv())[0].name).toBe("SSO");
  });

  it("builds one saml-jackson-<id> provider per entry, each with its own credentials", () => {
    expect(parseJacksonProviders(connectionsEnv([entryA(), entryB()]))).toEqual([
      { id: "saml-jackson-a", name: "Acme SSO", issuer: JACKSON_URL, clientId: "client-a-0b1c", clientSecret: SECRET_A },
      { id: "saml-jackson-b", name: "Beta SSO", issuer: JACKSON_URL, clientId: "client-b-9d8e", clientSecret: SECRET_B },
    ]);
  });

  it("lets the legacy pair and entries coexist", () => {
    const ids = parseJacksonProviders({ ...legacyEnv(), ...connectionsEnv([entryA()]) }).map((p) => p.id);
    expect(ids).toEqual(["saml-jackson", "saml-jackson-a"]);
  });

  it("registers nothing for a partial legacy pair (as before)", () => {
    expect(parseJacksonProviders(legacyEnv({ AUTH_JACKSON_SECRET: "" }))).toEqual([]);
    expect(parseJacksonProviders(legacyEnv({ AUTH_JACKSON_ID: undefined }))).toEqual([]);
  });

  it("treats an empty AUTH_JACKSON_CONNECTIONS as unset", () => {
    expect(parseJacksonProviders({ JACKSON_URL, AUTH_JACKSON_CONNECTIONS: "  " })).toEqual([]);
  });

  // Each refusal next to the adjacent value that is allowed, so a refusal that
  // widened to its neighbour (or a check that vanished) fails one of the pair.
  describe.each<{ label: string; refused: ProviderEnv; allowed: ProviderEnv; variable: string }>([
    {
      label: "legacy client id 'dummy'",
      refused: legacyEnv({ AUTH_JACKSON_ID: "dummy" }),
      allowed: legacyEnv({ AUTH_JACKSON_ID: "dummy-client" }),
      variable: "AUTH_JACKSON_ID",
    },
    {
      label: "legacy client id 'DUMMY' (case-insensitive)",
      refused: legacyEnv({ AUTH_JACKSON_ID: "DUMMY" }),
      allowed: legacyEnv({ AUTH_JACKSON_ID: "xdummy" }),
      variable: "AUTH_JACKSON_ID",
    },
    {
      label: "legacy client secret 'dummy'",
      refused: legacyEnv({ AUTH_JACKSON_SECRET: "dummy" }),
      allowed: legacyEnv({ AUTH_JACKSON_SECRET: "dummy2" }),
      variable: "AUTH_JACKSON_SECRET",
    },
    {
      label: "legacy tenant/product-encoded client id",
      refused: legacyEnv({ AUTH_JACKSON_ID: "tenant=acme&product=passwd-sso" }),
      allowed: legacyEnv({ AUTH_JACKSON_ID: "tenant-acme-product-passwd-sso" }),
      variable: "AUTH_JACKSON_ID",
    },
    {
      label: "legacy client id containing '=' alone",
      refused: legacyEnv({ AUTH_JACKSON_ID: "abc=" }),
      allowed: legacyEnv({ AUTH_JACKSON_ID: "abc" }),
      variable: "AUTH_JACKSON_ID",
    },
    {
      label: "legacy federation client id",
      refused: legacyEnv({ AUTH_JACKSON_ID: "fed_0123abcd" }),
      allowed: legacyEnv({ AUTH_JACKSON_ID: "fed0123abcd" }),
      variable: "AUTH_JACKSON_ID",
    },
    {
      label: "entry client id 'dummy'",
      refused: connectionsEnv([entryA({ clientId: "dummy" })]),
      allowed: connectionsEnv([entryA({ clientId: "dummy-a" })]),
      variable: "AUTH_JACKSON_CONNECTIONS",
    },
    {
      label: "entry client secret 'dummy'",
      refused: connectionsEnv([entryA({ clientSecret: "dummy" })]),
      allowed: connectionsEnv([entryA({ clientSecret: "dummyx" })]),
      variable: "AUTH_JACKSON_CONNECTIONS",
    },
    {
      label: "entry client id containing '&'",
      refused: connectionsEnv([entryA(), entryB({ clientId: "a&b" })]),
      allowed: connectionsEnv([entryA(), entryB({ clientId: "ab" })]),
      variable: "AUTH_JACKSON_CONNECTIONS",
    },
    {
      label: "entry federation client id",
      refused: connectionsEnv([entryA({ clientId: "FED_xyz" })]),
      allowed: connectionsEnv([entryA({ clientId: "xfed_xyz" })]),
      variable: "AUTH_JACKSON_CONNECTIONS",
    },
    {
      label: "duplicate entry id",
      refused: connectionsEnv([entryA(), entryB({ id: "a" })]),
      allowed: connectionsEnv([entryA(), entryB({ id: "a2" })]),
      variable: "AUTH_JACKSON_CONNECTIONS",
    },
    {
      label: "client id shared by two entries",
      refused: connectionsEnv([entryA(), entryB({ clientId: "client-a-0b1c" })]),
      allowed: connectionsEnv([entryA(), entryB({ clientId: "client-a-0b1d" })]),
      variable: "AUTH_JACKSON_CONNECTIONS",
    },
    {
      label: "client id shared by the legacy pair and an entry",
      refused: { ...legacyEnv(), ...connectionsEnv([entryA({ clientId: LEGACY_ID })]) },
      allowed: { ...legacyEnv(), ...connectionsEnv([entryA()]) },
      variable: "AUTH_JACKSON_CONNECTIONS",
    },
    {
      label: "entry id longer than 32",
      refused: connectionsEnv([entryA({ id: "a".repeat(33) })]),
      allowed: connectionsEnv([entryA({ id: "a".repeat(32) })]),
      variable: "AUTH_JACKSON_CONNECTIONS",
    },
    {
      label: "entry id with uppercase",
      refused: connectionsEnv([entryA({ id: "Acme" })]),
      allowed: connectionsEnv([entryA({ id: "acme" })]),
      variable: "AUTH_JACKSON_CONNECTIONS",
    },
    {
      label: "entry id with underscore",
      refused: connectionsEnv([entryA({ id: "acme_1" })]),
      allowed: connectionsEnv([entryA({ id: "acme-1" })]),
      variable: "AUTH_JACKSON_CONNECTIONS",
    },
    {
      label: "entry id with a trailing newline",
      refused: connectionsEnv([entryA({ id: "acme\n" })]),
      allowed: connectionsEnv([entryA({ id: "acme" })]),
      variable: "AUTH_JACKSON_CONNECTIONS",
    },
    {
      label: "empty entry id",
      refused: connectionsEnv([entryA({ id: "" })]),
      allowed: connectionsEnv([entryA({ id: "0" })]),
      variable: "AUTH_JACKSON_CONNECTIONS",
    },
    {
      label: "Jackson credentials without JACKSON_URL (legacy)",
      refused: legacyEnv({ JACKSON_URL: undefined }),
      allowed: legacyEnv(),
      variable: "JACKSON_URL",
    },
    {
      label: "Jackson credentials without JACKSON_URL (entries)",
      refused: connectionsEnv([entryA()], { JACKSON_URL: " " }),
      allowed: connectionsEnv([entryA()]),
      variable: "JACKSON_URL",
    },
    {
      label: "entry with an unknown field",
      refused: connectionsEnv([entryA({ secret: "x" })]),
      allowed: connectionsEnv([entryA()]),
      variable: "AUTH_JACKSON_CONNECTIONS",
    },
    {
      label: "entry missing clientSecret",
      refused: connectionsEnv([entryA({ clientSecret: undefined })]),
      allowed: connectionsEnv([entryA()]),
      variable: "AUTH_JACKSON_CONNECTIONS",
    },
    {
      label: "entry with a non-string clientId",
      refused: connectionsEnv([entryA({ clientId: 42 })]),
      allowed: connectionsEnv([entryA({ clientId: "42" })]),
      variable: "AUTH_JACKSON_CONNECTIONS",
    },
    {
      label: "entry name with a bidi control",
      refused: connectionsEnv([entryA({ name: "Acme‮SSO" })]),
      allowed: connectionsEnv([entryA({ name: "Acme SSO" })]),
      variable: "AUTH_JACKSON_CONNECTIONS",
    },
    {
      label: "entry name longer than 64",
      refused: connectionsEnv([entryA({ name: "n".repeat(65) })]),
      allowed: connectionsEnv([entryA({ name: "n".repeat(64) })]),
      variable: "AUTH_JACKSON_CONNECTIONS",
    },
    {
      label: "entries not an array",
      refused: connectionsEnv(entryA()),
      allowed: connectionsEnv([entryA()]),
      variable: "AUTH_JACKSON_CONNECTIONS",
    },
    {
      label: "an empty array",
      refused: connectionsEnv([]),
      allowed: connectionsEnv([entryA()]),
      variable: "AUTH_JACKSON_CONNECTIONS",
    },
    {
      label: "an entry that is not an object",
      refused: connectionsEnv([SECRET_A]),
      allowed: connectionsEnv([entryA()]),
      variable: "AUTH_JACKSON_CONNECTIONS",
    },
  ])("$label", ({ refused, allowed, variable }) => {
    it("is refused on its variable, with no secret or raw JSON in the message", () => {
      const error = refusalOf(() => parseJacksonProviders(refused));
      expect(error.variable).toBe(variable);
      expectNoSecretIn(error, refused);
    });

    it("has an adjacent configuration that is allowed", () => {
      expect(parseJacksonProviders(allowed).length).toBeGreaterThan(0);
    });
  });

  it("names the refused entry's position, keyed on the bare variable", () => {
    const error = refusalOf(() => parseJacksonProviders(connectionsEnv([entryA(), entryB({ clientId: "a&b" })])));
    expect(error.variable).toBe("AUTH_JACKSON_CONNECTIONS");
    expect(error.message.startsWith("AUTH_JACKSON_CONNECTIONS[1]: ")).toBe(true);
  });

  it("refuses invalid JSON without echoing the input (SyntaxError embeds a prefix)", () => {
    const raw = `[{"id":"a","clientSecret":"${SECRET_A}"`;
    const error = refusalOf(() => parseJacksonProviders({ JACKSON_URL, AUTH_JACKSON_CONNECTIONS: raw }));
    expect(error.variable).toBe("AUTH_JACKSON_CONNECTIONS");
    expect(error.message).not.toContain(SECRET_A);
    expect(error.message).not.toContain('"id"');
  });

  it("does not echo an unknown field's name", () => {
    const error = refusalOf(() => parseJacksonProviders(connectionsEnv([entryA({ [SECRET_B]: "x" })])));
    expect(error.message).not.toContain(SECRET_B);
  });
});

describe("isJacksonProviderId", () => {
  const env = { ...legacyEnv(), ...connectionsEnv([entryA()]) };

  it.each(["saml-jackson", "saml-jackson-a"])("accepts the configured id %s", (id) => {
    expect(isJacksonProviderId(id, env)).toBe(true);
  });

  it.each(["saml-jackson-", "saml-jacksonx", "saml-jackson-b", "xsaml-jackson-a", "saml-jackson-a ", "google", ""])(
    "rejects %j",
    (id) => {
      expect(isJacksonProviderId(id, env)).toBe(false);
    },
  );

  it("rejects the legacy id when only entries are configured", () => {
    expect(isJacksonProviderId(JACKSON_LEGACY_PROVIDER_ID, connectionsEnv([entryA()]))).toBe(false);
  });
});

describe("isProviderIdShape", () => {
  // The DB CHECK on the provenance columns states PROVIDER_ID_PATTERN; this
  // pins the TS side of that parity.
  it("is the shared pattern", () => {
    expect(PROVIDER_ID_PATTERN).toBe("^[a-z0-9-]{1,64}$");
  });

  it.each(["google", "nodemailer", "saml-jackson", `saml-jackson-${"a".repeat(32)}`, "a".repeat(64)])(
    "accepts %s",
    (id) => {
      expect(isProviderIdShape(id)).toBe(true);
    },
  );

  it.each(["", "a".repeat(65), "Google", "saml_jackson", "google\n", "gооgle"])("rejects %j", (id) => {
    expect(isProviderIdShape(id)).toBe(false);
  });

  it("accepts every id the parser can generate", () => {
    const ids = parseJacksonProviders({ ...legacyEnv(), ...connectionsEnv([entryA({ id: "z".repeat(32) })]) }).map(
      (p) => p.id,
    );
    for (const id of ids) expect(isProviderIdShape(id)).toBe(true);
  });
});

describe("isGoogleProviderConfigured", () => {
  it("requires both the id and the secret", () => {
    expect(isGoogleProviderConfigured({ AUTH_GOOGLE_ID: "g", AUTH_GOOGLE_SECRET: "s" })).toBe(true);
    expect(isGoogleProviderConfigured({ AUTH_GOOGLE_ID: "g" })).toBe(false);
    expect(isGoogleProviderConfigured({ AUTH_GOOGLE_ID: "g", AUTH_GOOGLE_SECRET: "" })).toBe(false);
    expect(isGoogleProviderConfigured({ AUTH_GOOGLE_SECRET: "s" })).toBe(false);
  });
});

describe("claim binding mode", () => {
  const google = { AUTH_GOOGLE_ID: "g", AUTH_GOOGLE_SECRET: "s" };

  describe.each<{ label: string; env: ProviderEnv; count: number; mode: string; boots: boolean }>([
    { label: "no claim providers", env: {}, count: 0, mode: "off", boots: true },
    { label: "Google alone", env: google, count: 1, mode: "off", boots: true },
    { label: "one Jackson (legacy) alone", env: legacyEnv(), count: 1, mode: "off", boots: true },
    { label: "one Jackson (entry) alone", env: connectionsEnv([entryA()]), count: 1, mode: "off", boots: true },
    { label: "one provider, explicit off", env: legacyEnv({ AUTH_CLAIM_BINDING: "off" }), count: 1, mode: "off", boots: true },
    { label: "one provider, empty value", env: legacyEnv({ AUTH_CLAIM_BINDING: "" }), count: 1, mode: "off", boots: true },
    { label: "one provider, forced strict", env: { ...google, AUTH_CLAIM_BINDING: "strict" }, count: 1, mode: "strict", boots: true },
    {
      label: "Google ID without secret is not counted",
      env: { AUTH_GOOGLE_ID: "g", ...legacyEnv() },
      count: 1,
      mode: "off",
      boots: true,
    },
    { label: "Google + Jackson, strict", env: { ...google, ...legacyEnv(), AUTH_CLAIM_BINDING: "strict" }, count: 2, mode: "strict", boots: true },
    { label: "Google + Jackson, off", env: { ...google, ...legacyEnv(), AUTH_CLAIM_BINDING: "off" }, count: 2, mode: "strict", boots: false },
    { label: "Google + Jackson, unset", env: { ...google, ...legacyEnv() }, count: 2, mode: "strict", boots: false },
    { label: "two Jackson entries, unset", env: connectionsEnv([entryA(), entryB()]), count: 2, mode: "strict", boots: false },
    {
      label: "legacy + two entries, strict",
      env: { ...legacyEnv(), ...connectionsEnv([entryA(), entryB()]), AUTH_CLAIM_BINDING: "strict" },
      count: 3,
      mode: "strict",
      boots: true,
    },
  ])("$label", ({ env, count, mode, boots }) => {
    it(`counts ${count} claim provider(s)`, () => {
      expect(countClaimProviders(env)).toBe(count);
    });

    it(`derives ${mode}`, () => {
      expect(deriveClaimBindingMode(env)).toBe(mode);
    });

    it(boots ? "boots" : "refuses to boot on AUTH_CLAIM_BINDING", () => {
      if (boots) {
        expect(() => assertClaimBindingBootConfig(env)).not.toThrow();
      } else {
        const error = refusalOf(() => assertClaimBindingBootConfig(env));
        expect(error.variable).toBe("AUTH_CLAIM_BINDING");
        expect(error.message).toContain("strict");
        expectNoSecretIn(error, env);
      }
    });
  });

  it.each(["Strict", "STRICT", "on", "true", " strict", "strict "])("refuses the mode value %j", (value) => {
    const env = legacyEnv({ AUTH_CLAIM_BINDING: value });
    expect(refusalOf(() => deriveClaimBindingMode(env)).variable).toBe("AUTH_CLAIM_BINDING");
    expect(refusalOf(() => assertClaimBindingBootConfig(env)).variable).toBe("AUTH_CLAIM_BINDING");
    // Also with two providers, where the derivation would be strict anyway.
    expect(refusalOf(() => deriveClaimBindingMode({ ...google, ...env })).variable).toBe("AUTH_CLAIM_BINDING");
  });

  it("exposes the two modes", () => {
    expect(CLAIM_BINDING_MODE).toEqual({ OFF: "off", STRICT: "strict" });
  });
});
