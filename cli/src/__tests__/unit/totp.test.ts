import { describe, it, expect, vi, afterEach } from "vitest";
import { generateTOTPCode } from "../../lib/totp.js";

describe("totp", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // RFC 6238 test vector base32-encoded secret
  const secret = "JBSWY3DPEHPK3PXP"; // "Hello!" in Base32

  it("generates a 6-digit code by default", () => {
    const code = generateTOTPCode({ secret });
    expect(code).toMatch(/^\d{6}$/);
  });

  it("generates an 8-digit code when specified", () => {
    const code = generateTOTPCode({ secret, digits: 8 });
    expect(code).toMatch(/^\d{8}$/);
  });

  it("accepts SHA256 algorithm", () => {
    const code = generateTOTPCode({ secret, algorithm: "SHA256" });
    expect(code).toMatch(/^\d{6}$/);
  });

  it("accepts SHA512 algorithm", () => {
    const code = generateTOTPCode({ secret, algorithm: "SHA512" });
    expect(code).toMatch(/^\d{6}$/);
  });

  it("throws on invalid algorithm", () => {
    expect(() => generateTOTPCode({ secret, algorithm: "MD5" })).toThrow("INVALID_TOTP");
  });

  it("throws on invalid digits", () => {
    expect(() => generateTOTPCode({ secret, digits: 5 })).toThrow("INVALID_TOTP");
    expect(() => generateTOTPCode({ secret, digits: 9 })).toThrow("INVALID_TOTP");
  });

  it("throws on invalid period", () => {
    expect(() => generateTOTPCode({ secret, period: 10 })).toThrow("INVALID_TOTP");
    expect(() => generateTOTPCode({ secret, period: 61 })).toThrow("INVALID_TOTP");
  });

  it("produces consistent codes for same time window", () => {
    vi.useFakeTimers({ now: new Date("2026-01-15T12:00:00Z") });
    const code1 = generateTOTPCode({ secret });
    const code2 = generateTOTPCode({ secret });
    // Within same 30s window, codes should match
    expect(code1).toBe(code2);
  });
});
