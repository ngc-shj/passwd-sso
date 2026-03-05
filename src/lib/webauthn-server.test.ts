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
