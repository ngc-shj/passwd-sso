import { describe, it, expect } from "vitest";
import { newDeviceLoginEmail } from "./new-device-login";

describe("newDeviceLoginEmail", () => {
  const params = {
    browserName: "Chrome",
    osName: "macOS",
    ipAddress: "203.0.113.5",
    timestamp: "2026-05-03 10:00:00 UTC",
  } as const;

  describe("en locale", () => {
    it("returns the English subject", () => {
      const result = newDeviceLoginEmail("en", params);
      expect(result.subject).toBe("New device login detected");
    });

    it("includes browser/os/ip/timestamp in the HTML body", () => {
      const result = newDeviceLoginEmail("en", params);
      expect(result.html).toContain("Chrome");
      expect(result.html).toContain("macOS");
      expect(result.html).toContain("203.0.113.5");
      expect(result.html).toContain("2026-05-03 10:00:00 UTC");
    });

    it("recommends changing the password in the text body", () => {
      const result = newDeviceLoginEmail("en", params);
      expect(result.text).toMatch(/change your password/i);
    });
  });

  describe("ja locale", () => {
    it("returns the Japanese subject", () => {
      const result = newDeviceLoginEmail("ja", params);
      expect(result.subject).toBe("新しいデバイスからのログインがありました");
    });

    it("includes browser/os/ip in the HTML body", () => {
      const result = newDeviceLoginEmail("ja", params);
      expect(result.html).toContain("Chrome");
      expect(result.html).toContain("macOS");
      expect(result.html).toContain("203.0.113.5");
    });
  });

  it("treats Japanese variants like 'ja-JP' as ja", () => {
    const result = newDeviceLoginEmail("ja-JP", params);
    expect(result.subject).toBe("新しいデバイスからのログインがありました");
  });

  it("falls back to English for unknown locale", () => {
    const result = newDeviceLoginEmail("fr", params);
    expect(result.subject).toBe("New device login detected");
  });

  it("escapes HTML special characters in browserName", () => {
    const result = newDeviceLoginEmail("en", {
      ...params,
      browserName: "<script>x</script>",
    });
    expect(result.html).not.toContain("<script>x</script>");
    expect(result.html).toContain("&lt;script&gt;");
  });

  it("escapes HTML special characters in osName", () => {
    const result = newDeviceLoginEmail("en", {
      ...params,
      osName: "Win<>'\"",
    });
    expect(result.html).toContain("Win&lt;&gt;&#39;&quot;");
  });

  it("does NOT HTML-escape the plain text body", () => {
    const result = newDeviceLoginEmail("en", {
      ...params,
      browserName: "<raw>",
    });
    expect(result.text).toContain("<raw>");
  });
});
