import { describe, it, expect } from "vitest";
import { parseDeviceFromUserAgent } from "./parse-user-agent";

describe("parseDeviceFromUserAgent", () => {
  it("returns null for null input", () => {
    expect(parseDeviceFromUserAgent(null)).toBeNull();
  });

  it("detects macOS + Chrome", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    expect(parseDeviceFromUserAgent(ua)).toBe("macOS (Chrome)");
  });

  it("detects Windows + Edge", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";
    expect(parseDeviceFromUserAgent(ua)).toBe("Windows (Edge)");
  });

  it("detects iOS + Safari", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    expect(parseDeviceFromUserAgent(ua)).toBe("iOS (Safari)");
  });

  it("detects Linux + Firefox", () => {
    const ua =
      "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0";
    expect(parseDeviceFromUserAgent(ua)).toBe("Linux (Firefox)");
  });

  it("detects Android + Chrome", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
    expect(parseDeviceFromUserAgent(ua)).toBe("Android (Chrome)");
  });

  it("returns Unknown OS (Browser) for unrecognized UA", () => {
    expect(parseDeviceFromUserAgent("curl/7.81.0")).toBe(
      "Unknown OS (Browser)",
    );
  });

  it("returns null for empty string", () => {
    expect(parseDeviceFromUserAgent("")).toBeNull();
  });
});
