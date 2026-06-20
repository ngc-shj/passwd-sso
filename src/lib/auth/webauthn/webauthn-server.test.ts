import { describe, it, expect, vi, beforeEach } from "vitest";
async function reinitKeyProvider() {
  const { _resetKeyProvider, getKeyProvider } = await import("@/lib/key-provider");
  _resetKeyProvider();
  delete process.env.KEY_PROVIDER;
  await getKeyProvider();
}

describe("getRpOrigin", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.WEBAUTHN_RP_ORIGIN;
    delete process.env.AUTH_URL;
  });

  it("returns WEBAUTHN_RP_ORIGIN when set", async () => {
    vi.stubEnv("WEBAUTHN_RP_ORIGIN", "https://custom.example.com");
    const { getRpOrigin } = await import("./webauthn-server");
    expect(getRpOrigin("localhost")).toBe("https://custom.example.com");
  });

  it("falls back to AUTH_URL origin when WEBAUTHN_RP_ORIGIN is not set", async () => {
    vi.stubEnv("AUTH_URL", "https://auth.example.com/passwd-sso");
    const { getRpOrigin } = await import("./webauthn-server");
    expect(getRpOrigin("localhost")).toBe("https://auth.example.com");
  });

  it("falls back to https://${rpId} when neither is set", async () => {
    const { getRpOrigin } = await import("./webauthn-server");
    expect(getRpOrigin("example.com")).toBe("https://example.com");
  });

  it("prefers WEBAUTHN_RP_ORIGIN over AUTH_URL", async () => {
    vi.stubEnv("WEBAUTHN_RP_ORIGIN", "https://custom.example.com");
    vi.stubEnv("AUTH_URL", "https://auth.example.com");
    const { getRpOrigin } = await import("./webauthn-server");
    expect(getRpOrigin("localhost")).toBe("https://custom.example.com");
  });

  it("falls back to https://${rpId} when AUTH_URL is invalid", async () => {
    vi.stubEnv("AUTH_URL", "not-a-url");
    const { getRpOrigin } = await import("./webauthn-server");
    expect(getRpOrigin("example.com")).toBe("https://example.com");
  });
});

describe("generateDiscoverableAuthOpts", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.WEBAUTHN_RP_ID;
  });

  it("returns options with empty allowCredentials and userVerification required", async () => {
    vi.stubEnv("WEBAUTHN_RP_ID", "example.com");
    const { generateDiscoverableAuthOpts } = await import("./webauthn-server");
    const opts = await generateDiscoverableAuthOpts();
    expect(opts.rpId).toBe("example.com");
    // Discoverable: no allowCredentials filter
    expect(opts.allowCredentials).toEqual([]);
    expect(opts.userVerification).toBe("required");
    expect(opts.challenge).toBeTruthy();
  });

  it("throws when WEBAUTHN_RP_ID is missing", async () => {
    const { generateDiscoverableAuthOpts } = await import("./webauthn-server");
    await expect(generateDiscoverableAuthOpts()).rejects.toThrow("WEBAUTHN_RP_ID");
  });
});

describe("derivePrfSalt", () => {
  beforeEach(async () => {
    vi.resetModules();
    delete process.env.WEBAUTHN_RP_ID;
    delete process.env.WEBAUTHN_PRF_SECRET;
    await reinitKeyProvider();
  });

  it("derives deterministic 64-char hex salt", async () => {
    vi.stubEnv("WEBAUTHN_RP_ID", "example.com");
    vi.stubEnv("WEBAUTHN_PRF_SECRET", "a".repeat(64));
    const { derivePrfSalt } = await import("./webauthn-server");
    const salt = derivePrfSalt();
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    // Same input → same output (deterministic)
    expect(derivePrfSalt()).toBe(salt);
  });

  it("returns same salt regardless of caller (RP-global)", async () => {
    vi.stubEnv("WEBAUTHN_RP_ID", "example.com");
    vi.stubEnv("WEBAUTHN_PRF_SECRET", "a".repeat(64));
    const { derivePrfSalt } = await import("./webauthn-server");
    // Salt is RP-global, not per-user — multiple calls always return same value
    expect(derivePrfSalt()).toBe(derivePrfSalt());
  });

  it("throws when WEBAUTHN_PRF_SECRET is missing", async () => {
    vi.stubEnv("WEBAUTHN_RP_ID", "example.com");
    const { derivePrfSalt } = await import("./webauthn-server");
    expect(() => derivePrfSalt()).toThrow("WEBAUTHN_PRF_SECRET");
  });

  it("throws when WEBAUTHN_PRF_SECRET has wrong length", async () => {
    vi.stubEnv("WEBAUTHN_RP_ID", "example.com");
    vi.stubEnv("WEBAUTHN_PRF_SECRET", "abcd");
    const { derivePrfSalt } = await import("./webauthn-server");
    expect(() => derivePrfSalt()).toThrow();
  });

  it("throws when WEBAUTHN_RP_ID is missing", async () => {
    vi.stubEnv("WEBAUTHN_PRF_SECRET", "a".repeat(64));
    const { derivePrfSalt } = await import("./webauthn-server");
    expect(() => derivePrfSalt()).toThrow("WEBAUTHN_RP_ID");
  });
});

describe("derivePrfSaltV2 (A02-8)", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("WEBAUTHN_RP_ID", "example.com");
    vi.stubEnv("WEBAUTHN_PRF_SECRET", "a".repeat(64));
    await reinitKeyProvider();
  });

  it("derives deterministic 64-char hex output for valid per-cred salt", async () => {
    const { derivePrfSaltV2 } = await import("./webauthn-server");
    const salt = "b".repeat(64);
    const out = derivePrfSaltV2(salt);
    expect(out).toMatch(/^[0-9a-f]{64}$/);
    expect(derivePrfSaltV2(salt)).toBe(out);
  });

  it("produces different outputs for different per-cred salts (collision resistance)", async () => {
    const { derivePrfSaltV2 } = await import("./webauthn-server");
    const out1 = derivePrfSaltV2("a".repeat(64));
    const out2 = derivePrfSaltV2("b".repeat(64));
    expect(out1).not.toBe(out2);
  });

  it("differs from v1 derivePrfSalt() for the same secret (domain separation)", async () => {
    const { derivePrfSalt, derivePrfSaltV2 } = await import("./webauthn-server");
    const v1 = derivePrfSalt();
    const v2 = derivePrfSaltV2("a".repeat(64));
    expect(v1).not.toBe(v2);
  });

  it("throws on bad hex (short)", async () => {
    const { derivePrfSaltV2 } = await import("./webauthn-server");
    expect(() => derivePrfSaltV2("a".repeat(63))).toThrow(/64.*hex/);
  });

  it("throws on bad hex (uppercase)", async () => {
    const { derivePrfSaltV2 } = await import("./webauthn-server");
    expect(() => derivePrfSaltV2("A".repeat(64))).toThrow(/64.*hex/);
  });

  it("throws on bad hex (non-hex chars)", async () => {
    const { derivePrfSaltV2 } = await import("./webauthn-server");
    expect(() => derivePrfSaltV2("z".repeat(64))).toThrow(/64.*hex/);
  });

  it("throws when WEBAUTHN_PRF_SECRET is unset", async () => {
    vi.stubEnv("WEBAUTHN_PRF_SECRET", "");
    await reinitKeyProvider();
    const { derivePrfSaltV2 } = await import("./webauthn-server");
    expect(() => derivePrfSaltV2("a".repeat(64))).toThrow();
  });
});

describe("buildPrfExtensions (A02-8)", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("WEBAUTHN_RP_ID", "example.com");
    vi.stubEnv("WEBAUTHN_PRF_SECRET", "a".repeat(64));
    await reinitKeyProvider();
  });

  it("returns { eval } only when every credential is v1 (NULL prfSalt)", async () => {
    const { buildPrfExtensions } = await import("./webauthn-server");
    const result = buildPrfExtensions([
      { credentialId: "credA", prfSalt: null },
      { credentialId: "credB", prfSalt: null },
    ]);
    expect(result?.eval?.first).toMatch(/^[0-9a-f]{64}$/);
    expect(result?.evalByCredential).toBeUndefined();
  });

  it("returns { evalByCredential } only when every credential is v2", async () => {
    const { buildPrfExtensions } = await import("./webauthn-server");
    const result = buildPrfExtensions([
      { credentialId: "credA", prfSalt: "1".repeat(64) },
      { credentialId: "credB", prfSalt: "2".repeat(64) },
    ]);
    expect(result?.eval).toBeUndefined();
    expect(result?.evalByCredential?.credA?.first).toMatch(/^[0-9a-f]{64}$/);
    expect(result?.evalByCredential?.credB?.first).toMatch(/^[0-9a-f]{64}$/);
    expect(result?.evalByCredential?.credA?.first).not.toBe(
      result?.evalByCredential?.credB?.first,
    );
  });

  it("returns both eval (v1 fallback) and evalByCredential in mixed mode", async () => {
    const { buildPrfExtensions } = await import("./webauthn-server");
    const result = buildPrfExtensions([
      { credentialId: "credLegacy", prfSalt: null },
      { credentialId: "credV2", prfSalt: "1".repeat(64) },
    ]);
    expect(result?.eval?.first).toMatch(/^[0-9a-f]{64}$/);
    expect(result?.evalByCredential).toBeDefined();
    expect(Object.keys(result!.evalByCredential!)).toEqual(["credV2"]);
    // v1 cred is NOT in evalByCredential — it falls through to eval.first.
    expect(result?.evalByCredential?.credLegacy).toBeUndefined();
  });

  it("returns null when WEBAUTHN_PRF_SECRET is unset (PRF disabled)", async () => {
    vi.stubEnv("WEBAUTHN_PRF_SECRET", "");
    await reinitKeyProvider();
    const { buildPrfExtensions } = await import("./webauthn-server");
    const result = buildPrfExtensions([{ credentialId: "credA", prfSalt: null }]);
    expect(result).toBeNull();
  });

  it("handles empty credentials list (no creds → only v1 fallback)", async () => {
    const { buildPrfExtensions } = await import("./webauthn-server");
    const result = buildPrfExtensions([]);
    // No v1 creds, no v2 creds — neither field populated.
    expect(result).toEqual({});
  });
});

describe("generateRegistrationOpts (C8 userID Uint8Array shape)", () => {
  // C8 regression guard: v11 narrowed userID from `string | Uint8Array`
  // to `Uint8Array` only. The wrapper at generateRegistrationOpts calls
  // `new TextEncoder().encode(userId)` to satisfy the new type — verify
  // the resulting wire-format `user.id` is the SAME base64url string that
  // v9's `Buffer.from(userId, "utf-8").toString("base64url")` produced,
  // so existing credentials' userHandle remains compatible.
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("WEBAUTHN_RP_ID", "example.com");
  });

  it("encodes userId via TextEncoder so wire user.id equals v9 base64url(utf8(userId))", async () => {
    const { generateRegistrationOpts } = await import("./webauthn-server");
    const userId = "user-uuid-1234";
    const opts = await generateRegistrationOpts(userId, "user@example.com", []);
    // v9 would have produced this same wire value via
    // `Buffer.from(userId, "utf-8").toString("base64url")`. v11's lib base64url-
    // encodes the Uint8Array we pass — both pipelines must agree.
    const expectedWireId = Buffer.from(userId, "utf-8").toString("base64url");
    expect(opts.user.id).toBe(expectedWireId);
  });

  it("handles non-ASCII userId without truncation", async () => {
    // UTF-8 encoding must preserve multi-byte sequences.
    const { generateRegistrationOpts } = await import("./webauthn-server");
    const userId = "ユーザー-123";
    const opts = await generateRegistrationOpts(userId, "user@example.com", []);
    const expectedWireId = Buffer.from(userId, "utf-8").toString("base64url");
    expect(opts.user.id).toBe(expectedWireId);
  });
});

describe("base64urlToUint8Array / uint8ArrayToBase64url", () => {
  // These are pure functions — no env vars or module reset needed.
  // Import once at the top of the describe block.
  let base64urlToUint8Array: (s: string) => Uint8Array;
  let uint8ArrayToBase64url: (b: Uint8Array) => string;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("./webauthn-server");
    base64urlToUint8Array = mod.base64urlToUint8Array;
    uint8ArrayToBase64url = mod.uint8ArrayToBase64url;
  });

  it("roundtrips arbitrary bytes", () => {
    const original = new Uint8Array([0, 1, 62, 63, 128, 255]);
    const encoded = uint8ArrayToBase64url(original);
    expect(base64urlToUint8Array(encoded)).toEqual(original);
  });

  it("handles empty input", () => {
    expect(uint8ArrayToBase64url(new Uint8Array(0))).toBe("");
    expect(base64urlToUint8Array("")).toEqual(new Uint8Array(0));
  });

  it("uses base64url characters (- and _ instead of + and /)", () => {
    // Bytes 62 and 63 map to + and / in base64, but - and _ in base64url
    const bytes = new Uint8Array([251, 239]); // encodes to ++/ in base64
    const encoded = uint8ArrayToBase64url(bytes);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
  });

  it("decodes a known base64url value", () => {
    // "AQID" = [1, 2, 3]
    expect(base64urlToUint8Array("AQID")).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("generateChallengeId / CHALLENGE_ID_RE (per-flow challenge scoping SSoT)", () => {
  let generateChallengeId: () => string;
  let CHALLENGE_ID_RE: RegExp;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("./webauthn-server");
    generateChallengeId = mod.generateChallengeId;
    CHALLENGE_ID_RE = mod.CHALLENGE_ID_RE;
  });

  it("generates a 32-char lowercase-hex id (16 random bytes)", () => {
    const id = generateChallengeId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("generates distinct ids on each call (entropy guard)", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateChallengeId()));
    expect(ids.size).toBe(50);
  });

  it("validator accepts a freshly generated id", () => {
    expect(CHALLENGE_ID_RE.test(generateChallengeId())).toBe(true);
  });

  it("validator rejects malformed ids — the contract every verify route depends on", () => {
    // Uppercase hex, wrong length, non-hex chars, and key-traversal attempts
    // (colon, wildcard) must all be rejected so they cannot reach Redis key
    // construction. generateChallengeId only ever emits lowercase hex.
    expect(CHALLENGE_ID_RE.test("0123456789ABCDEF0123456789abcdef")).toBe(false); // uppercase
    expect(CHALLENGE_ID_RE.test("0123456789abcdef")).toBe(false); // too short
    expect(CHALLENGE_ID_RE.test("0123456789abcdef0123456789abcdef0")).toBe(false); // too long
    expect(CHALLENGE_ID_RE.test("0123456789abcdef0123456789abcdeg")).toBe(false); // non-hex
    expect(CHALLENGE_ID_RE.test("user-1:0123456789abcdef0123456789ab")).toBe(false); // colon
    expect(CHALLENGE_ID_RE.test("")).toBe(false);
  });
});
