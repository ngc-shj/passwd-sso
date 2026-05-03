// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  wrapSecretKeyWithPrf,
  unwrapSecretKeyWithPrf,
  isWebAuthnSupported,
  generateDefaultNickname,
  hexEncode,
} from "./webauthn-client";
import { hexDecode } from "@/lib/crypto/crypto-utils";

// jsdom does not implement btoa for non-Latin1; the implementations under test
// only ever feed it bytes via String.fromCharCode, which is safe.

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hexEncode (re-export)", () => {
  it("returns lowercase hex with no separators", () => {
    expect(hexEncode(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe("deadbeef");
  });

  it("produces an empty string for an empty buffer", () => {
    expect(hexEncode(new Uint8Array())).toBe("");
  });
});

describe("wrapSecretKeyWithPrf / unwrapSecretKeyWithPrf — round-trip via real Web Crypto", () => {
  it("wraps then unwraps to the original key bytes", async () => {
    const secret = new Uint8Array(32);
    crypto.getRandomValues(secret);
    const prf = new Uint8Array(32);
    crypto.getRandomValues(prf);

    const wrapped = await wrapSecretKeyWithPrf(secret, prf);
    expect(wrapped.iv).toMatch(/^[0-9a-f]{24}$/); // 12 bytes IV → 24 hex chars
    expect(wrapped.authTag).toMatch(/^[0-9a-f]{32}$/); // 16 bytes tag → 32 hex chars
    expect(wrapped.ciphertext).toMatch(/^[0-9a-f]{64}$/); // 32 bytes pt → 64 hex chars

    const recovered = await unwrapSecretKeyWithPrf(wrapped, prf);
    expect(recovered).toEqual(secret);
  });

  it("uses a fresh random IV for each wrap (never reuses)", async () => {
    const secret = new Uint8Array(32).fill(7);
    const prf = new Uint8Array(32).fill(11);
    const a = await wrapSecretKeyWithPrf(secret, prf);
    const b = await wrapSecretKeyWithPrf(secret, prf);
    expect(a.iv).not.toBe(b.iv);
    // And the ciphertexts must differ even though the plaintext+key are equal.
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("rejects unwrap with a different PRF output (key derivation mismatch → AES-GCM auth failure)", async () => {
    const secret = new Uint8Array(32).fill(1);
    const prfA = new Uint8Array(32).fill(2);
    const prfB = new Uint8Array(32).fill(3);
    const wrapped = await wrapSecretKeyWithPrf(secret, prfA);
    await expect(unwrapSecretKeyWithPrf(wrapped, prfB)).rejects.toThrow();
  });

  it("rejects unwrap when the auth tag is bit-flipped", async () => {
    const secret = new Uint8Array(32).fill(5);
    const prf = new Uint8Array(32).fill(9);
    const wrapped = await wrapSecretKeyWithPrf(secret, prf);
    const tampered = hexDecode(wrapped.authTag);
    tampered[0] ^= 0x01;
    await expect(
      unwrapSecretKeyWithPrf({ ...wrapped, authTag: hexEncode(tampered) }, prf),
    ).rejects.toThrow();
  });

  it("rejects unwrap when ciphertext is bit-flipped", async () => {
    const secret = new Uint8Array(32).fill(5);
    const prf = new Uint8Array(32).fill(9);
    const wrapped = await wrapSecretKeyWithPrf(secret, prf);
    const tampered = hexDecode(wrapped.ciphertext);
    tampered[0] ^= 0x01;
    await expect(
      unwrapSecretKeyWithPrf({ ...wrapped, ciphertext: hexEncode(tampered) }, prf),
    ).rejects.toThrow();
  });

  it("rejects unwrap when IV is altered (auth failure)", async () => {
    const secret = new Uint8Array(32).fill(5);
    const prf = new Uint8Array(32).fill(9);
    const wrapped = await wrapSecretKeyWithPrf(secret, prf);
    const otherIv = hexEncode(new Uint8Array(12).fill(0xaa));
    await expect(
      unwrapSecretKeyWithPrf({ ...wrapped, iv: otherIv }, prf),
    ).rejects.toThrow();
  });
});

describe("isWebAuthnSupported", () => {
  it("returns true when window.PublicKeyCredential is defined", () => {
    // jsdom does not ship PublicKeyCredential; stub it for this test.
    vi.stubGlobal("PublicKeyCredential", function () {});
    expect(isWebAuthnSupported()).toBe(true);
  });

  it("returns false when window.PublicKeyCredential is undefined", () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    expect(isWebAuthnSupported()).toBe(false);
  });
});

describe("generateDefaultNickname", () => {
  // Helper: stub navigator.userAgent for OS/browser detection branches.
  function stubUA(ua: string): void {
    Object.defineProperty(globalThis.navigator, "userAgent", {
      value: ua,
      configurable: true,
    });
  }

  it("uses OS+browser when transports include 'internal' (platform authenticator)", () => {
    stubUA("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Chrome/120");
    expect(generateDefaultNickname(["internal"])).toBe("macOS (Chrome)");
  });

  it("formats security key with all transport methods listed", () => {
    expect(generateDefaultNickname(["usb", "nfc", "ble"])).toBe(
      "Security Key (USB, NFC, BLE)",
    );
  });

  it("formats security key with only USB", () => {
    expect(generateDefaultNickname(["usb"])).toBe("Security Key (USB)");
  });

  it("returns 'External Device' for hybrid-only transport", () => {
    expect(generateDefaultNickname(["hybrid"])).toBe("External Device");
  });

  it("falls back to OS+browser on empty transport list", () => {
    stubUA("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/120");
    expect(generateDefaultNickname([])).toBe("Windows (Edge)");
  });

  it("detects iOS from iPhone in UA", () => {
    stubUA("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/17");
    expect(generateDefaultNickname(["internal"])).toBe("iOS (Safari)");
  });

  it("detects Android + Firefox", () => {
    stubUA("Mozilla/5.0 (Android 14; Mobile; rv:120.0) Firefox/120.0");
    expect(generateDefaultNickname(["internal"])).toBe("Android (Firefox)");
  });

  it("falls back to 'Unknown OS' / 'Browser' on unrecognized UA", () => {
    stubUA("CustomCrawler/1.0");
    expect(generateDefaultNickname(["internal"])).toBe("Unknown OS (Browser)");
  });

  it("prefers 'internal' branch even when other transports are also present", () => {
    stubUA("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120");
    // Per implementation: isInternal short-circuits before USB/NFC/BLE check.
    expect(generateDefaultNickname(["internal", "usb"])).toBe("macOS (Chrome)");
  });
});
