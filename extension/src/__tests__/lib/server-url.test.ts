import { describe, it, expect } from "vitest";
import { isAllowedServerUrl, validateServerUrl } from "../../lib/server-url";

describe("server URL rule", () => {
  it.each([
    ["https on any host", "https://passwd.example/app", true],
    ["http on localhost", "http://localhost:3000", true],
    ["http on 127.0.0.1", "http://127.0.0.1:3000/", true],
    ["http on another host", "http://server.example", false],
    ["http on a LAN address", "http://192.168.1.10:3000", false],
    ["http on a localhost lookalike", "http://localhost.evil.example", false],
    ["a double slash in the path", "https://passwd.example//app", false],
    ["not a URL", "not a url", false],
    ["empty", "", false],
    ["a non-string", 42, false],
  ])("isAllowedServerUrl: %s", (_name, raw, expected) => {
    expect(isAllowedServerUrl(raw)).toBe(expected);
  });

  it("validateServerUrl normalizes and names the refusal", () => {
    expect(validateServerUrl("https://Passwd.Example:443/app/")).toEqual({ ok: true, value: "https://passwd.example/app" });
    expect(validateServerUrl("http://server.example")).toEqual({
      ok: false,
      value: "http://server.example",
      error: "HTTPS_REQUIRED",
    });
  });
});
