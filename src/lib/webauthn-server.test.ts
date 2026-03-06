import { describe, it, expect, vi, beforeEach } from "vitest";

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
  beforeEach(() => {
    vi.resetModules();
    delete process.env.WEBAUTHN_RP_ID;
    delete process.env.WEBAUTHN_PRF_SECRET;
  });

  it("derives deterministic 64-char hex salt", async () => {
    vi.stubEnv("WEBAUTHN_RP_ID", "example.com");
    vi.stubEnv("WEBAUTHN_PRF_SECRET", "a".repeat(64));
    const { derivePrfSalt } = await import("./webauthn-server");
    const salt = derivePrfSalt("user-1");
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    // Same input → same output (deterministic)
    expect(derivePrfSalt("user-1")).toBe(salt);
  });

  it("returns different salt for different users", async () => {
    vi.stubEnv("WEBAUTHN_RP_ID", "example.com");
    vi.stubEnv("WEBAUTHN_PRF_SECRET", "a".repeat(64));
    const { derivePrfSalt } = await import("./webauthn-server");
    expect(derivePrfSalt("user-1")).not.toBe(derivePrfSalt("user-2"));
  });

  it("throws when WEBAUTHN_PRF_SECRET is missing", async () => {
    vi.stubEnv("WEBAUTHN_RP_ID", "example.com");
    const { derivePrfSalt } = await import("./webauthn-server");
    expect(() => derivePrfSalt("user-1")).toThrow("WEBAUTHN_PRF_SECRET");
  });

  it("throws when WEBAUTHN_PRF_SECRET has wrong length", async () => {
    vi.stubEnv("WEBAUTHN_RP_ID", "example.com");
    vi.stubEnv("WEBAUTHN_PRF_SECRET", "abcd");
    const { derivePrfSalt } = await import("./webauthn-server");
    expect(() => derivePrfSalt("user-1")).toThrow();
  });

  it("throws when WEBAUTHN_RP_ID is missing", async () => {
    vi.stubEnv("WEBAUTHN_PRF_SECRET", "a".repeat(64));
    const { derivePrfSalt } = await import("./webauthn-server");
    expect(() => derivePrfSalt("user-1")).toThrow("WEBAUTHN_RP_ID");
  });
});
