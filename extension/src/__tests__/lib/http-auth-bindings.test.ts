import { describe, it, expect } from "vitest";
import { normalizeOrigin } from "../../lib/http-auth-bindings";

describe("normalizeOrigin", () => {
  it.each([
    ["drops path, query and fragment", "https://example.com/login?next=/#top", "https://example.com"],
    ["lowercases the host and keeps the scheme", "HTTPS://Example.COM/", "https://example.com"],
    ["omits the default https port", "https://example.com:443/", "https://example.com"],
    ["omits the default http port", "http://router.local:80/", "http://router.local"],
    ["keeps a non-default port", "http://10.0.0.1:8080/basic-auth/u/p", "http://10.0.0.1:8080"],
    ["keeps https on port 80 distinct from http", "https://example.com:80/", "https://example.com:80"],
    ["brackets an IPv6 host", "http://[::1]:3000/x", "http://[::1]:3000"],
    ["drops userinfo", "https://user:pw@example.com/", "https://example.com"],
    ["encodes an IDN host as punycode", "https://bücher.example/", "https://xn--bcher-kva.example"],
  ])("%s", (_name, input, expected) => {
    expect(normalizeOrigin(input)).toBe(expected);
  });

  it.each([
    ["an empty string", ""],
    ["a bare host", "example.com"],
    ["a relative path", "/login"],
    ["an ftp URL", "ftp://example.com/"],
    ["a file URL", "file:///etc/passwd"],
    ["a javascript URL", "javascript:alert(1)"],
    ["a data URL", "data:text/html,hi"],
    ["a chrome-extension URL", "chrome-extension://abc/popup.html"],
    ["an http URL without a host", "http://"],
  ])("returns null for %s", (_name, input) => {
    expect(normalizeOrigin(input)).toBeNull();
  });
});
