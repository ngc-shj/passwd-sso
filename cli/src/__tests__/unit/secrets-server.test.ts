import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.unmock("../../lib/config.js");
});

describe("getSecretsServerUrl", () => {
  it("uses the saved CLI serverUrl", async () => {
    vi.doMock("../../lib/config.js", () => ({
      loadConfig: () => ({ serverUrl: "https://example.com/passwd-sso/", locale: "en" }),
    }));

    const { getSecretsServerUrl } = await import("../../lib/secrets-config.js");
    expect(getSecretsServerUrl()).toBe("https://example.com/passwd-sso");
  });

  it("throws when no saved CLI serverUrl exists", async () => {
    vi.doMock("../../lib/config.js", () => ({
      loadConfig: () => ({ serverUrl: "", locale: "en" }),
    }));

    const { getSecretsServerUrl } = await import("../../lib/secrets-config.js");
    expect(() => getSecretsServerUrl()).toThrow(
      "Server URL not configured. Run `passwd-sso login` first.",
    );
  });
});
