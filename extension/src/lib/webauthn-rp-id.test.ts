import { describe, expect, it } from "vitest";
import { isRpIdAllowedForHostname } from "./webauthn-rp-id";

describe("isRpIdAllowedForHostname", () => {
  it("allows an exact registrable domain and its subdomains", () => {
    expect(isRpIdAllowedForHostname("example.com", "example.com")).toBe(true);
    expect(isRpIdAllowedForHostname("example.com", "login.example.com")).toBe(true);
  });

  it("rejects unrelated and label-confusion hostnames", () => {
    expect(isRpIdAllowedForHostname("example.com", "evil.com")).toBe(false);
    expect(isRpIdAllowedForHostname("example.com", "notexample.com")).toBe(false);
  });

  it.each(["com", "co.uk", "github.io", "appspot.com"])(
    "rejects public or private suffix %s",
    (suffix) => {
      expect(isRpIdAllowedForHostname(suffix, `tenant.${suffix}`)).toBe(false);
    },
  );

  it("allows a tenant below a private suffix only for that tenant", () => {
    expect(isRpIdAllowedForHostname("alice.github.io", "login.alice.github.io")).toBe(true);
    expect(isRpIdAllowedForHostname("alice.github.io", "bob.github.io")).toBe(false);
  });

  it("canonicalizes Unicode hostnames using IDNA", () => {
    expect(isRpIdAllowedForHostname("bücher.example", "login.xn--bcher-kva.example")).toBe(true);
  });

  it.each(["localhost", "127.0.0.1", "[::1]", "example.com:443", "example.com/path"])(
    "rejects non-domain RP ID %s",
    (rpId) => {
      expect(isRpIdAllowedForHostname(rpId, "example.com")).toBe(false);
    },
  );
});
