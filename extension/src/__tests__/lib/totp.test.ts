import { describe, it, expect, vi, afterEach } from "vitest";
import { generateTOTPCode } from "../../lib/totp";

// RFC 6238 test secret: "12345678901234567890" as Base32
const RFC_SECRET_SHA1 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
// RFC 6238 test secret for SHA256: "12345678901234567890123456789012" as Base32
const RFC_SECRET_SHA256 =
  "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA";
// RFC 6238 test secret for SHA512: 64 bytes as Base32
const RFC_SECRET_SHA512 =
  "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA";

describe("generateTOTPCode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates correct SHA1 code at RFC 6238 test time T=59", () => {
    vi.spyOn(Date, "now").mockReturnValue(59_000);
    const code = generateTOTPCode({
      secret: RFC_SECRET_SHA1,
      algorithm: "SHA1",
      digits: 8,
      period: 30,
    });
    expect(code).toBe("94287082");
  });

  it("generates correct SHA256 code at RFC 6238 test time T=59", () => {
    vi.spyOn(Date, "now").mockReturnValue(59_000);
    const code = generateTOTPCode({
      secret: RFC_SECRET_SHA256,
      algorithm: "SHA256",
      digits: 8,
      period: 30,
    });
    expect(code).toBe("46119246");
  });

  it("generates correct SHA512 code at RFC 6238 test time T=59", () => {
    vi.spyOn(Date, "now").mockReturnValue(59_000);
    const code = generateTOTPCode({
      secret: RFC_SECRET_SHA512,
      algorithm: "SHA512",
      digits: 8,
      period: 30,
    });
    expect(code).toBe("90693936");
  });

  it("defaults to SHA1, 6 digits, 30s period", () => {
    vi.spyOn(Date, "now").mockReturnValue(59_000);
    const code = generateTOTPCode({ secret: RFC_SECRET_SHA1 });
    // 8-digit SHA1 result is "94287082", 6-digit truncation is "287082"
    expect(code).toBe("287082");
    expect(code).toHaveLength(6);
  });

  it("generates different codes at different time steps", () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    const code1 = generateTOTPCode({ secret: RFC_SECRET_SHA1 });
    vi.spyOn(Date, "now").mockReturnValue(30_000);
    const code2 = generateTOTPCode({ secret: RFC_SECRET_SHA1 });
    expect(code1).not.toBe(code2);
  });

  it("throws on invalid base32 secret", () => {
    expect(() => generateTOTPCode({ secret: "!!!INVALID!!!" })).toThrow();
  });

  it("accepts lowercase algorithm and normalizes to uppercase", () => {
    vi.spyOn(Date, "now").mockReturnValue(59_000);
    const code = generateTOTPCode({
      secret: RFC_SECRET_SHA1,
      algorithm: "sha1",
      digits: 8,
      period: 30,
    });
    expect(code).toBe("94287082");
  });

  it("throws INVALID_TOTP on unsupported algorithm", () => {
    expect(() =>
      generateTOTPCode({ secret: RFC_SECRET_SHA1, algorithm: "MD5" }),
    ).toThrow("INVALID_TOTP");
  });

  it("throws INVALID_TOTP when digits is out of range", () => {
    expect(() =>
      generateTOTPCode({ secret: RFC_SECRET_SHA1, digits: 5 }),
    ).toThrow("INVALID_TOTP");
    expect(() =>
      generateTOTPCode({ secret: RFC_SECRET_SHA1, digits: 9 }),
    ).toThrow("INVALID_TOTP");
  });

  it("throws INVALID_TOTP when period is out of range", () => {
    expect(() =>
      generateTOTPCode({ secret: RFC_SECRET_SHA1, period: 10 }),
    ).toThrow("INVALID_TOTP");
    expect(() =>
      generateTOTPCode({ secret: RFC_SECRET_SHA1, period: 90 }),
    ).toThrow("INVALID_TOTP");
  });
});
