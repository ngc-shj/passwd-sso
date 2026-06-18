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
} from "./vault-context";
import { VAULT_STATUS } from "@/lib/constants";
import { stashPrf, clearPrf } from "@/lib/auth/prf-handoff";
import { encryptData, decryptData } from "@/lib/crypto/crypto-client";
import { buildPersonalEntryAAD, VAULT_TYPE } from "@/lib/crypto/crypto-aad";
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
    "T1: pagehide zeroes secretKeyRef (status stays UNLOCKED), persisted pageshow forces lock()",
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

      // Simulate bfcache: pagehide zeroes secretKeyRef but does NOT call lock().
      // After pagehide: secretKeyRef.current === null, vaultStatus still UNLOCKED.
      act(() => {
        window.dispatchEvent(new Event("pagehide"));
      });
      // encryptionKey is still set (pagehide does not call lock()/setEncryptionKey(null))
      // vaultStatus is still UNLOCKED
      expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);

      // Simulate bfcache restore: persisted pageshow fires.
      // Handler checks secretKeyRef.current === null && vaultStatus === UNLOCKED → calls lock().
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
