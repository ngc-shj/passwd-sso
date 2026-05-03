// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
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
} from "./vault-context";

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

interface FetchEnv {
  fetchMock: ReturnType<typeof vi.fn>;
  store: { vault: ServerVault | null };
}

/**
 * Build a fetch mock that simulates the API endpoints exercised by the vault
 * provider: status / setup / unlock / unlock-data / delegation. Setup writes
 * to an in-memory store so that a follow-up unlock can read the same data.
 */
function makeFetchEnv(initialVault: ServerVault | null = null): FetchEnv {
  const store: { vault: ServerVault | null } = { vault: initialVault };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
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
  }) as unknown as ReturnType<typeof vi.fn>;

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
