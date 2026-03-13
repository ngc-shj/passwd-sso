import { describe, expect, it } from "vitest";
import { toArrayBuffer, textEncode, hexEncode, hexDecode } from "./crypto-utils";

describe("toArrayBuffer", () => {
  it("converts Uint8Array to ArrayBuffer", () => {
    const arr = new Uint8Array([1, 2, 3]);
    const buf = toArrayBuffer(arr);
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("handles zero-length Uint8Array", () => {
    const arr = new Uint8Array(0);
    const buf = toArrayBuffer(arr);
    expect(buf.byteLength).toBe(0);
  });

  it("handles sub-array with offset", () => {
    const base = new Uint8Array([10, 20, 30, 40, 50]);
    const sub = base.subarray(1, 4);
    const buf = toArrayBuffer(sub);
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([20, 30, 40]));
  });
});

describe("textEncode", () => {
  it("encodes empty string", () => {
    const buf = textEncode("");
    expect(buf.byteLength).toBe(0);
  });

  it("encodes ASCII string", () => {
    const buf = textEncode("hello");
    expect(new Uint8Array(buf)).toEqual(
      new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]),
    );
  });

  it("encodes multi-byte UTF-8", () => {
    const buf = textEncode("日本語");
    // 日 = E6 97 A5, 本 = E6 9C AC, 語 = E8 AA 9E -> 9 bytes
    expect(buf.byteLength).toBe(9);
  });
});

describe("hexEncode", () => {
  it("encodes Uint8Array to hex string", () => {
    expect(hexEncode(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe(
      "deadbeef",
    );
  });

  it("encodes ArrayBuffer to hex string", () => {
    const buf = new Uint8Array([0xff, 0x00]).buffer;
    expect(hexEncode(buf)).toBe("ff00");
  });

  it("handles empty input", () => {
    expect(hexEncode(new Uint8Array(0))).toBe("");
  });

  it("pads single-digit hex values", () => {
    expect(hexEncode(new Uint8Array([0x0a]))).toBe("0a");
  });
});

describe("hexDecode", () => {
  it("decodes hex string to Uint8Array", () => {
    expect(hexDecode("deadbeef")).toEqual(
      new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    );
  });

  it("handles empty string", () => {
    expect(hexDecode("")).toEqual(new Uint8Array(0));
  });

  it("round-trips with hexEncode", () => {
    const original = new Uint8Array([0, 128, 255, 1, 42]);
    expect(hexDecode(hexEncode(original))).toEqual(original);
  });

  it("throws on odd-length input", () => {
    expect(() => hexDecode("abc")).toThrow("input length must be even");
    expect(() => hexDecode("a")).toThrow("input length must be even");
  });
});
