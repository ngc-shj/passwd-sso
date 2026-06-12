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

// A02-8 / T06: PRF extension construction in startPasskeyAuthentication.
// Verifies the three input channels (server-built / evalByCredential param /
// prfSalt param) and their priority/combination behavior. navigator.credentials
// is stubbed to capture the publicKey.extensions.prf shape it receives.
describe("startPasskeyAuthentication PRF extension wiring", () => {
  type CapturedOptions = {
    extensions?: {
      prf?: {
        eval?: { first: ArrayBuffer };
        evalByCredential?: Record<string, { first: ArrayBuffer }>;
      };
    };
  };

  let lastPublicKey: CapturedOptions | null = null;

  beforeEach(() => {
    lastPublicKey = null;
    // Stub a credentials.get that captures the publicKey extensions and
    // returns a minimal PublicKeyCredential-like shape. The PRF extension
    // result mirrors the input first-arg for easy assertion.
    vi.stubGlobal("navigator", {
      ...globalThis.navigator,
      credentials: {
        get: vi.fn(async ({ publicKey }: { publicKey: CapturedOptions }) => {
          lastPublicKey = publicKey;
          return {
            id: "cred-id",
            rawId: new Uint8Array(8).buffer,
            type: "public-key",
            response: {
              clientDataJSON: new Uint8Array(8).buffer,
              authenticatorData: new Uint8Array(8).buffer,
              signature: new Uint8Array(8).buffer,
              userHandle: null,
            },
            getClientExtensionResults: () => ({
              prf: { results: { first: new Uint8Array([1, 2, 3, 4]).buffer } },
            }),
          };
        }),
      },
    });
  });

  it("(C8 case 1) passes server-built extensions.prf through verbatim", async () => {
    const { startPasskeyAuthentication } = await import("./webauthn-client");
    const SERVER_V1_SALT = "a".repeat(64);
    const SERVER_V2_SALT = "b".repeat(64);
    const optionsJSON: Record<string, unknown> = {
      challenge: "Y2hhbGxlbmdl",
      rpId: "localhost",
      allowCredentials: [],
      extensions: {
        prf: {
          eval: { first: SERVER_V1_SALT },
          evalByCredential: { "cred-1": { first: SERVER_V2_SALT } },
        },
      },
    };
    await startPasskeyAuthentication(optionsJSON);

    expect(lastPublicKey?.extensions?.prf?.eval?.first).toBeInstanceOf(Uint8Array);
    expect(lastPublicKey?.extensions?.prf?.evalByCredential?.["cred-1"]?.first).toBeInstanceOf(Uint8Array);
    // Decoded back to hex must match the server-supplied salt (round-trip).
    const decoded = new Uint8Array(lastPublicKey!.extensions!.prf!.eval!.first);
    expect(hexEncode(decoded)).toBe(SERVER_V1_SALT);
  });

  it("(C8 case 2) param-only: prfSalt → top-level eval only", async () => {
    const { startPasskeyAuthentication } = await import("./webauthn-client");
    const SALT = "c".repeat(64);
    await startPasskeyAuthentication(
      { challenge: "Y2hhbGxlbmdl", rpId: "localhost", allowCredentials: [] },
      SALT,
    );

    expect(lastPublicKey?.extensions?.prf?.eval?.first).toBeInstanceOf(Uint8Array);
    expect(lastPublicKey?.extensions?.prf?.evalByCredential).toBeUndefined();
    expect(
      hexEncode(new Uint8Array(lastPublicKey!.extensions!.prf!.eval!.first)),
    ).toBe(SALT);
  });

  it("(C8 case 3) param-only: evalByCredential → no top-level eval", async () => {
    const { startPasskeyAuthentication } = await import("./webauthn-client");
    const SALT = "d".repeat(64);
    await startPasskeyAuthentication(
      { challenge: "Y2hhbGxlbmdl", rpId: "localhost", allowCredentials: [] },
      undefined,
      { "cred-2": SALT },
    );

    expect(lastPublicKey?.extensions?.prf?.eval).toBeUndefined();
    expect(lastPublicKey?.extensions?.prf?.evalByCredential?.["cred-2"]?.first).toBeInstanceOf(Uint8Array);
    expect(
      hexEncode(new Uint8Array(lastPublicKey!.extensions!.prf!.evalByCredential!["cred-2"].first)),
    ).toBe(SALT);
  });

  it("(C8 case 4) param-only: BOTH prfSalt + evalByCredential → both forwarded", async () => {
    const { startPasskeyAuthentication } = await import("./webauthn-client");
    const V1 = "e".repeat(64);
    const V2 = "f".repeat(64);
    await startPasskeyAuthentication(
      { challenge: "Y2hhbGxlbmdl", rpId: "localhost", allowCredentials: [] },
      V1,
      { "cred-3": V2 },
    );

    expect(lastPublicKey?.extensions?.prf?.eval?.first).toBeInstanceOf(Uint8Array);
    expect(lastPublicKey?.extensions?.prf?.evalByCredential?.["cred-3"]?.first).toBeInstanceOf(Uint8Array);
  });

  it("server-built extensions take precedence over client-side params", async () => {
    const { startPasskeyAuthentication } = await import("./webauthn-client");
    const SERVER_SALT = "1".repeat(64);
    const CLIENT_SALT = "2".repeat(64);
    await startPasskeyAuthentication(
      {
        challenge: "Y2hhbGxlbmdl",
        rpId: "localhost",
        allowCredentials: [],
        extensions: { prf: { eval: { first: SERVER_SALT } } },
      },
      CLIENT_SALT, // ignored when server-built path takes precedence
    );

    expect(
      hexEncode(new Uint8Array(lastPublicKey!.extensions!.prf!.eval!.first)),
    ).toBe(SERVER_SALT);
  });

  it("no PRF input → no extensions.prf on the publicKey passed to credentials.get", async () => {
    const { startPasskeyAuthentication } = await import("./webauthn-client");
    await startPasskeyAuthentication({
      challenge: "Y2hhbGxlbmdl",
      rpId: "localhost",
      allowCredentials: [],
    });

    expect(lastPublicKey?.extensions?.prf).toBeUndefined();
  });
});

// In-flight ceremony guard: Chrome services only one WebAuthn ceremony at a
// time and silently drops a concurrent modal request. The guard must abort a
// stale pending ceremony so a new one (or a retry) can surface its prompt.
describe("startPasskeyAuthentication in-flight ceremony guard", () => {
  const AUTH_OPTIONS: Record<string, unknown> = {
    challenge: "Y2hhbGxlbmdl",
    rpId: "localhost",
    allowCredentials: [],
  };

  function credentialResult() {
    return {
      id: "cred-id",
      rawId: new Uint8Array(8).buffer,
      type: "public-key",
      response: {
        clientDataJSON: new Uint8Array(8).buffer,
        authenticatorData: new Uint8Array(8).buffer,
        signature: new Uint8Array(8).buffer,
        userHandle: null,
      },
      getClientExtensionResults: () => ({}),
    };
  }

  // A get()/create() that never settles on its own — only the abort signal
  // can reject it, mirroring a real ceremony waiting for an OS prompt.
  function hangingUntilAbort() {
    return ({ signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
  }

  // Resolve to the promise's value or a TIMED_OUT sentinel if it does not
  // settle within `ms`. Keeps a regression (guard removed → stale ceremony
  // never aborted) failing fast with a clear assertion instead of stalling on
  // vitest's 10s testTimeout.
  const TIMED_OUT = Symbol("timed-out");
  function within<T>(p: Promise<T>, ms = 500): Promise<T | typeof TIMED_OUT> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  beforeEach(async () => {
    const { abortInFlightCeremony } = await import("./webauthn-client");
    abortInFlightCeremony();
  });

  it("aborts a stale pending ceremony when a new one starts; the new one resolves", async () => {
    const get = vi
      .fn()
      .mockImplementationOnce(hangingUntilAbort())
      .mockImplementationOnce(async () => credentialResult());
    vi.stubGlobal("navigator", { ...globalThis.navigator, credentials: { get } });

    const { startPasskeyAuthentication } = await import("./webauthn-client");

    const first = startPasskeyAuthentication(AUTH_OPTIONS);
    const firstSettled = first.then(
      () => "resolved",
      (e: unknown) => e,
    );

    const second = await startPasskeyAuthentication(AUTH_OPTIONS);

    const firstOutcome = await within(firstSettled);
    expect(firstOutcome).toBeInstanceOf(Error);
    expect((firstOutcome as Error).message).toBe("AUTHENTICATION_CANCELLED");
    expect(second.responseJSON).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("abortInFlightCeremony() cancels the in-flight ceremony", async () => {
    const get = vi.fn(hangingUntilAbort());
    vi.stubGlobal("navigator", { ...globalThis.navigator, credentials: { get } });

    const { startPasskeyAuthentication, abortInFlightCeremony } = await import(
      "./webauthn-client"
    );

    const pending = startPasskeyAuthentication(AUTH_OPTIONS);
    const settled = pending.then(
      () => "resolved",
      (e: unknown) => e,
    );

    abortInFlightCeremony();

    const outcome = await within(settled);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("AUTHENTICATION_CANCELLED");
  });

  it("a new authentication aborts a stale pending registration (shared create/get guard)", async () => {
    const create = vi.fn(hangingUntilAbort());
    const get = vi.fn(async () => credentialResult());
    vi.stubGlobal("navigator", {
      ...globalThis.navigator,
      credentials: { create, get },
    });

    const { startPasskeyRegistration, startPasskeyAuthentication } = await import(
      "./webauthn-client"
    );

    const reg = startPasskeyRegistration({
      rp: { id: "localhost", name: "x" },
      user: { id: "dXNlcg", name: "u", displayName: "U" },
      challenge: "Y2hhbGxlbmdl",
      pubKeyCredParams: [],
    });
    const regSettled = reg.then(
      () => "resolved",
      (e: unknown) => e,
    );

    await startPasskeyAuthentication(AUTH_OPTIONS);

    const regOutcome = await within(regSettled);
    expect(regOutcome).toBeInstanceOf(Error);
    expect((regOutcome as Error).message).toBe("REGISTRATION_CANCELLED");
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
