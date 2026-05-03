// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockJsQR } = vi.hoisted(() => ({
  mockJsQR: vi.fn(),
}));

vi.mock("jsqr", () => ({
  default: mockJsQR,
}));

import { scanImageForQR, parseOtpauthUri } from "./qr-scanner-client";

function makeImageData(width: number, height: number): ImageData {
  // jsdom's ImageData; if not available, build a minimal compatible shape.
  const data = new Uint8ClampedArray(width * height * 4);
  return { data, width, height, colorSpace: "srgb" } as unknown as ImageData;
}

describe("scanImageForQR", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the decoded text when jsQR finds a code", () => {
    mockJsQR.mockReturnValue({ data: "https://example.com" });
    const img = makeImageData(100, 100);
    expect(scanImageForQR(img)).toBe("https://example.com");
    expect(mockJsQR).toHaveBeenCalledWith(img.data, 100, 100);
  });

  it("returns null when jsQR returns null", () => {
    mockJsQR.mockReturnValue(null);
    const img = makeImageData(100, 100);
    expect(scanImageForQR(img)).toBeNull();
  });

  it("returns null and skips jsQR when image exceeds MAX_IMAGE_DIMENSION (width)", () => {
    const img = makeImageData(10_000, 100);
    expect(scanImageForQR(img)).toBeNull();
    expect(mockJsQR).not.toHaveBeenCalled();
  });

  it("returns null and skips jsQR when image exceeds MAX_IMAGE_DIMENSION (height)", () => {
    const img = makeImageData(100, 10_000);
    expect(scanImageForQR(img)).toBeNull();
    expect(mockJsQR).not.toHaveBeenCalled();
  });
});

describe("parseOtpauthUri", () => {
  it("parses a minimal totp URI", () => {
    const r = parseOtpauthUri("otpauth://totp/Acme:alice?secret=JBSWY3DPEHPK3PXP");
    expect(r).toEqual({
      secret: "JBSWY3DPEHPK3PXP",
      algorithm: undefined,
      digits: undefined,
      period: undefined,
    });
  });

  it("parses an algorithm parameter (uppercased)", () => {
    const r = parseOtpauthUri(
      "otpauth://totp/x?secret=ABC&algorithm=sha256",
    );
    expect(r?.algorithm).toBe("SHA256");
  });

  it("ignores unsupported algorithms", () => {
    const r = parseOtpauthUri(
      "otpauth://totp/x?secret=ABC&algorithm=MD5",
    );
    expect(r?.algorithm).toBeUndefined();
  });

  it("parses digits within [4..10]", () => {
    const r = parseOtpauthUri(
      "otpauth://totp/x?secret=ABC&digits=8",
    );
    expect(r?.digits).toBe(8);
  });

  it("ignores out-of-range digits", () => {
    const lo = parseOtpauthUri("otpauth://totp/x?secret=ABC&digits=2");
    const hi = parseOtpauthUri("otpauth://totp/x?secret=ABC&digits=99");
    expect(lo?.digits).toBeUndefined();
    expect(hi?.digits).toBeUndefined();
  });

  it("parses period within (0..3600]", () => {
    const r = parseOtpauthUri("otpauth://totp/x?secret=ABC&period=60");
    expect(r?.period).toBe(60);
  });

  it("ignores out-of-range period", () => {
    const zero = parseOtpauthUri("otpauth://totp/x?secret=ABC&period=0");
    const tooBig = parseOtpauthUri(
      "otpauth://totp/x?secret=ABC&period=10000",
    );
    expect(zero?.period).toBeUndefined();
    expect(tooBig?.period).toBeUndefined();
  });

  it("rejects non-otpauth scheme", () => {
    expect(parseOtpauthUri("https://example.com/?secret=ABC")).toBeNull();
  });

  it("rejects otpauth scheme with non-totp host", () => {
    expect(parseOtpauthUri("otpauth://hotp/x?secret=ABC")).toBeNull();
  });

  it("rejects URI with no secret param", () => {
    expect(parseOtpauthUri("otpauth://totp/x?period=30")).toBeNull();
  });

  it("returns null on parse error", () => {
    expect(parseOtpauthUri("not a uri")).toBeNull();
  });
});
