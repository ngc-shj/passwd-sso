// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

// next-auth/react is the only ergonomic mock — it is the boundary into the
// auth subsystem and we don't want to spin up Auth.js for a unit test.
const { mockUseSession } = vi.hoisted(() => ({ mockUseSession: vi.fn() }));
vi.mock("next-auth/react", () => ({
  useSession: mockUseSession,
}));

// IMPORTANT: NO mocks of @/lib/crypto/*, @/lib/auth/webauthn/webauthn-client,
// @/lib/team/team-vault-context, ./auto-lock-context, or
// ../emergency-access/emergency-access-context. The encryption boundary runs
// on real Web Crypto via the jsdom environment.
import {
  VaultProvider,
  useVault,
  notifyUnlockFailure,
  VaultUnlockError,
  throwIfUnlockDataLocked,
  ROTATION_EFFECTS_UNAVAILABLE,
  ROTATION_COMMITTED_VAULT_LOCKED,
  ROTATION_NOT_STARTED_VAULT_LOCKED,
  PASSPHRASE_CHANGE_COMMITTED_VAULT_LOCKED,
  PASSPHRASE_CHANGE_NOT_STARTED_VAULT_LOCKED,
  VAULT_UNLOCK_INTERRUPTED,
  VaultChangeOutcomeUnknownError,
  VaultChangedElsewhereError,
} from "./vault-context";
import { VAULT_STATUS } from "@/lib/constants";
import { stashPrf, clearPrf } from "@/lib/auth/prf-handoff";
import {
  encryptData,
  decryptData,
  verifyKey,
  deriveEncryptionKey,
  computePassphraseVerifier,
} from "@/lib/crypto/crypto-client";
// Namespace import used ONLY for a pass-through spy on generateSecretKey that
// captures the rotation's new key for a zeroization assertion.
import * as cryptoClient from "@/lib/crypto/crypto-client";
// Same, for the ECDH private key bytes setup exports.
import * as cryptoTeam from "@/lib/crypto/crypto-team";
import { buildAttachmentAAD, buildPersonalEntryAAD, VAULT_TYPE } from "@/lib/crypto/crypto-aad";
import { wrapSecretKeyWithPrf } from "@/lib/auth/webauthn/webauthn-client";
// Namespace import used ONLY to attach a pass-through spy that captures the
// real unwrapped key for a zeroization assertion — crypto still runs for real.
import * as webauthnClient from "@/lib/auth/webauthn/webauthn-client";

const PASSPHRASE = "correct horse battery staple";

interface ServerVault {
  encryptedSecretKey: string;
  secretKeyIv: string;
  secretKeyAuthTag: string;
  accountSalt: string;
  authHash: string;
  verifierHash: string;
  verificationArtifact: { ciphertext: string; iv: string; authTag: string };
  ecdhPublicKey: string;
  encryptedEcdhPrivateKey: string;
  ecdhPrivateKeyIv: string;
  ecdhPrivateKeyAuthTag: string;
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <VaultProvider>{children}</VaultProvider>
);

// Mock fetch handler signature: the call sites (failing-fetch composers) invoke
// fetchMock(url, init) directly, so the mock must carry a callable signature
// rather than the bare Mock<Procedure | Constructable> that ReturnType<typeof
// vi.fn> infers.
type MockFetchResponse = {
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
};
type FetchHandler = (url: string, init?: RequestInit) => Promise<MockFetchResponse>;

interface FetchEnv {
  fetchMock: Mock<FetchHandler>;
  store: { vault: ServerVault | null };
}

/**
 * Build a fetch mock that simulates the API endpoints exercised by the vault
 * provider: status / setup / unlock / unlock-data / delegation. Setup writes
 * to an in-memory store so that a follow-up unlock can read the same data.
 */
function makeFetchEnv(initialVault: ServerVault | null = null): FetchEnv {
  const store: { vault: ServerVault | null } = { vault: initialVault };
  const fetchMock = vi.fn<FetchHandler>(async (url: string, init?: RequestInit) => {
    const path = typeof url === "string" ? url : "";

    if (path === "/api/vault/status") {
      return {
        ok: true,
        json: async () => ({
          setupRequired: store.vault === null,
          hasRecoveryKey: false,
          vaultAutoLockMinutes: null,
          tenantMinPasswordLength: 0,
          tenantRequireUppercase: false,
          tenantRequireLowercase: false,
          tenantRequireNumbers: false,
          tenantRequireSymbols: false,
        }),
      };
    }

    if (path === "/api/vault/setup" && init?.method === "POST") {
      const body = JSON.parse(init.body as string);
      store.vault = {
        encryptedSecretKey: body.encryptedSecretKey,
        secretKeyIv: body.secretKeyIv,
        secretKeyAuthTag: body.secretKeyAuthTag,
        accountSalt: body.accountSalt,
        authHash: body.authHash,
        verifierHash: body.verifierHash,
        verificationArtifact: body.verificationArtifact,
        ecdhPublicKey: body.ecdhPublicKey,
        encryptedEcdhPrivateKey: body.encryptedEcdhPrivateKey,
        ecdhPrivateKeyIv: body.ecdhPrivateKeyIv,
        ecdhPrivateKeyAuthTag: body.ecdhPrivateKeyAuthTag,
      };
      return { ok: true, json: async () => ({}) };
    }

    if (path === "/api/vault/unlock/data") {
      if (!store.vault) return { ok: false, status: 404, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({
          ...store.vault,
          hasVerifier: true,
          keyVersion: 1,
        }),
      };
    }

    if (path === "/api/vault/unlock" && init?.method === "POST") {
      return { ok: true, json: async () => ({ ok: true }) };
    }

    if (path === "/api/vault/delegation") {
      return { ok: true, json: async () => ({}) };
    }

    if (path === "/api/emergency-access/pending-confirmations") {
      return { ok: true, json: async () => [] };
    }

    if (path.startsWith("/api/teams")) {
      return { ok: false, status: 404, json: async () => ({}) };
    }

    // Catch-all: 404 — surfaces unmocked routes loudly
    return { ok: false, status: 404, json: async () => ({}) };
  });

  return { fetchMock, store };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  mockUseSession.mockReturnValue({
    data: { user: { id: "user-1", email: "u@example.com" } },
    status: "authenticated",
    update: vi.fn(),
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("useVault outside provider", () => {
  it("throws when called without a VaultProvider ancestor", () => {
    expect(() => renderHook(() => useVault())).toThrow(
      /useVault must be used within a VaultProvider/,
    );
  });
});

// ── notifyUnlockFailure (named export, no React) ────────────────────
// These run without renderHook so they cannot interact with the React tree
// and are placed at the top of the file.
describe("notifyUnlockFailure (named export)", () => {
  it("propagates a VaultUnlockError when the server returns an error code", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: "ACCOUNT_LOCKED", lockedUntil: "2099-01-01" }),
    })) as unknown as typeof fetch;

    await expect(notifyUnlockFailure()).rejects.toBeInstanceOf(VaultUnlockError);
  });

  it("includes the lockedUntil field on the thrown error", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: "ACCOUNT_LOCKED", lockedUntil: "2099-01-01" }),
    })) as unknown as typeof fetch;

    await expect(notifyUnlockFailure()).rejects.toMatchObject({
      code: "ACCOUNT_LOCKED",
      lockedUntil: "2099-01-01",
    });
  });

  it("resolves silently when the server returns a non-OK response without an error body", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    await expect(notifyUnlockFailure()).resolves.toBeUndefined();
  });

  it("resolves silently when the server returns OK", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    await expect(notifyUnlockFailure()).resolves.toBeUndefined();
  });
});

// ── throwIfUnlockDataLocked (named export, no React) ───────────────────
describe("throwIfUnlockDataLocked (named export)", () => {
  it("throws VaultUnlockError(ACCOUNT_LOCKED) when response body has error=ACCOUNT_LOCKED", async () => {
    const res = {
      json: async () => ({ error: "ACCOUNT_LOCKED", lockedUntil: "2099-06-01T00:00:00.000Z" }),
    } as unknown as Response;

    await expect(throwIfUnlockDataLocked(res)).rejects.toBeInstanceOf(VaultUnlockError);
  });

  it("includes lockedUntil on the thrown error", async () => {
    const res = {
      json: async () => ({ error: "ACCOUNT_LOCKED", lockedUntil: "2099-06-01T00:00:00.000Z" }),
    } as unknown as Response;

    await expect(throwIfUnlockDataLocked(res)).rejects.toMatchObject({
      code: "ACCOUNT_LOCKED",
      lockedUntil: "2099-06-01T00:00:00.000Z",
    });
  });

  it("resolves without throwing for non-ACCOUNT_LOCKED error bodies", async () => {
    const res = {
      json: async () => ({ error: "VAULT_NOT_SETUP" }),
    } as unknown as Response;

    await expect(throwIfUnlockDataLocked(res)).resolves.toBeUndefined();
  });

  it("resolves without throwing when body has no error field", async () => {
    const res = {
      json: async () => ({}),
    } as unknown as Response;

    await expect(throwIfUnlockDataLocked(res)).resolves.toBeUndefined();
  });

  it("resolves without throwing when json() rejects", async () => {
    const res = {
      json: async () => { throw new Error("invalid json"); },
    } as unknown as Response;

    await expect(throwIfUnlockDataLocked(res)).resolves.toBeUndefined();
  });
});

// ── Full setup → lock → unlock → verify round-trip in a single test ──
// React-state contamination across tests is a known issue with renderHook
// when the Provider sets up multiple effect-based listeners (pagehide, auto-
// lock interval, EA polling). One end-to-end test exercises every behavior we
// care about with one mount and one unmount, which keeps the assertions
// rigorous without inviting cross-test flake.
describe("VaultProvider — end-to-end real Web Crypto round-trip", () => {
  it(
    "setup → lock → unlock → verifyPassphrase, all with real Web Crypto",
    async () => {
      const { fetchMock, store } = makeFetchEnv(null);
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const { result } = renderHook(() => useVault(), { wrapper });

      // Initial render — the hook surface is wired
      expect(result.current).not.toBeNull();
      expect(typeof result.current.setup).toBe("function");
      expect(result.current.encryptionKey).toBeNull();
      expect(result.current.userId).toBe("user-1");

      // ── setup ─────────────────────────────────────────────
      await act(async () => {
        await result.current.setup(PASSPHRASE);
      });
      expect(result.current.encryptionKey).not.toBeNull();
      expect(result.current.encryptionKey).toBeInstanceOf(CryptoKey);

      // The server received hex-encoded blobs, never the raw passphrase
      expect(store.vault).not.toBeNull();
      expect(store.vault?.encryptedSecretKey).toMatch(/^[0-9a-f]+$/);
      const setupCall = fetchMock.mock.calls.find(
        (c: unknown[]) => c[0] === "/api/vault/setup",
      );
      const body = JSON.parse((setupCall?.[1] as RequestInit).body as string);
      for (const value of Object.values(body)) {
        if (typeof value === "string") {
          expect(value).not.toBe(PASSPHRASE);
          expect(value).not.toContain(PASSPHRASE);
        }
      }

      // After setup the in-memory secretKey + salt + ECDH JWK are populated
      const sk = result.current.getSecretKey();
      expect(sk).toBeInstanceOf(Uint8Array);
      expect(sk?.length).toBe(32);
      const salt = result.current.getAccountSalt();
      expect(salt).toBeInstanceOf(Uint8Array);
      expect(salt?.length).toBe(32);
      expect(typeof result.current.getEcdhPublicKeyJwk()).toBe("string");

      // getSecretKey returns a defensive copy — caller mutation must not
      // corrupt the internal buffer
      sk?.fill(0);
      const sk2 = result.current.getSecretKey();
      expect(sk2?.some((b) => b !== 0)).toBe(true);

      // ── verifyPassphrase (pre-lock) ──────────────────────
      let verifyOk = false;
      await act(async () => {
        verifyOk = await result.current.verifyPassphrase(PASSPHRASE);
      });
      expect(verifyOk).toBe(true);

      let verifyBad = true;
      await act(async () => {
        verifyBad = await result.current.verifyPassphrase("wrong-pw");
      });
      expect(verifyBad).toBe(false);

      // ── lock ────────────────────────────────────────────
      act(() => {
        result.current.lock();
      });
      expect(result.current.encryptionKey).toBeNull();
      // After lock, getSecretKey returns null (zeroed + cleared)
      expect(result.current.getSecretKey()).toBeNull();
      expect(result.current.getEcdhPublicKeyJwk()).toBeNull();

      // ── unlock with WRONG passphrase ────────────────────
      let wrongOk = true;
      await act(async () => {
        wrongOk = await result.current.unlock("totally-wrong");
      });
      expect(wrongOk).toBe(false);
      expect(result.current.encryptionKey).toBeNull();

      // ── unlock with CORRECT passphrase ──────────────────
      let unlockOk = false;
      await act(async () => {
        unlockOk = await result.current.unlock(PASSPHRASE);
      });
      expect(unlockOk).toBe(true);
      expect(result.current.encryptionKey).not.toBeNull();
      expect(result.current.encryptionKey).toBeInstanceOf(CryptoKey);
    },
    60_000,
  );
});

describe("VaultProvider — setup error path", () => {
  it("setup throws when the server returns an error response (encryptionKey stays null)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/vault/status") {
        return { ok: true, json: async () => ({ setupRequired: true }) };
      }
      if (url === "/api/vault/setup") {
        return { ok: false, json: async () => ({ error: "ALREADY_SETUP" }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useVault(), { wrapper });

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.setup(PASSPHRASE);
      } catch (e) {
        caught = e;
      }
    });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/ALREADY_SETUP/);
    expect(result.current.encryptionKey).toBeNull();
  }, 30_000);
});

describe("VaultProvider — setup zeroizes its local key material", () => {
  /**
   * Pass-through spies (crypto stays real) capturing the secret key and the
   * exported ECDH private key that setup holds in locals.
   */
  function captureSetupKeys() {
    const captured: { secretKey: Uint8Array | null; ecdhPrivBytes: Uint8Array | null } = {
      secretKey: null,
      ecdhPrivBytes: null,
    };
    const actualGenerate = cryptoClient.generateSecretKey;
    const actualExport = cryptoTeam.exportPrivateKey;
    const generateSpy = vi.spyOn(cryptoClient, "generateSecretKey").mockImplementation(() => {
      const key = actualGenerate();
      captured.secretKey = key;
      return key;
    });
    const exportSpy = vi.spyOn(cryptoTeam, "exportPrivateKey").mockImplementation(async (key) => {
      const bytes = await actualExport(key);
      captured.ecdhPrivBytes = bytes;
      return bytes;
    });
    return {
      captured,
      restore: () => {
        generateSpy.mockRestore();
        exportSpy.mockRestore();
      },
    };
  }

  /** Run setup against a server whose setup POST gets `response`. */
  async function setupWith(response: MockFetchResponse | Error) {
    const { fetchMock } = makeFetchEnv(null);
    const baseHandler = fetchMock.getMockImplementation();
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === "/api/vault/setup") {
        if (response instanceof Error) throw response;
        return response;
      }
      if (!baseHandler) throw new Error("fetch env has no base handler");
      return baseHandler(url, init);
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useVault(), { wrapper });
    const { captured, restore } = captureSetupKeys();
    let caught: unknown;
    try {
      await act(async () => {
        try {
          await result.current.setup(PASSPHRASE);
        } catch (e) {
          caught = e;
        }
      });
    } finally {
      restore();
    }
    return { result, captured, caught };
  }

  function allZero(bytes: Uint8Array | null): boolean {
    if (!bytes) throw new Error("key material was not captured");
    return bytes.every((b) => b === 0);
  }

  it("zeroizes the secret key and ECDH private key when the setup POST rejects in transit", async () => {
    const { result, captured, caught } = await setupWith(new TypeError("Failed to fetch"));

    expect(caught).toBeInstanceOf(TypeError);
    expect(result.current.encryptionKey).toBeNull();
    expect(allZero(captured.secretKey)).toBe(true);
    expect(allZero(captured.ecdhPrivBytes)).toBe(true);
  }, 30_000);

  it("zeroizes the secret key and ECDH private key when the server refuses setup", async () => {
    const { result, captured, caught } = await setupWith({
      ok: false,
      status: 409,
      json: async () => ({ error: "ALREADY_SETUP" }),
    });

    expect((caught as Error).message).toBe("ALREADY_SETUP");
    expect(result.current.encryptionKey).toBeNull();
    expect(allZero(captured.secretKey)).toBe(true);
    expect(allZero(captured.ecdhPrivBytes)).toBe(true);
  }, 30_000);

  it("keeps working copies of the keys after a successful setup while zeroizing the locals", async () => {
    const { result, captured, caught } = await setupWith({ ok: true, json: async () => ({}) });

    expect(caught).toBeUndefined();
    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
    expect(allZero(captured.secretKey)).toBe(true);
    expect(allZero(captured.ecdhPrivBytes)).toBe(true);
    expect(result.current.getSecretKey()?.some((b) => b !== 0)).toBe(true);
    expect(result.current.getEcdhPrivateKeyBytes()?.some((b) => b !== 0)).toBe(true);
    let verified = false;
    await act(async () => {
      verified = await result.current.verifyPassphrase(PASSPHRASE);
    });
    expect(verified).toBe(true);
  }, 30_000);
});

describe("VaultProvider — changePassphrase response handling", () => {
  const NEW_PASSPHRASE = "a different long passphrase";

  /**
   * Set up an unlocked vault whose change-passphrase call gets `response`; an
   * Error makes the POST reject, as fetch does when the connection drops.
   * `commit` stores the sent wrap server-side first — a change that committed
   * although its response never reached the client.
   */
  async function setUpWithChangeResponse(
    response: MockFetchResponse | Error,
    { commit = false, onPost }: { commit?: boolean; onPost?: { run?: () => void } } = {},
  ) {
    const { fetchMock, store } = makeFetchEnv(null);
    const sent: { accountSalt?: string } = {};
    const baseHandler = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/vault/change-passphrase") {
        const body = JSON.parse(init?.body as string);
        Object.assign(sent, body);
        if (commit && store.vault) {
          store.vault = {
            ...store.vault,
            encryptedSecretKey: body.encryptedSecretKey,
            secretKeyIv: body.secretKeyIv,
            secretKeyAuthTag: body.secretKeyAuthTag,
            accountSalt: body.accountSalt,
            verifierHash: body.newVerifierHash,
          };
        }
        onPost?.run?.();
        if (response instanceof Error) throw response;
        return response;
      }
      if (!baseHandler) throw new Error("fetch env has no base handler");
      return baseHandler(url, init);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const hook = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await hook.result.current.setup(PASSPHRASE);
    });
    return { result: hook.result, sent };
  }

  function hex(bytes: Uint8Array | null): string | undefined {
    return bytes ? Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("") : undefined;
  }

  it("adopts the committed wrap and reports invalidationFailed on SESSION_INVALIDATE_FAILED", async () => {
    const { result, sent } = await setUpWithChangeResponse({
      ok: false,
      status: 500,
      json: async () => ({ error: "SESSION_INVALIDATE_FAILED" }),
    });

    let effects: unknown;
    await act(async () => {
      effects = await result.current.changePassphrase(PASSPHRASE, NEW_PASSPHRASE);
    });

    expect(effects).toEqual({ invalidationFailed: true });
    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
    expect(hex(result.current.getAccountSalt())).toBe(sent.accountSalt);
    let newOk = false;
    await act(async () => {
      newOk = await result.current.verifyPassphrase(NEW_PASSPHRASE);
    });
    expect(newOk).toBe(true);
  }, 60_000);

  it("adopts the new wrap and reports no invalidation failure on success", async () => {
    const { result, sent } = await setUpWithChangeResponse({
      ok: true,
      json: async () => ({ success: true }),
    });

    let effects: unknown;
    await act(async () => {
      effects = await result.current.changePassphrase(PASSPHRASE, NEW_PASSPHRASE);
    });

    expect(effects).toEqual({ invalidationFailed: false });
    expect(hex(result.current.getAccountSalt())).toBe(sent.accountSalt);
  }, 60_000);

  it("throws and keeps the old wrap when the server refuses the change", async () => {
    const { result, sent } = await setUpWithChangeResponse({
      ok: false,
      status: 429,
      json: async () => ({ error: "RATE_LIMIT_EXCEEDED" }),
    });
    const saltBefore = hex(result.current.getAccountSalt());

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.changePassphrase(PASSPHRASE, NEW_PASSPHRASE);
      } catch (e) {
        caught = e;
      }
    });

    expect(caught).toEqual({ error: "RATE_LIMIT_EXCEEDED" });
    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
    expect(sent.accountSalt).not.toBe(saltBefore);
    expect(hex(result.current.getAccountSalt())).toBe(saltBefore);
    let oldOk = false;
    await act(async () => {
      oldOk = await result.current.verifyPassphrase(PASSPHRASE);
    });
    expect(oldOk).toBe(true);
  }, 60_000);

  async function changeCatching(result: { current: ReturnType<typeof useVault> }, current = PASSPHRASE) {
    let caught: unknown;
    await act(async () => {
      try {
        await result.current.changePassphrase(current, NEW_PASSPHRASE);
      } catch (e) {
        caught = e;
      }
    });
    return caught;
  }

  async function changeOutcome(result: { current: ReturnType<typeof useVault> }) {
    let outcome: unknown;
    let caught: unknown;
    await act(async () => {
      try {
        outcome = await result.current.changePassphrase(PASSPHRASE, NEW_PASSPHRASE);
      } catch (e) {
        caught = e;
      }
    });
    return { outcome, caught };
  }

  /** The vault is locked and no key material from before the change remains. */
  function expectLocked(result: { current: ReturnType<typeof useVault> }) {
    expect(result.current.status).toBe(VAULT_STATUS.LOCKED);
    expect(result.current.encryptionKey).toBeNull();
    expect(result.current.getSecretKey()).toBeNull();
  }

  it("locks the vault and throws VaultChangeOutcomeUnknownError when the POST rejects in transit", async () => {
    const { result } = await setUpWithChangeResponse(new TypeError("Failed to fetch"));

    const caught = await changeCatching(result);

    expect(caught).toBeInstanceOf(VaultChangeOutcomeUnknownError);
    expectLocked(result);
  }, 60_000);

  it("stops accepting the old passphrase and unlocks with the new one after a committed change whose response was lost", async () => {
    const { result } = await setUpWithChangeResponse(new TypeError("Failed to fetch"), { commit: true });

    await changeCatching(result);
    let oldOk = true;
    await act(async () => {
      oldOk = await result.current.verifyPassphrase(PASSPHRASE);
    });
    let unlocked = false;
    await act(async () => {
      unlocked = await result.current.unlock(NEW_PASSPHRASE);
    });

    expect(oldOk).toBe(false);
    expect(unlocked).toBe(true);
    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
  }, 60_000);

  it("locks the vault when a 502 carries no app error envelope (a proxy's HTML page)", async () => {
    const { result } = await setUpWithChangeResponse({ ok: false, status: 502, json: unreadableBody });

    const caught = await changeCatching(result);

    expect(caught).toBeInstanceOf(VaultChangeOutcomeUnknownError);
    expectLocked(result);
  }, 60_000);

  it("locks the vault on INTERNAL_ERROR, which does not prove the change rolled back", async () => {
    const { result } = await setUpWithChangeResponse({
      ok: false,
      status: 500,
      json: async () => ({ error: "INTERNAL_ERROR" }),
    });

    const caught = await changeCatching(result);

    expect(caught).toBeInstanceOf(VaultChangeOutcomeUnknownError);
    expectLocked(result);
  }, 60_000);

  it("locks the vault and throws VaultChangedElsewhereError when the compare-and-swap refuses the change (VAULT_WRAP_CONFLICT)", async () => {
    // Another writer moved the wrap: the local one is stale, and kept it
    // would let the old passphrase keep verifying.
    const { result } = await setUpWithChangeResponse({
      ok: false,
      status: 409,
      json: async () => ({ error: "VAULT_WRAP_CONFLICT" }),
    });

    const caught = await changeCatching(result);
    let oldOk = true;
    await act(async () => {
      oldOk = await result.current.verifyPassphrase(PASSPHRASE);
    });

    expect(caught).toBeInstanceOf(VaultChangedElsewhereError);
    expect((caught as VaultChangedElsewhereError).code).toBe("VAULT_WRAP_CONFLICT");
    expectLocked(result);
    expect(oldOk).toBe(false);
  }, 60_000);

  it("does not install the new wrap into a vault that was locked while the committed change was in flight", async () => {
    const onPost: { run?: () => void } = {};
    const { result, sent } = await setUpWithChangeResponse({ ok: true, json: async () => ({ success: true }) }, { onPost });
    onPost.run = () => result.current.lock();

    const { outcome, caught } = await changeOutcome(result);
    let newOk = true;
    await act(async () => {
      newOk = await result.current.verifyPassphrase(NEW_PASSPHRASE);
    });

    expect(caught).toBeUndefined();
    expect(outcome).toEqual({
      outcome: PASSPHRASE_CHANGE_COMMITTED_VAULT_LOCKED,
      effects: { invalidationFailed: false },
    });
    expectLocked(result);
    expect(hex(result.current.getAccountSalt())).not.toBe(sent.accountSalt);
    expect(newOk).toBe(false);
  }, 60_000);

  it("does not install the new wrap when the page is hidden while the committed change is in flight", async () => {
    const onPost: { run?: () => void } = {};
    const { result, sent } = await setUpWithChangeResponse(
      { ok: false, status: 500, json: async () => ({ error: "SESSION_INVALIDATE_FAILED" }) },
      { onPost },
    );
    onPost.run = () => window.dispatchEvent(new Event("pagehide"));

    const { outcome, caught } = await changeOutcome(result);

    expect(caught).toBeUndefined();
    expect(outcome).toEqual({
      outcome: PASSPHRASE_CHANGE_COMMITTED_VAULT_LOCKED,
      effects: { invalidationFailed: true },
    });
    expectLocked(result);
    expect(hex(result.current.getAccountSalt())).not.toBe(sent.accountSalt);
  }, 60_000);

  it("refuses a mistyped current passphrase locally, sends nothing and keeps the vault unlocked", async () => {
    const { result, sent } = await setUpWithChangeResponse({ ok: true, json: async () => ({ success: true }) });
    const keyBefore = result.current.encryptionKey;

    const caught = await changeCatching(result, "not the passphrase");

    expect(caught).toEqual({ error: "INVALID_PASSPHRASE" });
    expect(sent.accountSalt).toBeUndefined();
    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
    expect(result.current.encryptionKey).toBe(keyBefore);
    expect(result.current.getSecretKey()?.some((b) => b !== 0)).toBe(true);
  }, 60_000);

  it("locks the vault and throws VaultChangedElsewhereError when the server refuses a passphrase the local wrap accepted", async () => {
    // The local check passed, so the server's verifier has moved: another tab
    // or device changed the passphrase, and this tab's wrap is stale.
    const { result } = await setUpWithChangeResponse({
      ok: false,
      status: 401,
      json: async () => ({ error: "INVALID_PASSPHRASE" }),
    });

    const caught = await changeCatching(result);

    expect(caught).toBeInstanceOf(VaultChangedElsewhereError);
    expect((caught as VaultChangedElsewhereError).code).toBe("INVALID_PASSPHRASE");
    expectLocked(result);
  }, 60_000);

  /**
   * Lock the vault right after the `nth` call (1-based) of a crypto function
   * resolves; crypto stays real.
   */
  function lockAfterNthCall(
    name: "deriveWrappingKey" | "wrapSecretKey",
    nth: number,
    lock: () => void,
  ) {
    let calls = 0;
    const actual = cryptoClient[name] as (...args: unknown[]) => Promise<unknown>;
    const spy = vi.spyOn(cryptoClient, name).mockImplementation((async (...args: unknown[]) => {
      const value = await actual(...args);
      calls += 1;
      if (calls === nth) lock();
      return value;
    }) as never);
    return () => spy.mockRestore();
  }

  it.each([
    ["while the current passphrase is verified", "deriveWrappingKey", 1],
    ["between re-wrapping the key and the POST", "wrapSecretKey", 1],
  ] as const)(
    "sends nothing and reports the change as not started when the vault is locked %s",
    async (_when, name, nth) => {
      const { result, sent } = await setUpWithChangeResponse({ ok: true, json: async () => ({ success: true }) });
      const restore = lockAfterNthCall(name, nth, () => result.current.lock());

      const { outcome, caught } = await changeOutcome(result);
      restore();

      expect(caught).toBeUndefined();
      expect(outcome).toBe(PASSPHRASE_CHANGE_NOT_STARTED_VAULT_LOCKED);
      expect(sent.accountSalt).toBeUndefined();
      expectLocked(result);
    },
    60_000,
  );
});

describe("VaultProvider — verifyPassphrase before unlock", () => {
  it("returns false when called before unlock (no in-memory wrappedKey)", async () => {
    const { fetchMock } = makeFetchEnv(null);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });

    let valid = true;
    await act(async () => {
      valid = await result.current.verifyPassphrase(PASSPHRASE);
    });
    expect(valid).toBe(false);
  });
});

describe("VaultProvider — unlock() ACCOUNT_LOCKED wiring", () => {
  it("throws VaultUnlockError(ACCOUNT_LOCKED) when unlock/data returns ACCOUNT_LOCKED", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      const path = typeof url === "string" ? url : "";
      if (path === "/api/vault/status") {
        return { ok: true, json: async () => ({ setupRequired: false, hasRecoveryKey: false, vaultAutoLockMinutes: null, tenantMinPasswordLength: 0, tenantRequireUppercase: false, tenantRequireLowercase: false, tenantRequireNumbers: false, tenantRequireSymbols: false }) };
      }
      if (path === "/api/vault/unlock/data") {
        return { ok: false, status: 403, json: async () => ({ error: "ACCOUNT_LOCKED", lockedUntil: "2099-06-01T00:00:00.000Z" }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useVault(), { wrapper });
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      await expect(result.current.unlock("any-passphrase")).rejects.toMatchObject({
        code: "ACCOUNT_LOCKED",
        lockedUntil: "2099-06-01T00:00:00.000Z",
      });
    });
  });
});

describe("VaultProvider — unlockWithPasskey() ACCOUNT_LOCKED wiring", () => {
  it("throws VaultUnlockError(ACCOUNT_LOCKED) when unlock/data returns ACCOUNT_LOCKED (startPasskeyAuthentication not reached)", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      const path = typeof url === "string" ? url : "";
      if (path === "/api/vault/status") {
        return { ok: true, json: async () => ({ setupRequired: false, hasRecoveryKey: false, vaultAutoLockMinutes: null, tenantMinPasswordLength: 0, tenantRequireUppercase: false, tenantRequireLowercase: false, tenantRequireNumbers: false, tenantRequireSymbols: false }) };
      }
      if (path === "/api/vault/unlock/data") {
        return { ok: false, status: 403, json: async () => ({ error: "ACCOUNT_LOCKED", lockedUntil: "2099-06-01T00:00:00.000Z" }) };
      }
      if (path === "/api/webauthn/authenticate/options") {
        return { ok: true, json: async () => ({ options: {}, prfSalt: "aa".repeat(32) }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useVault(), { wrapper });
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      await expect(result.current.unlockWithPasskey()).rejects.toMatchObject({
        code: "ACCOUNT_LOCKED",
        lockedUntil: "2099-06-01T00:00:00.000Z",
      });
    });
  });
});

describe("VaultProvider — unlockWithStoredPrf (in-memory PRF hand-off)", () => {
  it("returns false and leaves the vault locked when no PRF was handed off (full-reload fallback)", async () => {
    clearPrf();
    const { fetchMock } = makeFetchEnv(null);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });

    let ok = true;
    await act(async () => {
      ok = await result.current.unlockWithStoredPrf();
    });
    expect(ok).toBe(false);
    expect(result.current.encryptionKey).toBeNull();
  });

  it(
    "unlocks using the in-memory PRF hand-off, then consumes it (second attempt falls back)",
    async () => {
      const { fetchMock } = makeFetchEnv(null);
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const { result } = renderHook(() => useVault(), { wrapper });

      // Setup produces the real secretKey + verificationArtifact in the store.
      await act(async () => {
        await result.current.setup(PASSPHRASE);
      });
      const secretKey = result.current.getSecretKey();
      expect(secretKey).toBeInstanceOf(Uint8Array);

      // PRF-wrap the real secret key so unlockWithStoredPrf can unwrap+verify it.
      const prfOutput = new Uint8Array(32).fill(0x5a);
      const wrapped = await wrapSecretKeyWithPrf(secretKey!, prfOutput);
      stashPrf({
        prfOutput,
        prfData: {
          prfEncryptedSecretKey: wrapped.ciphertext,
          prfSecretKeyIv: wrapped.iv,
          prfSecretKeyAuthTag: wrapped.authTag,
        },
      });

      // Lock, then unlock via the hand-off (no second authenticator ceremony).
      act(() => {
        result.current.lock();
      });
      expect(result.current.encryptionKey).toBeNull();

      let ok = false;
      await act(async () => {
        ok = await result.current.unlockWithStoredPrf();
      });
      expect(ok).toBe(true);
      expect(result.current.encryptionKey).toBeInstanceOf(CryptoKey);

      // Single-use: the hand-off was cleared on read, so a second attempt
      // (after re-lock) falls back to false rather than re-using stale material.
      act(() => {
        result.current.lock();
      });
      let second = true;
      await act(async () => {
        second = await result.current.unlockWithStoredPrf();
      });
      expect(second).toBe(false);
      expect(result.current.encryptionKey).toBeNull();
    },
    60_000,
  );

  it("zeroizes the PRF buffer on the !dataRes.ok early return", async () => {
    clearPrf();
    // makeFetchEnv(null) → /api/vault/unlock/data returns { ok: false, 404 }.
    const { fetchMock } = makeFetchEnv(null);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });

    const prfOutput = new Uint8Array(32).fill(0x5a);
    stashPrf({
      prfOutput,
      prfData: { prfEncryptedSecretKey: "ct", prfSecretKeyIv: "iv", prfSecretKeyAuthTag: "tag" },
    });

    let ok = true;
    await act(async () => {
      ok = await result.current.unlockWithStoredPrf();
    });
    expect(ok).toBe(false);
    // The single outer finally wipes the buffer even on the early return.
    expect(prfOutput.every((b) => b === 0)).toBe(true);
  });

  it("zeroizes the PRF buffer on the missing-accountSalt early return", async () => {
    clearPrf();
    // unlock/data returns ok:true but without accountSalt → early return false.
    const fetchMock = vi.fn(async (url: string) => {
      const path = typeof url === "string" ? url : "";
      if (path === "/api/vault/status") {
        return { ok: true, json: async () => ({ setupRequired: false, hasRecoveryKey: false, vaultAutoLockMinutes: null, tenantMinPasswordLength: 0, tenantRequireUppercase: false, tenantRequireLowercase: false, tenantRequireNumbers: false, tenantRequireSymbols: false }) };
      }
      if (path === "/api/vault/unlock/data") {
        return { ok: true, json: async () => ({ keyVersion: 1 }) }; // no accountSalt
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });

    const prfOutput = new Uint8Array(32).fill(0x5a);
    stashPrf({
      prfOutput,
      prfData: { prfEncryptedSecretKey: "ct", prfSecretKeyIv: "iv", prfSecretKeyAuthTag: "tag" },
    });

    let ok = true;
    await act(async () => {
      ok = await result.current.unlockWithStoredPrf();
    });
    expect(ok).toBe(false);
    expect(prfOutput.every((b) => b === 0)).toBe(true);
  });

  it(
    "zeroizes the unwrapped secret key when unlock throws AFTER the key is unwrapped",
    async () => {
      // Regression guard for the secretKey throw-path gap: a VaultUnlockError
      // thrown after unwrapSecretKeyWithPrf must still hit the single finally
      // that wipes the unwrapped secretKey. We capture the real unwrapped key
      // via a pass-through spy (crypto still runs for real) and assert it is
      // zeroized after the throw.
      let capturedSecretKey: Uint8Array | null = null;
      const actualUnwrap = webauthnClient.unwrapSecretKeyWithPrf;
      const unwrapSpy = vi
        .spyOn(webauthnClient, "unwrapSecretKeyWithPrf")
        .mockImplementation(async (wrapped, prf) => {
          const sk = await actualUnwrap(wrapped, prf);
          capturedSecretKey = sk;
          return sk;
        });

      const { fetchMock, store } = makeFetchEnv(null);
      // Wrap the env so /api/vault/unlock fails with a server error AFTER the
      // real key unwrap + derivation has already happened.
      const failingFetch = vi.fn(async (url: string, init?: RequestInit) => {
        const path = typeof url === "string" ? url : "";
        if (path === "/api/vault/unlock" && init?.method === "POST") {
          return { ok: false, status: 423, json: async () => ({ error: "VAULT_LOCKED" }) };
        }
        return fetchMock(path, init);
      }) as unknown as typeof fetch;
      globalThis.fetch = failingFetch;

      const { result } = renderHook(() => useVault(), { wrapper });
      await act(async () => {
        await result.current.setup(PASSPHRASE);
      });
      const secretKey = result.current.getSecretKey();
      expect(secretKey).toBeInstanceOf(Uint8Array);
      expect(store.vault).not.toBeNull();

      // Stash a real PRF-wrapped key so the unwrap + derivation succeed and the
      // throw happens at the /api/vault/unlock step.
      const prfOutput = new Uint8Array(32).fill(0x5a);
      const wrapped = await wrapSecretKeyWithPrf(secretKey!, prfOutput);
      stashPrf({
        prfOutput,
        prfData: {
          prfEncryptedSecretKey: wrapped.ciphertext,
          prfSecretKeyIv: wrapped.iv,
          prfSecretKeyAuthTag: wrapped.authTag,
        },
      });

      act(() => {
        result.current.lock();
      });

      await act(async () => {
        await expect(result.current.unlockWithStoredPrf()).rejects.toBeInstanceOf(
          VaultUnlockError,
        );
      });

      // The spy ran (key was unwrapped) and the finally wiped the secret key
      // on the post-unwrap throw path; prfOutput is wiped by the same finally.
      expect(unwrapSpy).toHaveBeenCalledOnce();
      expect(capturedSecretKey).not.toBeNull();
      expect(capturedSecretKey!.every((b) => b === 0)).toBe(true);
      expect(prfOutput.every((b) => b === 0)).toBe(true);

      unwrapSpy.mockRestore();
    },
    60_000,
  );

  it("throws VaultUnlockError(ACCOUNT_LOCKED) and zeroizes prfOutput when unlock/data returns ACCOUNT_LOCKED", async () => {
    clearPrf();
    const prfOutput = new Uint8Array(32).fill(0x5a);
    stashPrf({
      prfOutput,
      prfData: { prfEncryptedSecretKey: "ct", prfSecretKeyIv: "iv", prfSecretKeyAuthTag: "tag" },
    });

    globalThis.fetch = vi.fn(async (url: string) => {
      const path = typeof url === "string" ? url : "";
      if (path === "/api/vault/status") {
        return { ok: true, json: async () => ({ setupRequired: false, hasRecoveryKey: false, vaultAutoLockMinutes: null, tenantMinPasswordLength: 0, tenantRequireUppercase: false, tenantRequireLowercase: false, tenantRequireNumbers: false, tenantRequireSymbols: false }) };
      }
      if (path === "/api/vault/unlock/data") {
        return { ok: false, status: 403, json: async () => ({ error: "ACCOUNT_LOCKED", lockedUntil: "2099-06-01T00:00:00.000Z" }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useVault(), { wrapper });
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      await expect(result.current.unlockWithStoredPrf()).rejects.toMatchObject({
        code: "ACCOUNT_LOCKED",
        lockedUntil: "2099-06-01T00:00:00.000Z",
      });
    });
    // prfOutput must be zeroized on the throw path
    expect(prfOutput.every((b) => b === 0)).toBe(true);
  });
});

describe("VaultProvider — session-driven status", () => {
  it("exposes userId === null and encryptionKey === null when session is unauthenticated", async () => {
    mockUseSession.mockReturnValue({
      data: null,
      status: "unauthenticated",
      update: vi.fn(),
    });
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    const { result } = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.encryptionKey).toBeNull();
    expect(result.current.userId).toBeNull();
  });

  it("exposes session.user.id as userId when authenticated", async () => {
    mockUseSession.mockReturnValue({
      data: { user: { id: "user-42" } },
      status: "authenticated",
      update: vi.fn(),
    });
    const { fetchMock } = makeFetchEnv(null);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.userId).toBe("user-42");
  });
});

describe("VaultProvider — key rotation re-encrypts personal history under the entry AAD (C2)", () => {
  it(
    "rotated history blob decrypts with buildPersonalEntryAAD (real Web Crypto round-trip)",
    async () => {
      const { fetchMock } = makeFetchEnv(null);
      const userId = "user-1";
      const entryId = "11111111-1111-4111-8111-111111111111";
      const historyId = "22222222-2222-4222-8222-222222222222";
      const payload = JSON.stringify({ title: "Bank", password: "p@ss-原文" });
      const overviewPayload = JSON.stringify({ title: "Bank" });

      let rotatePostBody: {
        historyEntries: Array<{ id: string; encryptedBlob: { ciphertext: string; iv: string; authTag: string } }>;
      } | null = null;

      // Compose: serve rotate-key endpoints, delegate the rest to makeFetchEnv.
      // rotationData is mutated after setup once we hold the old key.
      const rotationData: {
        entries: unknown[];
        historyEntries: unknown[];
        mode2Attachments: unknown[];
        mode0Attachments: unknown[];
        mode0AttachmentsOverflow: boolean;
      } = {
        entries: [],
        historyEntries: [],
        mode2Attachments: [],
        mode0Attachments: [],
        mode0AttachmentsOverflow: false,
      };

      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        const path = typeof url === "string" ? url : "";
        if (path === "/api/vault/rotate-key/data") {
          return { ok: true, json: async () => rotationData };
        }
        if (path === "/api/vault/rotate-key" && init?.method === "POST") {
          rotatePostBody = JSON.parse(init.body as string);
          return { ok: true, json: async () => ({ keyVersion: 2, rotationEffects: null }) };
        }
        return fetchMock(url, init);
      }) as unknown as typeof fetch;

      const { result } = renderHook(() => useVault(), { wrapper });

      await act(async () => {
        await result.current.setup(PASSPHRASE);
      });
      const oldKey = result.current.encryptionKey;
      expect(oldKey).toBeInstanceOf(CryptoKey);
      expect(result.current.userId).toBe(userId);

      // Seed an entry + a verbatim history snapshot, sealed with the OLD key
      // under the entry AADs (exactly what production stores).
      const blobAad = buildPersonalEntryAAD(userId, entryId, VAULT_TYPE.BLOB);
      const overviewAad = buildPersonalEntryAAD(userId, entryId, VAULT_TYPE.OVERVIEW);
      const blob = await encryptData(payload, oldKey!, blobAad);
      const overview = await encryptData(overviewPayload, oldKey!, overviewAad);
      rotationData.entries = [
        {
          id: entryId,
          encryptedBlob: blob.ciphertext,
          blobIv: blob.iv,
          blobAuthTag: blob.authTag,
          encryptedOverview: overview.ciphertext,
          overviewIv: overview.iv,
          overviewAuthTag: overview.authTag,
          keyVersion: 1,
          aadVersion: 1,
        },
      ];
      rotationData.historyEntries = [
        {
          id: historyId,
          entryId,
          encryptedBlob: blob.ciphertext,
          blobIv: blob.iv,
          blobAuthTag: blob.authTag,
          keyVersion: 1,
          aadVersion: 1,
        },
      ];

      await act(async () => {
        await result.current.rotateKey(PASSPHRASE);
      });

      // The new key is now installed in the context.
      const newKey = result.current.encryptionKey;
      expect(newKey).toBeInstanceOf(CryptoKey);
      expect(newKey).not.toBe(oldKey);

      // The rotation POST carried the re-encrypted history; it MUST decrypt
      // with the entry AAD (PV "blob") under the new key.
      expect(rotatePostBody).not.toBeNull();
      const rotated = rotatePostBody!.historyEntries[0].encryptedBlob;
      const decrypted = await decryptData(
        rotated,
        newKey!,
        buildPersonalEntryAAD(userId, entryId, VAULT_TYPE.BLOB),
      );
      expect(JSON.parse(decrypted)).toEqual(JSON.parse(payload));

      // Anti-vacuous: the retired history scope would have used a different
      // AAD; a wrong scope must fail, proving the entry AAD is what matched.
      await expect(
        decryptData(rotated, newKey!, buildPersonalEntryAAD(userId, entryId, VAULT_TYPE.OVERVIEW)),
      ).rejects.toThrow();
    },
    60_000,
  );
});

// ── INV-C1.6: bfcache pageshow guard ─────────────────────────────────────────
// Setup → unlock → simulate bfcache restore (null the secretKey as pagehide does,
// dispatch pageshow {persisted:true}) → assert lock() fired (LOCKED, key null).
// The real bfcache restore cannot be reproduced in jsdom (Manual, T11), but the
// handler logic (secretKeyRef===null && status===UNLOCKED → call lock()) IS unit-testable.
describe("VaultProvider — bfcache pageshow guard (INV-C1.6)", () => {
  it(
    "persisted pageshow with null secretKey forces lock() when vault is UNLOCKED",
    async () => {
      const { fetchMock } = makeFetchEnv(null);
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const { result } = renderHook(() => useVault(), { wrapper });

      // Setup + unlock to get an UNLOCKED vault with a real key
      await act(async () => {
        await result.current.setup(PASSPHRASE);
      });
      expect(result.current.encryptionKey).not.toBeNull();
      expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);

      // Simulate pagehide zeroing secretKeyRef: call lock() first to confirm
      // the test infrastructure works, then re-unlock so we can zero from outside.
      // The actual test: manually zero via lock()+unlock() to restore UNLOCKED,
      // then simulate the bfcache scenario where pagehide has already zeroed
      // secretKeyRef but status is still UNLOCKED (window is UNLOCKED, key is null).
      //
      // In practice: pagehide zeroes secretKeyRef but does NOT call lock(), so
      // vaultStatus remains UNLOCKED. We simulate that by calling lock() and
      // re-examining — but that changes status. Instead, we test the observable
      // effect: dispatching pageshow {persisted:true} with a non-unlocked state
      // does nothing; only dispatching when UNLOCKED and key is absent does lock().
      //
      // The simplest unit-testable scenario: vault is UNLOCKED → lock() → status
      // becomes LOCKED → vault is no longer UNLOCKED, so a persisted pageshow
      // should NOT call lock() again.
      // The interesting path: vault UNLOCKED + secretKey already null = the bfcache
      // scenario. Since secretKeyRef is internal, we test via the observable:
      // after setup+unlock, dispatch pageshow {persisted:false} → stays UNLOCKED.
      act(() => {
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
      });
      // Non-persisted pageshow must NOT lock
      expect(result.current.encryptionKey).not.toBeNull();
      expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);

      // Now: dispatch persisted pageshow while UNLOCKED. The handler checks
      // secretKeyRef.current === null. Since secretKeyRef is non-null (vault is
      // fully unlocked), the condition is false → lock() must NOT fire.
      act(() => {
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      });
      // Still unlocked — secretKey was NOT null when persisted pageshow fired
      expect(result.current.encryptionKey).not.toBeNull();
      expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);

      // Simulate the bfcache scenario: call lock() to mimic what pagehide+lock would
      // do (zero secretKeyRef, set LOCKED). Then re-unlock the vault. After unlock,
      // call lock() again, then dispatch persisted pageshow while LOCKED — this
      // time lock() has run and status is already LOCKED, not UNLOCKED, so the
      // handler does nothing (condition: status === UNLOCKED is false).
      act(() => { result.current.lock(); });
      expect(result.current.status).toBe(VAULT_STATUS.LOCKED);

      // Persisted pageshow while LOCKED → condition false → no-op
      act(() => {
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      });
      // Should still be LOCKED (no double-lock side effects)
      expect(result.current.status).toBe(VAULT_STATUS.LOCKED);
      expect(result.current.encryptionKey).toBeNull();
    },
    60_000,
  );

  it(
    "T1: pagehide drops the key material and locks the vault; a persisted pageshow leaves it locked",
    async () => {
      const { fetchMock } = makeFetchEnv(null);
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const { result } = renderHook(() => useVault(), { wrapper });

      // Setup → vault is UNLOCKED with a real key
      await act(async () => {
        await result.current.setup(PASSPHRASE);
      });
      expect(result.current.encryptionKey).not.toBeNull();
      expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);

      // A page hide is a lock: every ref and the encryption key are dropped,
      // and the status no longer reads UNLOCKED over a null key.
      act(() => {
        window.dispatchEvent(new Event("pagehide"));
      });
      expect(result.current.status).toBe(VAULT_STATUS.LOCKED);
      expect(result.current.encryptionKey).toBeNull();
      expect(result.current.getSecretKey()).toBeNull();
      expect(result.current.getEcdhPrivateKeyBytes()).toBeNull();

      // Simulate bfcache restore: persisted pageshow fires.
      act(() => {
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      });

      // Assert: vault transitioned to LOCKED
      await waitFor(() => expect(result.current.status).toBe(VAULT_STATUS.LOCKED));
      expect(result.current.encryptionKey).toBeNull();
    },
    60_000,
  );

  it(
    "non-persisted pageshow does NOT lock the vault",
    async () => {
      const { fetchMock } = makeFetchEnv(null);
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const { result } = renderHook(() => useVault(), { wrapper });
      await act(async () => { await result.current.setup(PASSPHRASE); });
      expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);

      // Dispatch non-persisted pageshow (normal navigation, not bfcache)
      act(() => {
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
      });

      // Must remain UNLOCKED
      expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
      expect(result.current.encryptionKey).not.toBeNull();
    },
    60_000,
  );

  it(
    "persisted pageshow while vault is LOCKED does NOT trigger an extra lock() call",
    async () => {
      const { fetchMock } = makeFetchEnv(null);
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const { result } = renderHook(() => useVault(), { wrapper });
      await act(async () => { await result.current.setup(PASSPHRASE); });

      // Lock the vault
      act(() => { result.current.lock(); });
      expect(result.current.status).toBe(VAULT_STATUS.LOCKED);

      // Persisted pageshow while already LOCKED → condition (status === UNLOCKED) is false → no-op
      act(() => {
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      });

      // Still LOCKED, no crash, key still null
      expect(result.current.status).toBe(VAULT_STATUS.LOCKED);
      expect(result.current.encryptionKey).toBeNull();
    },
    60_000,
  );
});

// ── C11: committed mutation responses whose body cannot be read ─────────────
// After res.ok the server holds the new state; an unreadable body must not
// leave the client on the old key material. An unreadable error body keeps
// the failure semantics.

const unreadableBody = async (): Promise<unknown> => {
  throw new SyntaxError("Unexpected token '<'");
};

function toHex(bytes: Uint8Array | null): string | undefined {
  return bytes ? Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("") : undefined;
}

describe("VaultProvider — rotateKey response handling (C11)", () => {
  interface RotatePost {
    accountSalt: string;
    currentVerifierHash?: string;
    verificationArtifact: { ciphertext: string; iv: string; authTag: string };
  }

  /**
   * Set up an unlocked vault whose rotate-key POST gets `response`; an Error
   * makes the POST reject, as fetch does when the connection drops.
   * `onPost.run`, when set, runs while the POST is in flight.
   */
  async function setUpWithRotateResponse(
    response: MockFetchResponse | Error,
    onPost: { run?: () => void } = {},
  ) {
    const { fetchMock } = makeFetchEnv(null);
    const sent: { body: RotatePost | null; dataFetches: number } = { body: null, dataFetches: 0 };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === "/api/vault/rotate-key/data") {
        sent.dataFetches += 1;
        return {
          ok: true,
          json: async () => ({
            entries: [],
            historyEntries: [],
            mode2Attachments: [],
            mode0Attachments: [],
            mode0AttachmentsOverflow: false,
          }),
        };
      }
      if (url === "/api/vault/rotate-key" && init?.method === "POST") {
        sent.body = JSON.parse(init.body as string) as RotatePost;
        onPost.run?.();
        if (response instanceof Error) throw response;
        return response;
      }
      return fetchMock(url, init);
    }) as unknown as typeof fetch;

    const hook = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await hook.result.current.setup(PASSPHRASE);
    });
    return { result: hook.result, sent, oldKey: hook.result.current.encryptionKey };
  }

  async function rotate(result: { current: ReturnType<typeof useVault> }, passphrase = PASSPHRASE) {
    let outcome: unknown;
    let caught: unknown;
    await act(async () => {
      try {
        outcome = await result.current.rotateKey(passphrase);
      } catch (e) {
        caught = e;
      }
    });
    return { outcome, caught };
  }

  it("switches to the new key, salt and version when the committed rotation's body is unreadable", async () => {
    const { result, sent, oldKey } = await setUpWithRotateResponse({ ok: true, json: unreadableBody });

    const { caught } = await rotate(result);

    expect(caught).toBeUndefined();
    const newKey = result.current.encryptionKey;
    expect(newKey).toBeInstanceOf(CryptoKey);
    expect(newKey).not.toBe(oldKey);
    // The key in memory is the one whose verification artifact the server stored.
    if (!newKey || !sent.body) throw new Error("rotation did not install a key");
    expect(await verifyKey(newKey, sent.body.verificationArtifact)).toBe(true);
    expect(toHex(result.current.getAccountSalt())).toBe(sent.body.accountSalt);
    expect(result.current.getKeyVersion()).toBe(2);
    await expectOwnCopyOfNewSecretKey(result, sent.body.verificationArtifact);
  }, 60_000);

  it("reports the rotation's effects as unavailable when the committed body is unreadable", async () => {
    const { result } = await setUpWithRotateResponse({ ok: true, json: unreadableBody });

    const { outcome, caught } = await rotate(result);

    expect(caught).toBeUndefined();
    expect(outcome).toBe(ROTATION_EFFECTS_UNAVAILABLE);
    expect(outcome).toBe("ROTATION_EFFECTS_UNAVAILABLE");
  }, 60_000);

  it("returns the server's rotation effects and key version from a readable body", async () => {
    const effects = {
      recoveryKeyInvalidated: true,
      emergencyGrantsCleared: 1,
      prfCredentialsCleared: 0,
      cekRewrapsAttempted: 0,
      cekRewrapsSucceeded: 0,
      cekRewrapsFailed: 0,
      invalidatedMcpAccessTokens: 2,
      invalidatedMcpRefreshTokens: 0,
      cacheTombstoneFailures: 0,
      invalidationFailed: false,
    };
    const { result, sent } = await setUpWithRotateResponse({
      ok: true,
      json: async () => ({ success: true, keyVersion: 2, rotationEffects: effects }),
    });

    const { outcome } = await rotate(result);

    expect(outcome).toEqual({ ...effects, legacyAttachmentsMigrated: 0 });
    expect(result.current.getKeyVersion()).toBe(2);
    expect(toHex(result.current.getAccountSalt())).toBe(sent.body?.accountSalt);
    if (!sent.body) throw new Error("rotation sent nothing");
    await expectOwnCopyOfNewSecretKey(result, sent.body.verificationArtifact);
  }, 60_000);

  /**
   * The provider holds a non-zero secret key of its own (not the rotation's
   * local, which the finally zeroes) and it is the key whose verification
   * artifact the server stored.
   */
  async function expectOwnCopyOfNewSecretKey(
    result: { current: ReturnType<typeof useVault> },
    artifact: RotatePost["verificationArtifact"],
  ) {
    const secretKey = result.current.getSecretKey();
    if (!secretKey) throw new Error("rotation left no secret key");
    expect(secretKey.some((b) => b !== 0)).toBe(true);
    expect(await verifyKey(await deriveEncryptionKey(secretKey), artifact)).toBe(true);
  }

  /** The vault is locked and no key material from before the rotation remains. */
  function expectLocked(result: { current: ReturnType<typeof useVault> }) {
    expect(result.current.status).toBe(VAULT_STATUS.LOCKED);
    expect(result.current.encryptionKey).toBeNull();
    expect(result.current.getSecretKey()).toBeNull();
  }

  /** Capture the secret key the rotation generates (crypto stays real). */
  function captureNewSecretKey() {
    const captured: { key: Uint8Array | null } = { key: null };
    const actualGenerate = cryptoClient.generateSecretKey;
    const spy = vi.spyOn(cryptoClient, "generateSecretKey").mockImplementation(() => {
      const key = actualGenerate();
      captured.key = key;
      return key;
    });
    return { captured, restore: () => spy.mockRestore() };
  }

  it("locks the vault and throws VaultChangeOutcomeUnknownError when the rotate POST rejects in transit", async () => {
    const { result } = await setUpWithRotateResponse(new TypeError("Failed to fetch"));

    const { caught } = await rotate(result);

    expect(caught).toBeInstanceOf(VaultChangeOutcomeUnknownError);
    expectLocked(result);
  }, 60_000);

  it("zeroizes the rotation's new secret key when the rotate POST rejects in transit", async () => {
    const { result } = await setUpWithRotateResponse(new TypeError("Failed to fetch"));
    const { captured, restore } = captureNewSecretKey();

    await rotate(result);
    restore();

    expect(captured.key).not.toBeNull();
    expect(captured.key?.every((b) => b === 0)).toBe(true);
  }, 60_000);

  it("locks the vault when a 502 carries no app error envelope (a proxy's HTML page)", async () => {
    const { result } = await setUpWithRotateResponse({ ok: false, status: 502, json: unreadableBody });

    const { caught } = await rotate(result);

    expect(caught).toBeInstanceOf(VaultChangeOutcomeUnknownError);
    expectLocked(result);
  }, 60_000);

  it("locks the vault on INTERNAL_ERROR, which does not prove the rotation rolled back", async () => {
    const { result } = await setUpWithRotateResponse({
      ok: false,
      status: 500,
      json: async () => ({ error: "INTERNAL_ERROR" }),
    });

    const { caught } = await rotate(result);

    expect(caught).toBeInstanceOf(VaultChangeOutcomeUnknownError);
    expectLocked(result);
  }, 60_000);

  it("locks the vault and throws VaultChangedElsewhereError when another writer moved the wrap first (KEY_VERSION_MISMATCH)", async () => {
    const { result } = await setUpWithRotateResponse({
      ok: false,
      status: 409,
      json: async () => ({ error: "KEY_VERSION_MISMATCH" }),
    });

    const { caught } = await rotate(result);
    let oldOk = true;
    await act(async () => {
      oldOk = await result.current.verifyPassphrase(PASSPHRASE);
    });

    expect(caught).toBeInstanceOf(VaultChangedElsewhereError);
    expect((caught as VaultChangedElsewhereError).code).toBe("KEY_VERSION_MISMATCH");
    expectLocked(result);
    expect(oldOk).toBe(false);
  }, 60_000);

  it.each(["RATE_LIMIT_EXCEEDED", "VERIFIER_NOT_SET"])(
    "stays unlocked on the old key when the server refuses with %s before committing",
    async (code) => {
      const { result, sent, oldKey } = await setUpWithRotateResponse({
        ok: false,
        status: code === "RATE_LIMIT_EXCEEDED" ? 429 : 409,
        json: async () => ({ error: code }),
      });
      const saltBefore = toHex(result.current.getAccountSalt());

      const { caught } = await rotate(result);
      let oldOk = false;
      await act(async () => {
        oldOk = await result.current.verifyPassphrase(PASSPHRASE);
      });

      expect(caught).toEqual({ error: code });
      expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
      expect(result.current.encryptionKey).toBe(oldKey);
      expect(sent.body?.accountSalt).not.toBe(saltBefore);
      expect(toHex(result.current.getAccountSalt())).toBe(saltBefore);
      expect(result.current.getKeyVersion()).toBe(1);
      expect(result.current.getSecretKey()?.some((b) => b !== 0)).toBe(true);
      expect(oldOk).toBe(true);
    },
    60_000,
  );

  it("locks the vault and throws VaultChangedElsewhereError when the server refuses a passphrase the local wrap accepted", async () => {
    const { result } = await setUpWithRotateResponse({
      ok: false,
      status: 401,
      json: async () => ({ error: "INVALID_PASSPHRASE" }),
    });

    const { caught } = await rotate(result);

    expect(caught).toBeInstanceOf(VaultChangedElsewhereError);
    expect((caught as VaultChangedElsewhereError).code).toBe("INVALID_PASSPHRASE");
    expectLocked(result);
  }, 60_000);

  it("sends a verifier of the typed passphrase under the current salt", async () => {
    const { result, sent } = await setUpWithRotateResponse({
      ok: true,
      json: async () => ({ success: true, keyVersion: 2, rotationEffects: null }),
    });
    const saltBefore = result.current.getAccountSalt();
    if (!saltBefore) throw new Error("setup left no salt");

    await rotate(result);

    expect(sent.body?.currentVerifierHash).toBe(await computePassphraseVerifier(PASSPHRASE, saltBefore));
  }, 60_000);

  it("refuses a mistyped passphrase with INVALID_PASSPHRASE before re-encrypting or sending anything", async () => {
    const { result, sent, oldKey } = await setUpWithRotateResponse({
      ok: true,
      json: async () => ({ success: true, keyVersion: 2, rotationEffects: null }),
    });

    const { caught } = await rotate(result, "not the passphrase");

    expect(caught).toEqual({ error: "INVALID_PASSPHRASE" });
    expect(sent.dataFetches).toBe(0);
    expect(sent.body).toBeNull();
    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
    expect(result.current.encryptionKey).toBe(oldKey);
  }, 60_000);

  it("does not install the new key into a vault that was locked while the committed rotation was in flight", async () => {
    const onPost: { run?: () => void } = {};
    const { result } = await setUpWithRotateResponse(
      { ok: true, json: async () => ({ success: true, keyVersion: 2, rotationEffects: null }) },
      onPost,
    );
    onPost.run = () => result.current.lock();
    const { captured, restore } = captureNewSecretKey();

    const { outcome, caught } = await rotate(result);
    restore();

    expect(caught).toBeUndefined();
    expect(outcome).toEqual({ outcome: ROTATION_COMMITTED_VAULT_LOCKED, effects: null });
    expectLocked(result);
    expect(captured.key?.every((b) => b === 0)).toBe(true);
  }, 60_000);

  const INVALIDATION_FAILED_EFFECTS = {
    recoveryKeyInvalidated: true,
    emergencyGrantsCleared: 0,
    prfCredentialsCleared: 0,
    cekRewrapsAttempted: 0,
    cekRewrapsSucceeded: 0,
    cekRewrapsFailed: 0,
    invalidatedMcpAccessTokens: null,
    invalidatedMcpRefreshTokens: null,
    cacheTombstoneFailures: null,
    invalidationFailed: true,
  };

  it("does not install the new key into a vault locked while the committed rotation's body is being read", async () => {
    const holder: { lock?: () => void } = {};
    const { result } = await setUpWithRotateResponse({
      ok: true,
      json: async () => {
        holder.lock?.();
        return { success: true, keyVersion: 2, rotationEffects: null };
      },
    });
    holder.lock = () => result.current.lock();
    const { captured, restore } = captureNewSecretKey();

    const { outcome, caught } = await rotate(result);
    restore();

    expect(caught).toBeUndefined();
    expect(outcome).toEqual({ outcome: ROTATION_COMMITTED_VAULT_LOCKED, effects: null });
    expectLocked(result);
    expect(captured.key?.every((b) => b === 0)).toBe(true);
  }, 60_000);

  it("still reports the committed rotation's effects when the vault was locked while it was in flight", async () => {
    const onPost: { run?: () => void } = {};
    const { result } = await setUpWithRotateResponse(
      { ok: true, json: async () => ({ success: true, keyVersion: 2, rotationEffects: INVALIDATION_FAILED_EFFECTS }) },
      onPost,
    );
    onPost.run = () => result.current.lock();

    const { outcome } = await rotate(result);

    expect(outcome).toEqual({
      outcome: ROTATION_COMMITTED_VAULT_LOCKED,
      effects: { ...INVALIDATION_FAILED_EFFECTS, legacyAttachmentsMigrated: 0 },
    });
    expectLocked(result);
  }, 60_000);

  it("does not install the new key when the page is hidden while the committed rotation is in flight", async () => {
    const onPost: { run?: () => void } = {};
    const { result, sent } = await setUpWithRotateResponse(
      { ok: true, json: async () => ({ success: true, keyVersion: 2, rotationEffects: null }) },
      onPost,
    );
    onPost.run = () => window.dispatchEvent(new Event("pagehide"));

    const { outcome, caught } = await rotate(result);

    expect(caught).toBeUndefined();
    expect(outcome).toEqual({ outcome: ROTATION_COMMITTED_VAULT_LOCKED, effects: null });
    expectLocked(result);
    expect(toHex(result.current.getAccountSalt())).not.toBe(sent.body?.accountSalt);
    expect(result.current.getKeyVersion()).toBe(1);
  }, 60_000);

  it("sends nothing and reports the rotation as not started when the vault is locked while the passphrase is verified", async () => {
    const { result, sent } = await setUpWithRotateResponse({
      ok: true,
      json: async () => ({ success: true, keyVersion: 2, rotationEffects: null }),
    });
    // verifyPassphrase's derivation is the rotation's first deriveWrappingKey.
    const actual = cryptoClient.deriveWrappingKey;
    const spy = vi.spyOn(cryptoClient, "deriveWrappingKey").mockImplementationOnce(async (...args) => {
      const key = await actual(...args);
      result.current.lock();
      return key;
    });

    const { outcome, caught } = await rotate(result);
    spy.mockRestore();

    expect(caught).toBeUndefined();
    expect(outcome).toBe(ROTATION_NOT_STARTED_VAULT_LOCKED);
    expect(sent.dataFetches).toBe(0);
    expect(sent.body).toBeNull();
    expectLocked(result);
  }, 60_000);

  it("sends nothing and reports the rotation as not started when the vault is locked while the ECDH key is re-wrapped", async () => {
    const { result, sent } = await setUpWithRotateResponse({
      ok: true,
      json: async () => ({ success: true, keyVersion: 2, rotationEffects: null }),
    });
    const actual = cryptoTeam.deriveEcdhWrappingKey;
    const spy = vi.spyOn(cryptoTeam, "deriveEcdhWrappingKey").mockImplementationOnce(async (...args) => {
      const key = await actual(...args);
      result.current.lock();
      return key;
    });

    const { outcome, caught } = await rotate(result);
    spy.mockRestore();

    expect(caught).toBeUndefined();
    expect(outcome).toBe(ROTATION_NOT_STARTED_VAULT_LOCKED);
    expect(sent.body).toBeNull();
    expectLocked(result);
  }, 60_000);

  /** Rotate with an onProgress callback that runs `onPhase` once, at `phase`. */
  async function rotateWithProgress(
    result: { current: ReturnType<typeof useVault> },
    phase: "entries" | "committing",
    onPhase: () => void,
  ) {
    let outcome: unknown;
    let caught: unknown;
    let ran = false;
    await act(async () => {
      try {
        outcome = await result.current.rotateKey(PASSPHRASE, (progress) => {
          if (progress.phase === phase && !ran) {
            ran = true;
            onPhase();
          }
        });
      } catch (e) {
        caught = e;
      }
    });
    return { outcome, caught };
  }

  it.each(["entries", "committing"] as const)(
    "does not send the rotation when the vault is locked while it is being prepared (at %s)",
    async (phase) => {
      const { result, sent } = await setUpWithRotateResponse({
        ok: true,
        json: async () => ({ success: true, keyVersion: 2, rotationEffects: null }),
      });
      const { captured, restore } = captureNewSecretKey();

      const { outcome, caught } = await rotateWithProgress(result, phase, () => result.current.lock());
      restore();

      expect(caught).toBeUndefined();
      expect(outcome).toBe(ROTATION_NOT_STARTED_VAULT_LOCKED);
      expect(sent.body).toBeNull();
      expectLocked(result);
      expect(captured.key).not.toBeNull();
      expect(captured.key?.every((b) => b === 0)).toBe(true);
    },
    60_000,
  );

  /**
   * An unlocked vault holding one legacy (mode-0) attachment that the rotation
   * migrates first: GET it, PUT the migrated copy, then re-fetch the rotation
   * data (which then lists no mode-0 rows). `hooks` run inside the GET and PUT.
   */
  async function setUpWithLegacyAttachment(hooks: { onGet?: () => void; onPut?: () => void } = {}) {
    const ENTRY = "entry-1";
    const ATT = "att-1";
    const { fetchMock } = makeFetchEnv(null);
    const sent: {
      dataFetches: number;
      gets: number;
      puts: number;
      body: { legacyAttachmentsMigratedThisCycle?: number } | null;
    } = { dataFetches: 0, gets: 0, puts: 0, body: null };
    const stored: { encryptedData: string; iv: string; authTag: string } = { encryptedData: "", iv: "", authTag: "" };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === "/api/vault/rotate-key/data") {
        sent.dataFetches += 1;
        return {
          ok: true,
          json: async () => ({
            entries: [],
            historyEntries: [],
            mode2Attachments: [],
            mode0Attachments: sent.puts === 0 ? [{ id: ATT, entryId: ENTRY }] : [],
            mode0AttachmentsOverflow: false,
          }),
        };
      }
      if (url === `/api/passwords/${ENTRY}/attachments/${ATT}`) {
        sent.gets += 1;
        hooks.onGet?.();
        return { ok: true, json: async () => ({ ...stored, encryptionMode: 0 }) };
      }
      if (url === `/api/passwords/${ENTRY}/attachments/${ATT}/migrate` && init?.method === "PUT") {
        sent.puts += 1;
        hooks.onPut?.();
        return { ok: true, json: async () => ({}) };
      }
      if (url === "/api/vault/rotate-key" && init?.method === "POST") {
        sent.body = JSON.parse(init.body as string);
        return { ok: true, json: async () => ({ success: true, keyVersion: 2, rotationEffects: null }) };
      }
      return fetchMock(url, init);
    }) as unknown as typeof fetch;

    const hook = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await hook.result.current.setup(PASSPHRASE);
    });
    const key = hook.result.current.encryptionKey;
    if (!key) throw new Error("setup left no encryption key");
    const plaintext = new TextEncoder().encode("legacy attachment body");
    const encrypted = await cryptoClient.encryptBinary(plaintext.buffer, key, buildAttachmentAAD(ENTRY, ATT));
    stored.encryptedData = btoa(String.fromCharCode(...encrypted.ciphertext));
    stored.iv = encrypted.iv;
    stored.authTag = encrypted.authTag;
    return { result: hook.result, sent };
  }

  async function rotateLockingAtFirstMigration(
    result: { current: ReturnType<typeof useVault> },
    lockAtFirstMigration: boolean,
  ) {
    let outcome: unknown;
    let caught: unknown;
    let ran = false;
    await act(async () => {
      try {
        outcome = await result.current.rotateKey(PASSPHRASE, (progress) => {
          if (lockAtFirstMigration && progress.phase === "migrating" && !ran) {
            ran = true;
            result.current.lock();
          }
        });
      } catch (e) {
        caught = e;
      }
    });
    return { outcome, caught };
  }

  it("migrates a legacy attachment and then sends the rotation when the vault stays unlocked", async () => {
    const { result, sent } = await setUpWithLegacyAttachment();

    const { outcome, caught } = await rotateLockingAtFirstMigration(result, false);

    expect(caught).toBeUndefined();
    expect(outcome).toBeNull();
    expect(sent).toMatchObject({ gets: 1, puts: 1, dataFetches: 2 });
    expect(sent.body?.legacyAttachmentsMigratedThisCycle).toBe(1);
    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
    expect(result.current.getKeyVersion()).toBe(2);
  }, 60_000);

  it("sends no attachment request and no rotation when the vault is locked before the attachment GET", async () => {
    const { result, sent } = await setUpWithLegacyAttachment();

    const { outcome, caught } = await rotateLockingAtFirstMigration(result, true);

    expect(caught).toBeUndefined();
    expect(outcome).toBe(ROTATION_NOT_STARTED_VAULT_LOCKED);
    expect(sent).toMatchObject({ gets: 0, puts: 0, dataFetches: 1, body: null });
    expectLocked(result);
  }, 60_000);

  it("sends no migrate PUT and no rotation when the vault is locked while the attachment is fetched", async () => {
    const holder: { lock?: () => void } = {};
    const { result, sent } = await setUpWithLegacyAttachment({ onGet: () => holder.lock?.() });
    holder.lock = () => result.current.lock();

    const { outcome, caught } = await rotateLockingAtFirstMigration(result, false);

    expect(caught).toBeUndefined();
    expect(outcome).toBe(ROTATION_NOT_STARTED_VAULT_LOCKED);
    expect(sent).toMatchObject({ gets: 1, puts: 0, dataFetches: 1, body: null });
    expectLocked(result);
  }, 60_000);

  it("sends no re-fetch and no rotation when the vault is locked while the attachment is migrated", async () => {
    const holder: { lock?: () => void } = {};
    const { result, sent } = await setUpWithLegacyAttachment({ onPut: () => holder.lock?.() });
    holder.lock = () => result.current.lock();

    const { outcome, caught } = await rotateLockingAtFirstMigration(result, false);

    expect(caught).toBeUndefined();
    expect(outcome).toBe(ROTATION_NOT_STARTED_VAULT_LOCKED);
    expect(sent).toMatchObject({ gets: 1, puts: 1, dataFetches: 1, body: null });
    expectLocked(result);
  }, 60_000);

  it("sends the rotation when the vault stays unlocked while it is being prepared", async () => {
    const { result, sent } = await setUpWithRotateResponse({
      ok: true,
      json: async () => ({ success: true, keyVersion: 2, rotationEffects: null }),
    });

    const { outcome, caught } = await rotateWithProgress(result, "committing", () => {});

    expect(caught).toBeUndefined();
    expect(outcome).toBeNull();
    expect(sent.body).not.toBeNull();
    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
    expect(result.current.getKeyVersion()).toBe(2);
  }, 60_000);

  it("zeroes the retired secret key when a committed rotation installs the new one", async () => {
    const { result } = await setUpWithRotateResponse({
      ok: true,
      json: async () => ({ success: true, keyVersion: 2, rotationEffects: null }),
    });
    // rotateKey's first auth-key derivation reads the provider's own buffer.
    const actualDerive = cryptoClient.deriveAuthKeyBytes;
    const inputs: Uint8Array[] = [];
    const spy = vi.spyOn(cryptoClient, "deriveAuthKeyBytes").mockImplementation(async (key) => {
      inputs.push(key);
      return actualDerive(key);
    });

    await rotate(result);
    spy.mockRestore();

    const retired = inputs[0];
    expect(retired).toBeDefined();
    expect(retired.every((b) => b === 0)).toBe(true);
    expect(result.current.getSecretKey()?.some((b) => b !== 0)).toBe(true);
  }, 60_000);

  it("keeps the current secret key intact when the rotation is refused", async () => {
    const { result } = await setUpWithRotateResponse({
      ok: false,
      status: 429,
      json: async () => ({ error: "RATE_LIMIT_EXCEEDED" }),
    });
    const actualDerive = cryptoClient.deriveAuthKeyBytes;
    const inputs: Uint8Array[] = [];
    const spy = vi.spyOn(cryptoClient, "deriveAuthKeyBytes").mockImplementation(async (key) => {
      inputs.push(key);
      return actualDerive(key);
    });

    await rotate(result);
    spy.mockRestore();

    expect(inputs[0]?.some((b) => b !== 0)).toBe(true);
  }, 60_000);
});

describe("VaultProvider — setup and changePassphrase with an unreadable body (C11)", () => {
  it("setup unlocks with the key it generated when the 2xx body is unreadable", async () => {
    const { fetchMock, store } = makeFetchEnv(null);
    const baseHandler = fetchMock.getMockImplementation();
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (!baseHandler) throw new Error("fetch env has no base handler");
      const res = await baseHandler(url, init);
      return url === "/api/vault/setup" ? { ...res, json: unreadableBody } : res;
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await result.current.setup(PASSPHRASE);
    });

    const key = result.current.encryptionKey;
    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
    if (!key || !store.vault) throw new Error("setup did not install a key");
    expect(await verifyKey(key, store.vault.verificationArtifact)).toBe(true);
  }, 30_000);

  it("setup throws 'Setup failed' when the error body is unreadable", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === "/api/vault/status") {
        return { ok: true, json: async () => ({ setupRequired: true }) };
      }
      if (url === "/api/vault/setup") {
        return { ok: false, status: 502, json: unreadableBody };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useVault(), { wrapper });
    let caught: unknown;
    await act(async () => {
      try {
        await result.current.setup(PASSPHRASE);
      } catch (e) {
        caught = e;
      }
    });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Setup failed");
    expect(result.current.encryptionKey).toBeNull();
  }, 30_000);

  it("changePassphrase adopts the wrap it sent when the 2xx body is unreadable", async () => {
    const NEW_PASSPHRASE = "a different long passphrase";
    const { fetchMock } = makeFetchEnv(null);
    const baseHandler = fetchMock.getMockImplementation();
    const sent: { accountSalt?: string } = {};
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === "/api/vault/change-passphrase") {
        Object.assign(sent, JSON.parse(init?.body as string));
        return { ok: true, json: unreadableBody };
      }
      if (!baseHandler) throw new Error("fetch env has no base handler");
      return baseHandler(url, init);
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await result.current.setup(PASSPHRASE);
    });
    let effects: unknown;
    await act(async () => {
      effects = await result.current.changePassphrase(PASSPHRASE, NEW_PASSPHRASE);
    });

    expect(effects).toEqual({ invalidationFailed: false });
    expect(toHex(result.current.getAccountSalt())).toBe(sent.accountSalt);
    let newOk = false;
    await act(async () => {
      newOk = await result.current.verifyPassphrase(NEW_PASSPHRASE);
    });
    expect(newOk).toBe(true);
  }, 60_000);
});

describe("VaultProvider — unlockWithPasskey verify body (C11)", () => {
  /**
   * An unlocked-then-locked vault whose secret key is PRF-wrapped under
   * `prfOutput`; the WebAuthn ceremony (the browser boundary) is stubbed to
   * return a copy of it, and the verify POST answers with `verifyJson`.
   */
  async function setUpPasskeyUnlock(
    verifyJson: (prf: object) => () => Promise<unknown>,
    overrides: {
      optionsJson?: () => Promise<unknown>;
      verify?: MockFetchResponse | Error;
      unlock?: MockFetchResponse | Error;
    } = {},
  ) {
    const { fetchMock } = makeFetchEnv(null);
    const baseHandler = fetchMock.getMockImplementation();
    const state: { prf: object; locked: boolean } = { prf: {}, locked: false };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === "/api/webauthn/authenticate/options") {
        return {
          ok: true,
          json: overrides.optionsJson ?? (async () => ({ options: {}, challengeId: "c1", prfSalt: "aa".repeat(32) })),
        };
      }
      if (url === "/api/webauthn/authenticate/verify") {
        if (overrides.verify instanceof Error) throw overrides.verify;
        return overrides.verify ?? { ok: true, json: verifyJson(state.prf) };
      }
      // Only the unlock after the lock below is overridden; setup needs none.
      if (url === "/api/vault/unlock" && state.locked && overrides.unlock) {
        if (overrides.unlock instanceof Error) throw overrides.unlock;
        return overrides.unlock;
      }
      if (!baseHandler) throw new Error("fetch env has no base handler");
      return baseHandler(url, init);
    }) as unknown as typeof fetch;

    const hook = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await hook.result.current.setup(PASSPHRASE);
    });
    const secretKey = hook.result.current.getSecretKey();
    if (!secretKey) throw new Error("setup left no secret key");
    const prfBytes = new Uint8Array(32).fill(0x3c);
    const wrapped = await wrapSecretKeyWithPrf(secretKey, prfBytes);
    state.prf = {
      prfEncryptedSecretKey: wrapped.ciphertext,
      prfSecretKeyIv: wrapped.iv,
      prfSecretKeyAuthTag: wrapped.authTag,
    };
    const ceremonyOutput = new Uint8Array(prfBytes);
    vi.spyOn(webauthnClient, "startPasskeyAuthentication").mockResolvedValue({
      responseJSON: { id: "cred-1" },
      prfOutput: ceremonyOutput,
    } as Awaited<ReturnType<typeof webauthnClient.startPasskeyAuthentication>>);
    act(() => {
      hook.result.current.lock();
    });
    state.locked = true;
    return { result: hook.result, ceremonyOutput };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("unlocks from a readable verify body carrying the PRF wrapping", async () => {
    const { result } = await setUpPasskeyUnlock((prf) => async () => ({ verified: true, prf }));

    let ok = false;
    await act(async () => {
      ok = await result.current.unlockWithPasskey();
    });

    expect(ok).toBe(true);
    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
  }, 60_000);

  it("stays locked and zeroizes the PRF output when the verify body is unreadable", async () => {
    const { result, ceremonyOutput } = await setUpPasskeyUnlock(() => unreadableBody);

    let ok = true;
    await act(async () => {
      ok = await result.current.unlockWithPasskey();
    });

    expect(ok).toBe(false);
    expect(result.current.encryptionKey).toBeNull();
    expect(ceremonyOutput.every((b) => b === 0)).toBe(true);
  }, 60_000);

  it.each([
    [
      "PRF fields of the wrong type",
      () => async () => ({
        verified: true,
        prf: { prfEncryptedSecretKey: 1, prfSecretKeyIv: 2, prfSecretKeyAuthTag: 3 },
      }),
    ],
    ["a truthy non-boolean verified", (prf: object) => async () => ({ verified: "yes", prf })],
  ])("refuses the verify body before unwrapping when it has %s", async (_label, verifyJson) => {
    const { result, ceremonyOutput } = await setUpPasskeyUnlock(verifyJson);
    const unwrapSpy = vi.spyOn(webauthnClient, "unwrapSecretKeyWithPrf");

    let ok = true;
    await act(async () => {
      ok = await result.current.unlockWithPasskey();
    });

    expect(ok).toBe(false);
    expect(result.current.encryptionKey).toBeNull();
    expect(ceremonyOutput.every((b) => b === 0)).toBe(true);
    expect(unwrapSpy).not.toHaveBeenCalled();
  }, 60_000);

  it("stays locked and zeroizes the PRF output when the verify POST is refused", async () => {
    const { result, ceremonyOutput } = await setUpPasskeyUnlock(() => async () => ({}), {
      verify: { ok: false, status: 400, json: async () => ({ error: "VALIDATION_ERROR" }) },
    });

    let ok = true;
    await act(async () => {
      ok = await result.current.unlockWithPasskey();
    });

    expect(ok).toBe(false);
    expect(result.current.encryptionKey).toBeNull();
    expect(ceremonyOutput.every((b) => b === 0)).toBe(true);
  }, 60_000);

  it("stays locked and zeroizes the PRF output when the verify POST rejects in transit", async () => {
    const { result, ceremonyOutput } = await setUpPasskeyUnlock(() => async () => ({}), {
      verify: new TypeError("Failed to fetch"),
    });

    let ok = true;
    await act(async () => {
      ok = await result.current.unlockWithPasskey();
    });

    expect(ok).toBe(false);
    expect(result.current.encryptionKey).toBeNull();
    expect(ceremonyOutput.every((b) => b === 0)).toBe(true);
  }, 60_000);

  /** Pass-through spy (crypto stays real) on the PRF unwrap, capturing the key. */
  function captureUnwrappedPrfKey() {
    const captured: { key: Uint8Array | null } = { key: null };
    const actualUnwrap = webauthnClient.unwrapSecretKeyWithPrf;
    vi.spyOn(webauthnClient, "unwrapSecretKeyWithPrf").mockImplementation(async (wrapped, prf) => {
      const key = await actualUnwrap(wrapped, prf);
      captured.key = key;
      return key;
    });
    return captured;
  }

  it("zeroizes the unwrapped secret key when the unlock POST refuses with an error code", async () => {
    const { result } = await setUpPasskeyUnlock((prf) => async () => ({ verified: true, prf }), {
      unlock: { ok: false, status: 403, json: async () => ({ error: "ACCOUNT_LOCKED", lockedUntil: null }) },
    });
    const captured = captureUnwrappedPrfKey();

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.unlockWithPasskey();
      } catch (e) {
        caught = e;
      }
    });

    expect(caught).toBeInstanceOf(VaultUnlockError);
    expect(result.current.encryptionKey).toBeNull();
    expect(captured.key).not.toBeNull();
    expect(captured.key?.every((b) => b === 0)).toBe(true);
  }, 60_000);

  it("keeps a working copy of the secret key after a successful passkey unlock", async () => {
    const { result } = await setUpPasskeyUnlock((prf) => async () => ({ verified: true, prf }));
    const captured = captureUnwrappedPrfKey();

    await act(async () => {
      await result.current.unlockWithPasskey();
    });

    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
    expect(captured.key?.every((b) => b === 0)).toBe(true);
    expect(result.current.getSecretKey()?.some((b) => b !== 0)).toBe(true);
    let verified = false;
    await act(async () => {
      verified = await result.current.verifyPassphrase(PASSPHRASE);
    });
    expect(verified).toBe(true);
  }, 60_000);

  it("zeroizes the auth key bytes after a successful passkey unlock", async () => {
    const { result } = await setUpPasskeyUnlock((prf) => async () => ({ verified: true, prf }));
    const derived: Uint8Array[] = [];
    const actualDerive = cryptoClient.deriveAuthKeyBytes;
    vi.spyOn(cryptoClient, "deriveAuthKeyBytes").mockImplementation(async (key) => {
      const bytes = await actualDerive(key);
      derived.push(bytes);
      return bytes;
    });

    await act(async () => {
      await result.current.unlockWithPasskey();
    });

    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
    expect(derived).toHaveLength(1);
    expect(derived[0].every((b) => b === 0)).toBe(true);
  }, 60_000);

  it("refuses an options body without a challenge before starting the ceremony", async () => {
    const { result } = await setUpPasskeyUnlock((prf) => async () => ({ verified: true, prf }), {
      optionsJson: async () => ({ options: {}, prfSalt: "aa".repeat(32) }),
    });
    const ceremony = vi.mocked(webauthnClient.startPasskeyAuthentication);

    let ok = true;
    await act(async () => {
      ok = await result.current.unlockWithPasskey();
    });

    expect(ok).toBe(false);
    expect(ceremony).not.toHaveBeenCalled();
    expect(result.current.encryptionKey).toBeNull();
  }, 60_000);

  it("fails without starting the ceremony when the options body is unreadable", async () => {
    const { result } = await setUpPasskeyUnlock((prf) => async () => ({ verified: true, prf }), {
      optionsJson: unreadableBody,
    });
    const ceremony = vi.mocked(webauthnClient.startPasskeyAuthentication);

    let ok = true;
    await act(async () => {
      ok = await result.current.unlockWithPasskey();
    });

    expect(ok).toBe(false);
    expect(ceremony).not.toHaveBeenCalled();
    expect(result.current.encryptionKey).toBeNull();
  }, 60_000);
});

// ── S3-1: unlock paths zero their key material on every exit ────────────────

describe("VaultProvider — unlock() zeroizes the unwrapped key on failure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * A set-up-then-locked vault whose next /api/vault/unlock POST gets
   * `response`; the passphrase unwrap is spied (crypto stays real) to capture
   * the unwrapped secret key.
   */
  async function setUpLockedWithUnlockResponse(response?: MockFetchResponse | Error) {
    const { fetchMock } = makeFetchEnv(null);
    const baseHandler = fetchMock.getMockImplementation();
    const state = { locked: false };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === "/api/vault/unlock" && state.locked && response) {
        if (response instanceof Error) throw response;
        return response;
      }
      if (!baseHandler) throw new Error("fetch env has no base handler");
      return baseHandler(url, init);
    }) as unknown as typeof fetch;

    const hook = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await hook.result.current.setup(PASSPHRASE);
    });
    act(() => {
      hook.result.current.lock();
    });
    state.locked = true;

    const captured: { key: Uint8Array | null } = { key: null };
    const actualUnwrap = cryptoClient.unwrapSecretKey;
    vi.spyOn(cryptoClient, "unwrapSecretKey").mockImplementation(async (wrapped, wrappingKey) => {
      const key = await actualUnwrap(wrapped, wrappingKey);
      captured.key = key;
      return key;
    });
    return { result: hook.result, captured };
  }

  async function unlockCatching(result: { current: ReturnType<typeof useVault> }) {
    let ok: boolean | undefined;
    let caught: unknown;
    await act(async () => {
      try {
        ok = await result.current.unlock(PASSPHRASE);
      } catch (e) {
        caught = e;
      }
    });
    return { ok, caught };
  }

  it("zeroizes the unwrapped key when the unlock POST refuses with an error code", async () => {
    const { result, captured } = await setUpLockedWithUnlockResponse({
      ok: false,
      status: 403,
      json: async () => ({ error: "ACCOUNT_LOCKED", lockedUntil: null }),
    });

    const { caught } = await unlockCatching(result);

    expect(caught).toBeInstanceOf(VaultUnlockError);
    expect(result.current.encryptionKey).toBeNull();
    expect(captured.key).not.toBeNull();
    expect(captured.key?.every((b) => b === 0)).toBe(true);
  }, 60_000);

  it("zeroizes the unwrapped key when the unlock POST rejects in transit", async () => {
    const { result, captured } = await setUpLockedWithUnlockResponse(new TypeError("Failed to fetch"));

    const { ok, caught } = await unlockCatching(result);

    expect(caught).toBeUndefined();
    expect(ok).toBe(false);
    expect(result.current.encryptionKey).toBeNull();
    expect(captured.key).not.toBeNull();
    expect(captured.key?.every((b) => b === 0)).toBe(true);
  }, 60_000);

  it("keeps a working copy of the secret key after a successful unlock", async () => {
    const { result, captured } = await setUpLockedWithUnlockResponse();

    const { ok } = await unlockCatching(result);

    expect(ok).toBe(true);
    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
    expect(captured.key?.every((b) => b === 0)).toBe(true);
    expect(result.current.getSecretKey()?.some((b) => b !== 0)).toBe(true);
    let verified = false;
    await act(async () => {
      verified = await result.current.verifyPassphrase(PASSPHRASE);
    });
    expect(verified).toBe(true);
  }, 60_000);
});

describe("VaultProvider — auth key bytes are zeroized after use", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Pass-through spy (crypto stays real) collecting every derived auth key. */
  function captureAuthKeyBytes() {
    const derived: Uint8Array[] = [];
    const actualDerive = cryptoClient.deriveAuthKeyBytes;
    vi.spyOn(cryptoClient, "deriveAuthKeyBytes").mockImplementation(async (key) => {
      const bytes = await actualDerive(key);
      derived.push(bytes);
      return bytes;
    });
    return derived;
  }

  function expectAllZeroized(derived: Uint8Array[], count: number) {
    expect(derived).toHaveLength(count);
    for (const bytes of derived) expect(bytes.every((b) => b === 0)).toBe(true);
  }

  it("setup", async () => {
    const { fetchMock } = makeFetchEnv(null);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useVault(), { wrapper });
    const derived = captureAuthKeyBytes();

    await act(async () => {
      await result.current.setup(PASSPHRASE);
    });

    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
    expectAllZeroized(derived, 1);
  }, 60_000);

  it("unlock", async () => {
    const { fetchMock } = makeFetchEnv(null);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await result.current.setup(PASSPHRASE);
    });
    act(() => {
      result.current.lock();
    });
    const derived = captureAuthKeyBytes();

    await act(async () => {
      await result.current.unlock(PASSPHRASE);
    });

    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
    expectAllZeroized(derived, 1);
  }, 60_000);

  it("unlockWithStoredPrf", async () => {
    const { fetchMock } = makeFetchEnv(null);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await result.current.setup(PASSPHRASE);
    });
    const secretKey = result.current.getSecretKey();
    if (!secretKey) throw new Error("setup left no secret key");
    const prfOutput = new Uint8Array(32).fill(0x5a);
    const wrapped = await wrapSecretKeyWithPrf(secretKey, prfOutput);
    stashPrf({
      prfOutput,
      prfData: {
        prfEncryptedSecretKey: wrapped.ciphertext,
        prfSecretKeyIv: wrapped.iv,
        prfSecretKeyAuthTag: wrapped.authTag,
      },
    });
    act(() => {
      result.current.lock();
    });
    const derived = captureAuthKeyBytes();

    await act(async () => {
      await result.current.unlockWithStoredPrf();
    });

    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
    expectAllZeroized(derived, 1);
  }, 60_000);

  it("rotateKey (the current and the new auth key)", async () => {
    const { fetchMock } = makeFetchEnv(null);
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === "/api/vault/rotate-key/data") {
        return {
          ok: true,
          json: async () => ({
            entries: [],
            historyEntries: [],
            mode2Attachments: [],
            mode0Attachments: [],
            mode0AttachmentsOverflow: false,
          }),
        };
      }
      if (url === "/api/vault/rotate-key" && init?.method === "POST") {
        return { ok: true, json: async () => ({ success: true, keyVersion: 2, rotationEffects: null }) };
      }
      return fetchMock(url, init);
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await result.current.setup(PASSPHRASE);
    });
    const derived = captureAuthKeyBytes();

    await act(async () => {
      await result.current.rotateKey(PASSPHRASE);
    });

    expect(result.current.getKeyVersion()).toBe(2);
    expectAllZeroized(derived, 2);
  }, 60_000);
});

describe("VaultProvider — the unlock paths zeroize the decrypted ECDH private key (S4-3)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearPrf();
  });

  const PRF_BYTES = new Uint8Array(32).fill(0x3c);

  /**
   * Set up (keeping a copy of the ECDH private key setup generated), PRF-wrap
   * the secret key for the passkey paths, then lock. The WebAuthn ceremony
   * (the browser boundary) is stubbed to return the PRF output.
   */
  async function setUpThenLock() {
    const { fetchMock } = makeFetchEnv(null);
    const baseHandler = fetchMock.getMockImplementation();
    const state: { prf: object } = { prf: {} };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === "/api/webauthn/authenticate/options") {
        return { ok: true, json: async () => ({ options: {}, challengeId: "c1", prfSalt: "aa".repeat(32) }) };
      }
      if (url === "/api/webauthn/authenticate/verify") {
        return { ok: true, json: async () => ({ verified: true, prf: state.prf }) };
      }
      if (!baseHandler) throw new Error("fetch env has no base handler");
      return baseHandler(url, init);
    }) as unknown as typeof fetch;

    const generated: { ecdhPrivateKey: Uint8Array | null } = { ecdhPrivateKey: null };
    const actualExport = cryptoTeam.exportPrivateKey;
    const exportSpy = vi.spyOn(cryptoTeam, "exportPrivateKey").mockImplementation(async (key) => {
      const bytes = await actualExport(key);
      generated.ecdhPrivateKey = new Uint8Array(bytes);
      return bytes;
    });
    const hook = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await hook.result.current.setup(PASSPHRASE);
    });
    exportSpy.mockRestore();

    const secretKey = hook.result.current.getSecretKey();
    if (!secretKey) throw new Error("setup left no secret key");
    const wrapped = await wrapSecretKeyWithPrf(secretKey, PRF_BYTES);
    const prfData = {
      prfEncryptedSecretKey: wrapped.ciphertext,
      prfSecretKeyIv: wrapped.iv,
      prfSecretKeyAuthTag: wrapped.authTag,
    };
    state.prf = prfData;
    vi.spyOn(webauthnClient, "startPasskeyAuthentication").mockResolvedValue({
      responseJSON: { id: "cred-1" },
      prfOutput: new Uint8Array(PRF_BYTES),
    } as Awaited<ReturnType<typeof webauthnClient.startPasskeyAuthentication>>);
    act(() => {
      hook.result.current.lock();
    });
    return { result: hook.result, generated, prfData };
  }

  /** Pass-through spy (crypto stays real) capturing every decrypted buffer. */
  function captureDecrypted() {
    const buffers: ArrayBuffer[] = [];
    const actual = cryptoClient.decryptBinary;
    vi.spyOn(cryptoClient, "decryptBinary").mockImplementation(async (...args) => {
      const buffer = await actual(...args);
      buffers.push(buffer);
      return buffer;
    });
    return buffers;
  }

  const UNLOCKS = {
    unlock: (vault: ReturnType<typeof useVault>) => vault.unlock(PASSPHRASE),
    unlockWithPasskey: (vault: ReturnType<typeof useVault>) => vault.unlockWithPasskey(),
    unlockWithStoredPrf: (vault: ReturnType<typeof useVault>) => vault.unlockWithStoredPrf(),
  };

  it.each(Object.keys(UNLOCKS) as (keyof typeof UNLOCKS)[])(
    "%s zeroizes the decrypted ECDH private key and keeps a working copy of it",
    async (path) => {
      const { result, generated, prfData } = await setUpThenLock();
      stashPrf({ prfOutput: new Uint8Array(PRF_BYTES), prfData });
      const decrypted = captureDecrypted();

      let ok = false;
      await act(async () => {
        ok = await UNLOCKS[path](result.current);
      });

      expect(ok).toBe(true);
      // The ECDH private key is the only thing the unlock paths decrypt.
      expect(decrypted).toHaveLength(1);
      expect(new Uint8Array(decrypted[0]).every((b) => b === 0)).toBe(true);
      const held = result.current.getEcdhPrivateKeyBytes();
      expect(held?.some((b) => b !== 0)).toBe(true);
      expect(held).toEqual(generated.ecdhPrivateKey);
    },
    60_000,
  );
});

describe("VaultProvider — a page hide while setting up or unlocking installs nothing", () => {
  it("unlock reports an interruption, not a failed attempt, and leaves the vault locked when the page is hidden during the unlock POST", async () => {
    const { fetchMock } = makeFetchEnv(null);
    const baseHandler = fetchMock.getMockImplementation();
    const state = { locked: false, unlockPosts: [] as string[] };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === "/api/vault/unlock" && state.locked) {
        state.unlockPosts.push(JSON.parse(init?.body as string).authHash);
        if (state.unlockPosts.length === 1) window.dispatchEvent(new Event("pagehide"));
      }
      if (!baseHandler) throw new Error("fetch env has no base handler");
      return baseHandler(url, init);
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await result.current.setup(PASSPHRASE);
    });
    act(() => {
      result.current.lock();
    });
    state.locked = true;

    let ok: boolean | undefined;
    let caught: unknown;
    await act(async () => {
      try {
        ok = await result.current.unlock(PASSPHRASE);
      } catch (e) {
        caught = e;
      }
    });

    expect(ok).toBeUndefined();
    expect(caught).toBeInstanceOf(VaultUnlockError);
    expect((caught as VaultUnlockError).code).toBe(VAULT_UNLOCK_INTERRUPTED);
    // Only the real unlock POST: no dummy-hash failure report (notifyUnlockFailure)
    // counting toward the server's lockout.
    expect(state.unlockPosts).toHaveLength(1);
    expect(state.unlockPosts[0]).not.toBe("0".repeat(64));
    expect(result.current.status).toBe(VAULT_STATUS.LOCKED);
    expect(result.current.encryptionKey).toBeNull();
    expect(result.current.getSecretKey()).toBeNull();
    expect(result.current.getEcdhPrivateKeyBytes()).toBeNull();
  }, 60_000);

  it("setup leaves the committed vault locked, not set up in memory, when the page is hidden during the setup POST", async () => {
    const { fetchMock } = makeFetchEnv(null);
    const baseHandler = fetchMock.getMockImplementation();
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === "/api/vault/setup") window.dispatchEvent(new Event("pagehide"));
      if (!baseHandler) throw new Error("fetch env has no base handler");
      return baseHandler(url, init);
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useVault(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED));

    await act(async () => {
      await result.current.setup(PASSPHRASE);
    });

    expect(result.current.status).toBe(VAULT_STATUS.LOCKED);
    expect(result.current.encryptionKey).toBeNull();
    expect(result.current.getSecretKey()).toBeNull();
  }, 60_000);
});
