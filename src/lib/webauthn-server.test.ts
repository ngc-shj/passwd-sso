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
