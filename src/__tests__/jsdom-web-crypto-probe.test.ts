// @vitest-environment jsdom
import { describe, it, expect } from "vitest";

// jsdom 28+ delegates crypto.subtle to Node webcrypto. This probe asserts the
// primitives required by encryption-boundary contexts (P6) and crypto-bearing
// hooks (P7) are present and functional. If any assertion fails, fall back to
// `// @vitest-environment node` for those tests and log the deviation.
describe("jsdom Web Crypto probe", () => {
  it("exposes globalThis.crypto.subtle", () => {
    expect(globalThis.crypto).toBeDefined();
    expect(globalThis.crypto.subtle).toBeDefined();
  });

  it("supports HKDF importKey + deriveBits + AES-GCM-256 round-trip with 12-byte IV", async () => {
    const subtle = globalThis.crypto.subtle;

    const ikm = new Uint8Array(32).fill(1);
    const ikmKey = await subtle.importKey(
      "raw",
      ikm,
      { name: "HKDF" },
      false,
      ["deriveBits"],
    );
    const derived = await subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(16),
        info: new TextEncoder().encode("probe"),
      },
      ikmKey,
      256,
    );
    expect(derived.byteLength).toBe(32);

    const aesKey = await subtle.importKey(
      "raw",
      derived,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );

    const iv = new Uint8Array(12).fill(2);
    const plaintext = new TextEncoder().encode("hello-jsdom-webcrypto");
    const ct = await subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plaintext);
    const pt = await subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ct);
    expect(new TextDecoder().decode(pt)).toBe("hello-jsdom-webcrypto");
  });
});
