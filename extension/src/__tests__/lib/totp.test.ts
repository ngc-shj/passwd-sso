import { describe, it, expect, vi, afterEach } from "vitest";
import { generateTOTPCode } from "../../lib/totp";
import rfc6238Vectors from "../../../test/fixtures/totp-rfc6238-vectors.json";

// SHA1 secret used by behaviour tests below; pulled from the shared fixture
// so iOS XCTest can consume the same vectors via Bundle resource loading.
const RFC_SECRET_SHA1 = rfc6238Vectors.find((v) => v.algorithm === "SHA1")!
  .secret;

describe("generateTOTPCode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const v of rfc6238Vectors) {
    it(`generates correct ${v.algorithm} code at RFC 6238 test time T=${v.T_seconds}`, () => {
      vi.spyOn(Date, "now").mockReturnValue(v.T_seconds * 1000);
      const code = generateTOTPCode({
        secret: v.secret,
        algorithm: v.algorithm,
        digits: v.digits,
        period: v.period,
      });
      expect(code).toBe(v.expected);
    });
  }

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
