import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/config.js", () => ({
  loadConfig: vi.fn(),
}));

const { loadConfig } = await import("../../lib/config.js");
const { getSecretsServerUrl } = await import("../../lib/secrets-config.js");

beforeEach(() => {
  vi.mocked(loadConfig).mockReset();
});

afterEach(() => {
  vi.mocked(loadConfig).mockReset();
});

describe("getSecretsServerUrl", () => {
  it("uses the saved CLI serverUrl and strips the trailing slash", () => {
    vi.mocked(loadConfig).mockReturnValue({
      serverUrl: "https://example.com/passwd-sso/",
      locale: "en",
    });

    expect(getSecretsServerUrl()).toBe("https://example.com/passwd-sso");
  });

  it("throws when no saved CLI serverUrl exists", () => {
    vi.mocked(loadConfig).mockReturnValue({ serverUrl: "", locale: "en" });

    expect(() => getSecretsServerUrl()).toThrow(/passwd-sso login -s <server-url>/);
  });

  it("rejects a non-HTTPS, non-loopback URL even when stored", () => {
    vi.mocked(loadConfig).mockReturnValue({
      serverUrl: "http://attacker.example/passwd-sso",
      locale: "en",
    });

    expect(() => getSecretsServerUrl()).toThrow(/Server URL must use HTTPS/);
  });

  it("rejects an unsupported protocol scheme", () => {
    vi.mocked(loadConfig).mockReturnValue({
      serverUrl: "file:///etc/passwd",
      locale: "en",
    });

    expect(() => getSecretsServerUrl()).toThrow(/Unsupported protocol/);
  });
});
