// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useEffect, useLayoutEffect, useState } from "react";
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
  VAULT_SETUP_OUTCOME_UNKNOWN,
  VaultChangeOutcomeUnknownError,
  VaultChangedElsewhereError,
} from "./vault-context";
import { VAULT_STATUS } from "@/lib/constants";
import { SessionChangedError } from "@/lib/url-helpers";
import { API_ERROR } from "@/lib/http/api-error-codes";
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
import { buildAttachmentAAD, buildAttachmentCekWrapAAD, buildPersonalEntryAAD, VAULT_TYPE } from "@/lib/crypto/crypto-aad";
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

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
    expect(caught).not.toBeInstanceOf(VaultUnlockError);
    expect((caught as Error).message).toMatch(/ALREADY_SETUP/);
    expect(result.current.encryptionKey).toBeNull();
  }, 30_000);
});

// F7-3: the setup route answers 201 once committed and nothing else after it.
// A rejected fetch or a 5xx that is not a pre-route refusal may follow the
// commit, so the vault may exist with the passphrase just entered.
describe("VaultProvider — setup whose outcome is unknown", () => {
  /**
   * Run setup where the setup POST commits on the server (when `commits`) and
   * then gets `response`. Counts the vault status requests sent after the POST.
   */
  async function setupAnswered(response: MockFetchResponse | Error, commits: boolean) {
    const { fetchMock } = makeFetchEnv(null);
    const baseHandler = fetchMock.getMockImplementation();
    if (!baseHandler) throw new Error("fetch env has no base handler");
    const counts = { posted: false, statusAfterPost: 0 };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === "/api/vault/setup") {
        counts.posted = true;
        if (commits) await baseHandler(url, init);
        if (response instanceof Error) throw response;
        return response;
      }
      if (url === "/api/vault/status" && counts.posted) counts.statusAfterPost += 1;
      return baseHandler(url, init);
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useVault(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED));
    let caught: unknown;
    await act(async () => {
      try {
        await result.current.setup(PASSPHRASE);
      } catch (e) {
        caught = e;
      }
    });
    return { result, caught, counts };
  }

  it.each([
    ["a POST rejected in transit", new TypeError("Failed to fetch")],
    ["a 502 whose body is not JSON", { ok: false, status: 502, json: unreadableBody }],
    ["a 500 INTERNAL_ERROR", { ok: false, status: 500, json: async () => ({ error: API_ERROR.INTERNAL_ERROR }) }],
  ] as const)(
    "reports %s as an unknown outcome and leaves the committed vault LOCKED for an unlock",
    async (_kind, response) => {
      const { result, caught, counts } = await setupAnswered(response, true);

      expect((caught as VaultUnlockError).code).toBe(VAULT_SETUP_OUTCOME_UNKNOWN);
      await waitFor(() => expect(result.current.status).toBe(VAULT_STATUS.LOCKED));
      expect(counts.statusAfterPost).toBeGreaterThan(0);
      expect(result.current.getSecretKey()).toBeNull();
    },
    30_000,
  );

  it("rethrows SessionChangedError without asking the status again: the proxy refused the POST before the route ran", async () => {
    const { result, caught, counts } = await setupAnswered(new SessionChangedError(), false);

    expect(caught).toBeInstanceOf(SessionChangedError);
    expect(counts.statusAfterPost).toBe(0);
    expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED);
  }, 30_000);

  it.each([
    ["429 RATE_LIMIT_EXCEEDED", 429, API_ERROR.RATE_LIMIT_EXCEEDED],
    ["400 VALIDATION_ERROR", 400, API_ERROR.VALIDATION_ERROR],
    ["503 SERVICE_UNAVAILABLE", 503, API_ERROR.SERVICE_UNAVAILABLE],
  ] as const)(
    "reports a %s refusal as a failed setup without asking the status again",
    async (_kind, status, error) => {
      const { result, caught, counts } = await setupAnswered(
        { ok: false, status, json: async () => ({ error }) },
        false,
      );

      expect(caught).not.toBeInstanceOf(VaultUnlockError);
      expect((caught as Error).message).toBe(error);
      expect(counts.statusAfterPost).toBe(0);
      expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED);
    },
    30_000,
  );
});

// F8-4 / F9-2: a lock while the setup POST is in flight moves the lock epoch.
// Only a session that ended or moved to another user makes that an
// interruption. After a same-user lock (page hide and bfcache restore,
// auto-lock) an unanswered POST leaves the outcome unknown, and a committed
// one (201, or the vault already exists) leaves the vault LOCKED for an unlock.
describe("VaultProvider — setup after a lock during the POST", () => {
  /**
   * Run setup whose POST commits on the server and then gets `response` (the
   * server's own 201 when omitted), with `during` run while the POST is held.
   * Counts the vault status requests sent once the POST was answered — not
   * the one a session change itself starts while the POST is held.
   */
  async function setupLockedDuringPost(
    during: (rerender: () => void) => void,
    response?: MockFetchResponse | Error,
  ) {
    const { fetchMock } = makeFetchEnv(null);
    const baseHandler = fetchMock.getMockImplementation();
    if (!baseHandler) throw new Error("fetch env has no base handler");
    const reached = deferred();
    const gate = deferred();
    const counts = { answered: false, statusAfterPost: 0 };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === "/api/vault/setup") {
        reached.resolve();
        await gate.promise;
        const committed = await baseHandler(url, init);
        counts.answered = true;
        if (response instanceof Error) throw response;
        return response ?? committed;
      }
      if (url === "/api/vault/status" && counts.answered) counts.statusAfterPost += 1;
      return baseHandler(url, init);
    }) as unknown as typeof fetch;

    const { result, rerender } = renderHook(() => useVault(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED));
    let settled!: Promise<unknown>;
    act(() => {
      settled = result.current.setup(PASSPHRASE).then(
        () => undefined,
        (caught: unknown) => caught,
      );
    });
    await act(async () => {
      await reached.promise;
    });
    act(() => {
      during(rerender);
    });
    gate.resolve();
    let caught: unknown;
    await act(async () => {
      caught = await settled;
    });
    return { result, caught, counts };
  }

  const pageHidden = () => window.dispatchEvent(new Event("pagehide"));
  const switchedToAnotherUser = (rerender: () => void) => {
    mockUseSession.mockReturnValue({
      data: { user: { id: "user-2", email: "u2@example.com" } },
      status: "authenticated",
      update: vi.fn(),
    });
    rerender();
  };
  const signedOut = (rerender: () => void) => {
    mockUseSession.mockReturnValue({ data: null, status: "unauthenticated", update: vi.fn() });
    rerender();
  };

  it.each([
    ["a POST rejected in transit", new TypeError("Failed to fetch")],
    ["a 500 INTERNAL_ERROR", { ok: false, status: 500, json: async () => ({ error: API_ERROR.INTERNAL_ERROR }) }],
  ] as const)(
    "reports %s after a same-user lock as an unknown outcome, not an interruption",
    async (_kind, response) => {
      const { result, caught, counts } = await setupLockedDuringPost(pageHidden, response);

      expect((caught as VaultUnlockError).code).toBe(VAULT_SETUP_OUTCOME_UNKNOWN);
      await waitFor(() => expect(result.current.status).toBe(VAULT_STATUS.LOCKED));
      expect(counts.statusAfterPost).toBeGreaterThan(0);
      expect(result.current.getSecretKey()).toBeNull();
    },
    30_000,
  );

  // T9-4: the moved-session arm asks the new user's status again, so that
  // session's own answer decides what its page shows.
  it("reports a POST rejected in transit after a switch to another user as an interruption and asks the status again", async () => {
    const { result, caught, counts } = await setupLockedDuringPost(switchedToAnotherUser, new TypeError("Failed to fetch"));

    expect((caught as VaultUnlockError).code).toBe(VAULT_UNLOCK_INTERRUPTED);
    expect(counts.statusAfterPost).toBeGreaterThan(0);
    expect(result.current.getSecretKey()).toBeNull();
  }, 30_000);

  it("reports a POST rejected in transit after a sign-out as UNAUTHORIZED and asks no status", async () => {
    const { result, caught, counts } = await setupLockedDuringPost(signedOut, new TypeError("Failed to fetch"));

    expect((caught as VaultUnlockError).code).toBe(API_ERROR.UNAUTHORIZED);
    expect(counts.statusAfterPost).toBe(0);
    expect(result.current.getSecretKey()).toBeNull();
  }, 30_000);

  const alreadySetUp = {
    ok: false,
    status: 409,
    json: async () => ({ error: API_ERROR.VAULT_ALREADY_SETUP }),
  } as const;

  it.each([
    ["a 201", undefined],
    ["a VAULT_ALREADY_SETUP 409", alreadySetUp],
  ] as const)(
    "leaves the vault LOCKED for an unlock, without throwing, when %s answers after a same-user lock",
    async (_kind, response) => {
      const { result, caught } = await setupLockedDuringPost(pageHidden, response);

      expect(caught).toBeUndefined();
      expect(result.current.status).toBe(VAULT_STATUS.LOCKED);
      expect(result.current.encryptionKey).toBeNull();
      expect(result.current.getSecretKey()).toBeNull();
      expect(result.current.getEcdhPrivateKeyBytes()).toBeNull();
    },
    30_000,
  );

  it.each([
    ["a 201", undefined],
    ["a VAULT_ALREADY_SETUP 409", alreadySetUp],
  ] as const)(
    "reports %s after a switch to another user as an interruption and asks the status again",
    async (_kind, response) => {
      const { result, caught, counts } = await setupLockedDuringPost(switchedToAnotherUser, response);

      expect((caught as VaultUnlockError).code).toBe(VAULT_UNLOCK_INTERRUPTED);
      expect(counts.statusAfterPost).toBeGreaterThan(0);
      expect(result.current.encryptionKey).toBeNull();
      expect(result.current.getSecretKey()).toBeNull();
    },
    30_000,
  );

  it.each([
    ["a 201", undefined],
    ["a VAULT_ALREADY_SETUP 409", alreadySetUp],
  ] as const)(
    "reports %s after a sign-out as UNAUTHORIZED",
    async (_kind, response) => {
      const { result, caught } = await setupLockedDuringPost(signedOut, response);

      expect((caught as VaultUnlockError).code).toBe(API_ERROR.UNAUTHORIZED);
      expect(result.current.getSecretKey()).toBeNull();
    },
    30_000,
  );
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
    // As in the app, setup starts once the server has reported setup required.
    await waitFor(() => expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED));
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

    expect((caught as VaultUnlockError).code).toBe(VAULT_SETUP_OUTCOME_UNKNOWN);
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

  // SERVICE_UNAVAILABLE: a limiter that fails closed, or a stored verifier
  // whose pepper version the server cannot resolve — refused before the write.
  it.each([
    ["RATE_LIMIT_EXCEEDED", 429],
    ["SERVICE_UNAVAILABLE", 503],
  ] as const)("throws %s and keeps the vault unlocked on the old wrap when the server refuses the change", async (code, status) => {
    const { result, sent } = await setUpWithChangeResponse({
      ok: false,
      status,
      json: async () => ({ error: code }),
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

    expect(caught).toEqual({ error: code });
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

  // The proxy refused the POST before the route ran: nothing changed, so the
  // vault stays unlocked on the key it holds and the outcome is not unknown.
  it("rethrows SessionChangedError and keeps the vault unlocked when the POST is refused for a changed session", async () => {
    const { result } = await setUpWithChangeResponse(new SessionChangedError());
    const saltBefore = hex(result.current.getAccountSalt());

    const caught = await changeCatching(result);

    expect(caught).toBeInstanceOf(SessionChangedError);
    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
    expect(hex(result.current.getAccountSalt())).toBe(saltBefore);
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

  it("reports a refusal received after the vault was locked as not started, without throwing", async () => {
    const onPost: { run?: () => void } = {};
    const { result, sent } = await setUpWithChangeResponse(
      { ok: false, status: 429, json: async () => ({ error: "RATE_LIMIT_EXCEEDED" }) },
      { onPost },
    );
    onPost.run = () => result.current.lock();

    const { outcome, caught } = await changeOutcome(result);

    expect(caught).toBeUndefined();
    expect(outcome).toBe(PASSPHRASE_CHANGE_NOT_STARTED_VAULT_LOCKED);
    expect(sent.accountSalt).toBeDefined();
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

  it("drops the key material and moves the lock epoch when the session ends while the vault is unlocked", async () => {
    const { fetchMock } = makeFetchEnv(null);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { result, rerender } = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await result.current.setup(PASSPHRASE);
    });
    const epochBefore = result.current.getLockEpoch();
    expect(result.current.getSecretKey()).not.toBeNull();
    expect(result.current.getEcdhPrivateKeyBytes()).not.toBeNull();

    mockUseSession.mockReturnValue({ data: null, status: "unauthenticated", update: vi.fn() });
    rerender();

    expect(result.current.status).toBe(VAULT_STATUS.LOCKED);
    expect(result.current.encryptionKey).toBeNull();
    expect(result.current.getSecretKey()).toBeNull();
    expect(result.current.getEcdhPrivateKeyBytes()).toBeNull();
    expect(result.current.getLockEpoch()).toBeGreaterThan(epochBefore);
  }, 60_000);

  /**
   * A fetch env whose next /api/vault/status request, once `hold.next` is set,
   * resolves `reached` and is answered by `respond` — by default the server's
   * answer as of the moment the request arrived, returned only once `gate`
   * resolves: a response that arrives late.
   */
  function heldStatusEnv() {
    const { fetchMock } = makeFetchEnv(null);
    const baseHandler = fetchMock.getMockImplementation();
    const hold: {
      next: { reached: ReturnType<typeof deferred>; respond: () => Promise<MockFetchResponse> } | null;
    } = { next: null };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (!baseHandler) throw new Error("fetch env has no base handler");
      const held = url === "/api/vault/status" ? hold.next : null;
      if (!held) return baseHandler(url, init);
      hold.next = null;
      held.reached.resolve();
      return held.respond();
    }) as unknown as typeof fetch;
    const answerNowReturnLater = async (gate: Promise<void>): Promise<MockFetchResponse> => {
      if (!baseHandler) throw new Error("fetch env has no base handler");
      const body = await (await baseHandler("/api/vault/status")).json();
      await gate;
      return { ok: true, json: async () => body };
    };
    return { hold, answerNowReturnLater };
  }

  it("ignores a setup-required status response that arrives after a setup installed its key", async () => {
    const { hold, answerNowReturnLater } = heldStatusEnv();
    const { result, rerender } = renderHook(() => useVault(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED));
    const held = { reached: deferred(), gate: deferred() };
    const answered = answerNowReturnLater(held.gate.promise);
    hold.next = { reached: held.reached, respond: () => answered };
    // Requested before setup: the server still reports setup required.
    await recheckStatus(rerender);
    await act(async () => {
      await held.reached.promise;
    });
    await act(async () => {
      await result.current.setup(PASSPHRASE);
    });
    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
    const epochBefore = result.current.getLockEpoch();

    held.gate.resolve();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
    expect(result.current.getSecretKey()?.some((b) => b !== 0)).toBe(true);
    expect(result.current.encryptionKey).not.toBeNull();
    expect(result.current.getLockEpoch()).toBe(epochBefore);
  }, 60_000);

  // Each arm of the check reads its response after an await; a request
  // superseded meanwhile must not overwrite the later request's SETUP_REQUIRED.
  it.each([
    ["an error status", (gate: Promise<void>): Promise<MockFetchResponse> =>
      gate.then(() => ({ ok: false, status: 500, json: async () => ({}) }))],
    ["a body read after the later request", async (gate: Promise<void>): Promise<MockFetchResponse> => ({
      ok: true,
      json: async () => {
        await gate;
        return { setupRequired: false, hasRecoveryKey: false, vaultAutoLockMinutes: null };
      },
    })],
    ["a rejected request", (gate: Promise<void>): Promise<MockFetchResponse> =>
      gate.then(() => {
        throw new TypeError("Failed to fetch");
      })],
  ] as const)("ignores a status response superseded by a later request (%s)", async (_kind, respond) => {
    const { hold } = heldStatusEnv();
    const held = { reached: deferred(), gate: deferred() };
    hold.next = { reached: held.reached, respond: () => respond(held.gate.promise) };
    const { result, rerender } = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await held.reached.promise;
    });
    await recheckStatus(rerender);
    expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED);

    held.gate.resolve();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED);
  });

  // Moving into unauthenticated moves the lock epoch whatever was held (an
  // update() refetch also passes through loading), so only the settle is pinned.
  it("settles a loading vault to LOCKED when the session resolves unauthenticated", async () => {
    mockUseSession.mockReturnValue({ data: null, status: "loading", update: vi.fn() });
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const { result, rerender } = renderHook(() => useVault(), { wrapper });
    expect(result.current.status).toBe(VAULT_STATUS.LOADING);

    mockUseSession.mockReturnValue({ data: null, status: "unauthenticated", update: vi.fn() });
    rerender();

    expect(result.current.status).toBe(VAULT_STATUS.LOCKED);
  });

  it("settles a passkey-gated session's loading vault to LOCKED without moving the lock epoch", async () => {
    mockUseSession.mockReturnValue({
      data: { user: { id: "user-1", passkeyBlocked: true } },
      status: "authenticated",
      update: vi.fn(),
    });
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const { result } = renderHook(() => useVault(), { wrapper });

    expect(result.current.status).toBe(VAULT_STATUS.LOCKED);
    expect(result.current.getLockEpoch()).toBe(0);
  });

  /** Re-render under a new session object, which re-runs the vault status check. */
  async function recheckStatus(rerender: () => void) {
    mockUseSession.mockReturnValue({
      data: { user: { id: "user-1", email: "u@example.com" } },
      status: "authenticated",
      update: vi.fn(),
    });
    rerender();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("drops the key material and moves the lock epoch when a status check finds the vault reset while unlocked", async () => {
    const { fetchMock, store } = makeFetchEnv(null);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { result, rerender } = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await result.current.setup(PASSPHRASE);
    });
    const epochBefore = result.current.getLockEpoch();
    store.vault = null;

    await recheckStatus(rerender);

    expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED);
    expect(result.current.encryptionKey).toBeNull();
    expect(result.current.getSecretKey()).toBeNull();
    expect(result.current.getEcdhPrivateKeyBytes()).toBeNull();
    expect(result.current.getLockEpoch()).toBeGreaterThan(epochBefore);
  }, 60_000);

  it("lets a setup in flight install its key when a status check still finds setup required", async () => {
    const { fetchMock } = makeFetchEnv(null);
    const baseHandler = fetchMock.getMockImplementation();
    const reached = deferred();
    const gate = deferred();
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (!baseHandler) throw new Error("fetch env has no base handler");
      if (url === "/api/vault/setup") {
        reached.resolve();
        await gate.promise;
      }
      return baseHandler(url, init);
    }) as unknown as typeof fetch;
    const { result, rerender } = renderHook(() => useVault(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED));
    const epochBefore = result.current.getLockEpoch();

    let settled!: Promise<unknown>;
    act(() => {
      settled = result.current.setup(PASSPHRASE);
    });
    await act(async () => {
      await reached.promise;
    });
    // The setup POST has not reached the store yet: the check reports setup required.
    await recheckStatus(rerender);
    expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED);
    expect(result.current.getLockEpoch()).toBe(epochBefore);
    gate.resolve();
    await act(async () => {
      await settled;
    });

    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
    expect(result.current.getSecretKey()?.some((b) => b !== 0)).toBe(true);
  }, 60_000);
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

// ── INV-C1.6: a page hide is a lock ──────────────────────────────────────────
// pagehide drops the key material and queues LOCKED with the null encryption
// key, so a page restored from the bfcache renders locked. There is no pageshow
// handler: the queued update is what the restored page renders.
describe("VaultProvider — a page hide locks the vault (INV-C1.6)", () => {
  it(
    "pagehide drops the key material and locks the vault; a persisted pageshow leaves it locked",
    async () => {
      const { fetchMock } = makeFetchEnv(null);
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const { result } = renderHook(() => useVault(), { wrapper });

      await act(async () => {
        await result.current.setup(PASSPHRASE);
      });
      expect(result.current.encryptionKey).not.toBeNull();
      expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);

      act(() => {
        window.dispatchEvent(new Event("pagehide"));
      });
      expect(result.current.status).toBe(VAULT_STATUS.LOCKED);
      expect(result.current.encryptionKey).toBeNull();
      expect(result.current.getSecretKey()).toBeNull();
      expect(result.current.getEcdhPrivateKeyBytes()).toBeNull();

      act(() => {
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      });

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
   * `onPost.run`, when set, runs (and is awaited) while the POST is in flight;
   * `onPost.onData` likewise while the rotate-key/data GET is.
   */
  async function setUpWithRotateResponse(
    response: MockFetchResponse | Error,
    onPost: { run?: () => void | Promise<void>; onData?: () => void | Promise<void> } = {},
  ) {
    const { fetchMock } = makeFetchEnv(null);
    const sent: { body: RotatePost | null; dataFetches: number } = { body: null, dataFetches: 0 };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === "/api/vault/rotate-key/data") {
        sent.dataFetches += 1;
        await onPost.onData?.();
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
        await onPost.run?.();
        if (response instanceof Error) throw response;
        return response;
      }
      return fetchMock(url, init);
    }) as unknown as typeof fetch;

    const hook = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await hook.result.current.setup(PASSPHRASE);
    });
    return { result: hook.result, rerender: hook.rerender, sent, oldKey: hook.result.current.encryptionKey };
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

  // A rotation re-keys a vault already unlocked: unlike a setup, it cannot make
  // a setupRequired verdict requested before it stale.
  it("drops the keys and requires setup when a status check started before a rotation finds the vault reset", async () => {
    const { result, rerender } = await setUpWithRotateResponse({
      ok: true,
      json: async () => ({ success: true, keyVersion: 2, rotationEffects: null }),
    });
    const rotationFetch = globalThis.fetch;
    const held = { reached: deferred(), gate: deferred() };
    let holdStatus = true;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === "/api/vault/status" && holdStatus) {
        holdStatus = false;
        held.reached.resolve();
        await held.gate.promise;
        // The vault was reset elsewhere before this request arrived.
        return { ok: true, json: async () => ({ setupRequired: true, hasRecoveryKey: false, vaultAutoLockMinutes: null }) };
      }
      return rotationFetch(url, init);
    }) as unknown as typeof fetch;
    mockUseSession.mockReturnValue({
      data: { user: { id: "user-1", email: "u@example.com" } },
      status: "authenticated",
      update: vi.fn(),
    });
    rerender();
    await act(async () => {
      await held.reached.promise;
    });

    const { caught } = await rotate(result);
    expect(caught).toBeUndefined();
    expect(result.current.getKeyVersion()).toBe(2);

    held.gate.resolve();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED);
    expect(result.current.encryptionKey).toBeNull();
    expect(result.current.getSecretKey()).toBeNull();
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

  it("rethrows SessionChangedError and keeps the vault unlocked when the rotate POST is refused for a changed session", async () => {
    const { result } = await setUpWithRotateResponse(new SessionChangedError());

    const { caught } = await rotate(result);

    expect(caught).toBeInstanceOf(SessionChangedError);
    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
    expect(result.current.getKeyVersion()).toBe(1);
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

  it.each([
    ["RATE_LIMIT_EXCEEDED", 429],
    ["VERIFIER_NOT_SET", 409],
    ["SERVICE_UNAVAILABLE", 503],
  ] as const)(
    "stays unlocked on the old key when the server refuses with %s before committing",
    async (code, status) => {
      const { result, sent, oldKey } = await setUpWithRotateResponse({
        ok: false,
        status,
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

  it("reports a refusal received after the vault was locked as not started, without throwing", async () => {
    const onPost: { run?: () => void } = {};
    const { result, sent } = await setUpWithRotateResponse(
      { ok: false, status: 429, json: async () => ({ error: "RATE_LIMIT_EXCEEDED" }) },
      onPost,
    );
    onPost.run = () => result.current.lock();

    const { outcome, caught } = await rotate(result);

    expect(caught).toBeUndefined();
    expect(outcome).toBe(ROTATION_NOT_STARTED_VAULT_LOCKED);
    expect(sent.body).not.toBeNull();
    expectLocked(result);
  }, 60_000);

  it("fetches no rotation data when the vault is locked while the current verifier is computed", async () => {
    const { result, sent } = await setUpWithRotateResponse({
      ok: true,
      json: async () => ({ success: true, keyVersion: 2, rotationEffects: null }),
    });
    const actual = cryptoClient.computePassphraseVerifier;
    const spy = vi.spyOn(cryptoClient, "computePassphraseVerifier").mockImplementationOnce(async (...args) => {
      const verifier = await actual(...args);
      result.current.lock();
      return verifier;
    });

    const { outcome, caught } = await rotate(result);
    spy.mockRestore();

    expect(caught).toBeUndefined();
    expect(outcome).toBe(ROTATION_NOT_STARTED_VAULT_LOCKED);
    expect(sent.dataFetches).toBe(0);
    expect(sent.body).toBeNull();
    expectLocked(result);
  }, 60_000);

  /** End the session the provider renders under (useSession goes unauthenticated). */
  function endSession(rerender: () => void) {
    mockUseSession.mockReturnValue({ data: null, status: "unauthenticated", update: vi.fn() });
    rerender();
  }

  it.each([
    ["while the rotation data is fetched", "onData", ROTATION_NOT_STARTED_VAULT_LOCKED],
    ["while the rotate POST is in flight", "run", { outcome: ROTATION_COMMITTED_VAULT_LOCKED, effects: null }],
  ] as const)(
    "drops the key material when the session ends %s, and the rotation reports where it stopped",
    async (_when, hook, expected) => {
      const reached = deferred();
      const gate = deferred();
      const hooks: { run?: () => Promise<void>; onData?: () => Promise<void> } = {};
      hooks[hook] = async () => {
        reached.resolve();
        await gate.promise;
      };
      const { result, rerender, sent } = await setUpWithRotateResponse(
        { ok: true, json: async () => ({ success: true, keyVersion: 2, rotationEffects: null }) },
        hooks,
      );
      const epochBefore = result.current.getLockEpoch();

      let settled!: Promise<{ outcome?: unknown; caught?: unknown }>;
      act(() => {
        settled = result.current.rotateKey(PASSPHRASE).then(
          (outcome) => ({ outcome }),
          (caught: unknown) => ({ caught }),
        );
      });
      await act(async () => {
        await reached.promise;
      });
      endSession(rerender);
      gate.resolve();
      let settledWith: { outcome?: unknown; caught?: unknown } = {};
      await act(async () => {
        settledWith = await settled;
      });

      expect(settledWith.caught).toBeUndefined();
      expect(settledWith.outcome).toEqual(expected);
      expect(sent.body === null).toBe(hook === "onData");
      expect(result.current.getLockEpoch()).toBeGreaterThan(epochBefore);
      expectLocked(result);
      expect(result.current.getEcdhPrivateKeyBytes()).toBeNull();
    },
    60_000,
  );

  /**
   * An unlocked vault whose rotation data lists `count` entries, `count`
   * history rows and `count` attachment CEKs, all under the vault's key.
   */
  async function setUpWithRotationRows(count: number) {
    const { fetchMock } = makeFetchEnv(null);
    const rows = {
      entries: [] as unknown[],
      historyEntries: [] as unknown[],
      mode2Attachments: [] as unknown[],
    };
    const sent: {
      body: { entries: unknown[]; historyEntries: unknown[]; attachmentCekRewraps: unknown[] } | null;
      posts: number;
    } = { body: null, posts: 0 };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === "/api/vault/rotate-key/data") {
        return {
          ok: true,
          json: async () => ({ ...rows, mode0Attachments: [], mode0AttachmentsOverflow: false }),
        };
      }
      if (url === "/api/vault/rotate-key" && init?.method === "POST") {
        sent.posts += 1;
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
    for (let i = 0; i < count; i++) {
      const entryId = `entry-${i}`;
      const blob = await encryptData(`{"title":"t${i}"}`, key, buildPersonalEntryAAD("user-1", entryId, VAULT_TYPE.BLOB));
      const overview = await encryptData(`{"title":"t${i}"}`, key, buildPersonalEntryAAD("user-1", entryId, VAULT_TYPE.OVERVIEW));
      rows.entries.push({
        id: entryId,
        encryptedBlob: blob.ciphertext,
        blobIv: blob.iv,
        blobAuthTag: blob.authTag,
        encryptedOverview: overview.ciphertext,
        overviewIv: overview.iv,
        overviewAuthTag: overview.authTag,
        keyVersion: 1,
        aadVersion: 1,
      });
      rows.historyEntries.push({
        id: `hist-${i}`,
        entryId,
        encryptedBlob: blob.ciphertext,
        blobIv: blob.iv,
        blobAuthTag: blob.authTag,
        keyVersion: 1,
        aadVersion: 1,
      });
      const attId = `att-${i}`;
      const cek = crypto.getRandomValues(new Uint8Array(32));
      const wrappedCek = await cryptoClient.encryptBinary(cek.buffer, key, buildAttachmentCekWrapAAD(entryId, attId, 1, 1));
      rows.mode2Attachments.push({
        id: attId,
        entryId,
        cekEncrypted: btoa(String.fromCharCode(...wrappedCek.ciphertext)),
        cekIv: wrappedCek.iv,
        cekAuthTag: wrappedCek.authTag,
        cekKeyVersion: 1,
        cekWrapAadVersion: 1,
      });
    }
    return { result: hook.result, sent };
  }

  /** Pass-through spies (crypto stays real) counting decryptions under the old key. */
  function countDecrypts() {
    const decryptData = vi.spyOn(cryptoClient, "decryptData");
    const decryptBinary = vi.spyOn(cryptoClient, "decryptBinary");
    return {
      counts: () => ({ data: decryptData.mock.calls.length, binary: decryptBinary.mock.calls.length }),
      restore: () => {
        decryptData.mockRestore();
        decryptBinary.mockRestore();
      },
    };
  }

  it("re-encrypts every entry, history row and attachment CEK into one rotation POST when the vault stays unlocked", async () => {
    const { result, sent } = await setUpWithRotationRows(3);
    const decrypts = countDecrypts();

    const { outcome, caught } = await rotate(result);
    const counts = decrypts.counts();
    decrypts.restore();

    expect(caught).toBeUndefined();
    expect(outcome).toBeNull();
    expect(sent.posts).toBe(1);
    expect(sent.body?.entries).toHaveLength(3);
    expect(sent.body?.historyEntries).toHaveLength(3);
    expect(sent.body?.attachmentCekRewraps).toHaveLength(3);
    // Two per entry (blob, overview) plus one per history row; one per CEK.
    expect(counts).toEqual({ data: 9, binary: 3 });
    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
  }, 60_000);

  // A lock at the first row of a loop stops it before its second row: what was
  // decrypted before the lock is all that is decrypted.
  it.each([
    ["entries", { data: 2, binary: 0 }],
    ["history", { data: 7, binary: 0 }],
    ["rewrapping", { data: 9, binary: 0 }],
  ] as const)(
    "stops decrypting at the next row and sends nothing when the vault is locked in the %s loop",
    async (phase, expected) => {
      const { result, sent } = await setUpWithRotationRows(3);
      const decrypts = countDecrypts();
      let ran = false;

      let outcome: unknown;
      let caught: unknown;
      await act(async () => {
        try {
          outcome = await result.current.rotateKey(PASSPHRASE, (progress) => {
            if (progress.phase === phase && progress.current === 0 && !ran) {
              ran = true;
              result.current.lock();
            }
          });
        } catch (e) {
          caught = e;
        }
      });
      const counts = decrypts.counts();
      decrypts.restore();

      expect(ran).toBe(true);
      expect(caught).toBeUndefined();
      expect(outcome).toBe(ROTATION_NOT_STARTED_VAULT_LOCKED);
      expect(counts).toEqual(expected);
      expect(sent.posts).toBe(0);
      expectLocked(result);
    },
    60_000,
  );
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

  it("setup throws 'Setup failed' when a 4xx error body is unreadable", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === "/api/vault/status") {
        return { ok: true, json: async () => ({ setupRequired: true }) };
      }
      if (url === "/api/vault/setup") {
        return { ok: false, status: 413, json: unreadableBody };
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

const PRF_BYTES = new Uint8Array(32).fill(0x3c);

/**
 * Set up (keeping a copy of the ECDH private key setup generated), PRF-wrap
 * the secret key for the passkey paths, then lock. The WebAuthn ceremony
 * (the browser boundary) is stubbed to return the PRF output. `onUnlockPost`
 * runs (and is awaited) with each /api/vault/unlock POST's authHash before it
 * is answered.
 * Callers restore the spies (vi.restoreAllMocks) and clear the PRF hand-off.
 */
async function setUpThenLock(onUnlockPost?: (authHash: string) => void | Promise<void>) {
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
    if (url === "/api/vault/unlock" && init?.method === "POST") {
      await onUnlockPost?.(JSON.parse(init.body as string).authHash);
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
  return { result: hook.result, rerender: hook.rerender, generated, prfData };
}

const UNLOCKS = {
  unlock: (vault: ReturnType<typeof useVault>) => vault.unlock(PASSPHRASE),
  unlockWithPasskey: (vault: ReturnType<typeof useVault>) => vault.unlockWithPasskey(),
  unlockWithStoredPrf: (vault: ReturnType<typeof useVault>) => vault.unlockWithStoredPrf(),
};

describe("VaultProvider — the unlock paths zeroize the decrypted ECDH private key (S4-3)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearPrf();
  });

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
  afterEach(() => {
    vi.restoreAllMocks();
    clearPrf();
  });

  it.each(Object.keys(UNLOCKS) as (keyof typeof UNLOCKS)[])(
    "%s reports an interruption, not a failed attempt, and leaves the vault locked when the page is hidden during the unlock POST",
    async (path) => {
      const unlockPosts: string[] = [];
      const { result, prfData } = await setUpThenLock((authHash) => {
        unlockPosts.push(authHash);
        if (unlockPosts.length === 1) window.dispatchEvent(new Event("pagehide"));
      });
      stashPrf({ prfOutput: new Uint8Array(PRF_BYTES), prfData });

      let ok: boolean | undefined;
      let caught: unknown;
      await act(async () => {
        try {
          ok = await UNLOCKS[path](result.current);
        } catch (e) {
          caught = e;
        }
      });

      expect(ok).toBeUndefined();
      expect(caught).toBeInstanceOf(VaultUnlockError);
      expect((caught as VaultUnlockError).code).toBe(VAULT_UNLOCK_INTERRUPTED);
      // Only the real unlock POST: no dummy-hash failure report (notifyUnlockFailure)
      // counting toward the server's lockout.
      expect(unlockPosts).toHaveLength(1);
      expect(unlockPosts[0]).not.toBe("0".repeat(64));
      expect(result.current.status).toBe(VAULT_STATUS.LOCKED);
      expect(result.current.encryptionKey).toBeNull();
      expect(result.current.getSecretKey()).toBeNull();
      expect(result.current.getEcdhPrivateKeyBytes()).toBeNull();
    },
    60_000,
  );

  // An ended session needs a sign-in (UNAUTHORIZED → the lock screen's
  // session-expired path), not "try again" against a dead session.
  it.each(Object.keys(UNLOCKS) as (keyof typeof UNLOCKS)[])(
    "%s reports an expired session, installing nothing, when the session ends during the unlock POST",
    async (path) => {
      const reached = deferred();
      const gate = deferred();
      const unlockPosts: string[] = [];
      const { result, rerender, prfData } = await setUpThenLock(async (authHash) => {
        unlockPosts.push(authHash);
        reached.resolve();
        await gate.promise;
      });
      stashPrf({ prfOutput: new Uint8Array(PRF_BYTES), prfData });
      const epochBefore = result.current.getLockEpoch();

      let settled!: Promise<{ ok?: boolean; caught?: unknown }>;
      act(() => {
        settled = UNLOCKS[path](result.current).then(
          (ok) => ({ ok }),
          (caught: unknown) => ({ caught }),
        );
      });
      await act(async () => {
        await reached.promise;
      });
      mockUseSession.mockReturnValue({ data: null, status: "unauthenticated", update: vi.fn() });
      rerender();
      gate.resolve();
      let settledWith: { ok?: boolean; caught?: unknown } = {};
      await act(async () => {
        settledWith = await settled;
      });

      expect(settledWith.ok).toBeUndefined();
      expect(settledWith.caught).toBeInstanceOf(VaultUnlockError);
      expect((settledWith.caught as VaultUnlockError).code).toBe("UNAUTHORIZED");
      expect(unlockPosts).toHaveLength(1);
      expect(result.current.status).toBe(VAULT_STATUS.LOCKED);
      expect(result.current.encryptionKey).toBeNull();
      expect(result.current.getSecretKey()).toBeNull();
      expect(result.current.getEcdhPrivateKeyBytes()).toBeNull();
      // Nothing was held when the session ended, and the epoch still moved:
      // a session that arrives next must not let this unlock install.
      expect(result.current.getLockEpoch()).toBeGreaterThan(epochBefore);
    },
    60_000,
  );

  // F9-2: the POST committed for this user, so the setup resolves with the
  // vault LOCKED for an unlock with the passphrase just entered, rather than
  // reporting an interrupted unlock for a vault that now exists.
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
      await expect(result.current.setup(PASSPHRASE)).resolves.toBeUndefined();
    });
    expect(result.current.status).toBe(VAULT_STATUS.LOCKED);
    expect(result.current.encryptionKey).toBeNull();
    expect(result.current.getSecretKey()).toBeNull();
  }, 60_000);

  // An ended session needs a new sign-in, as for the unlock paths; after a
  // page hide (above) setup resolves with the vault left LOCKED.
  it("setup throws UNAUTHORIZED and installs nothing when the session ends during the setup POST", async () => {
    const { fetchMock } = makeFetchEnv(null);
    const baseHandler = fetchMock.getMockImplementation();
    const reached = deferred();
    const gate = deferred();
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (!baseHandler) throw new Error("fetch env has no base handler");
      if (url === "/api/vault/setup") {
        reached.resolve();
        await gate.promise;
      }
      return baseHandler(url, init);
    }) as unknown as typeof fetch;
    const { result, rerender } = renderHook(() => useVault(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED));

    let settled!: Promise<void>;
    act(() => {
      settled = result.current.setup(PASSPHRASE);
    });
    await act(async () => {
      await reached.promise;
    });
    mockUseSession.mockReturnValue({ data: null, status: "unauthenticated", update: vi.fn() });
    rerender();
    gate.resolve();

    await act(async () => {
      await expect(settled).rejects.toMatchObject({ code: API_ERROR.UNAUTHORIZED });
    });
    expect(result.current.status).toBe(VAULT_STATUS.LOCKED);
    expect(result.current.encryptionKey).toBeNull();
    expect(result.current.getSecretKey()).toBeNull();
  }, 60_000);
});

describe("VaultProvider — a lock zeroes the key buffers it drops, and the flows zero their working copies", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const EMPTY_ROTATION_DATA = {
    entries: [],
    historyEntries: [],
    mode2Attachments: [],
    mode0Attachments: [],
    mode0AttachmentsOverflow: false,
  };

  /** An unlocked vault whose rotate-key POST gets `response`. */
  async function setUpWithRotation(response: MockFetchResponse) {
    const { fetchMock } = makeFetchEnv(null);
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === "/api/vault/rotate-key/data") return { ok: true, json: async () => EMPTY_ROTATION_DATA };
      if (url === "/api/vault/rotate-key" && init?.method === "POST") return response;
      return fetchMock(url, init);
    }) as unknown as typeof fetch;
    const hook = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await hook.result.current.setup(PASSPHRASE);
    });
    return hook.result;
  }

  const REFUSED: MockFetchResponse = { ok: false, status: 429, json: async () => ({ error: "RATE_LIMIT_EXCEEDED" }) };
  const COMMITTED: MockFetchResponse = {
    ok: true,
    json: async () => ({ success: true, keyVersion: 2, rotationEffects: null }),
  };

  async function rotateIgnoringRefusal(result: { current: ReturnType<typeof useVault> }) {
    await act(async () => {
      await result.current.rotateKey(PASSPHRASE).catch(() => undefined);
    });
  }

  function sameBytes(a: Uint8Array, b: Uint8Array | null): boolean {
    return b !== null && a.length === b.length && a.every((v, i) => v === b[i]);
  }

  const LOCKS = {
    "lock()": (vault: ReturnType<typeof useVault>) => vault.lock(),
    pagehide: () => window.dispatchEvent(new Event("pagehide")),
  };

  it.each(Object.keys(LOCKS) as (keyof typeof LOCKS)[])(
    "%s zeroes the secret key buffer the provider held",
    async (how) => {
      const result = await setUpWithRotation(REFUSED);
      // A refused rotation leaves the vault unlocked; its first auth-key
      // derivation reads the provider's own buffer.
      const inputs: Uint8Array[] = [];
      const actual = cryptoClient.deriveAuthKeyBytes;
      vi.spyOn(cryptoClient, "deriveAuthKeyBytes").mockImplementation(async (key) => {
        inputs.push(key);
        return actual(key);
      });
      await rotateIgnoringRefusal(result);
      const held = inputs[0];
      expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
      expect(held?.some((b) => b !== 0)).toBe(true);
      expect(sameBytes(held, result.current.getSecretKey())).toBe(true);

      act(() => {
        LOCKS[how](result.current);
      });

      expect(held.every((b) => b === 0)).toBe(true);
    },
    60_000,
  );

  it.each(Object.keys(LOCKS) as (keyof typeof LOCKS)[])(
    "%s zeroes the ECDH private key buffer the provider held",
    async (how) => {
      const result = await setUpWithRotation(REFUSED);
      const ecdh = result.current.getEcdhPrivateKeyBytes();
      if (!ecdh) throw new Error("setup left no ECDH private key");
      // The provider's buffer is reachable only as the receiver of the
      // rotation's `.slice()` of it: a pass-through spy on the typed-array
      // slice collects every argument-less receiver.
      const typedArrayProto = Object.getPrototypeOf(Uint8Array.prototype) as {
        slice: (this: Uint8Array, ...args: unknown[]) => Uint8Array;
      };
      const actualSlice = typedArrayProto.slice;
      const receivers: Uint8Array[] = [];
      const sliceSpy = vi.spyOn(typedArrayProto, "slice").mockImplementation(function (
        this: Uint8Array,
        ...args: unknown[]
      ) {
        if (args.length === 0) receivers.push(this);
        return actualSlice.apply(this, args);
      });
      await rotateIgnoringRefusal(result);
      sliceSpy.mockRestore();
      const held = receivers.filter((buffer) => sameBytes(buffer, ecdh));
      expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
      expect(held).toHaveLength(1);
      expect(held[0].some((b) => b !== 0)).toBe(true);

      act(() => {
        LOCKS[how](result.current);
      });

      expect(held[0].every((b) => b === 0)).toBe(true);
    },
    60_000,
  );

  /** Pass-through spy (crypto stays real) recording each encryptBinary input and its bytes at the call. */
  function captureEncryptedInputs() {
    const inputs: { buffer: ArrayBuffer; atCall: Uint8Array }[] = [];
    const actual = cryptoClient.encryptBinary;
    vi.spyOn(cryptoClient, "encryptBinary").mockImplementation(async (data, ...rest) => {
      inputs.push({ buffer: data, atCall: new Uint8Array(data.slice(0)) });
      return actual(data, ...rest);
    });
    return inputs;
  }

  it("setup zeroes the working copy of the ECDH private key it encrypted", async () => {
    const { fetchMock } = makeFetchEnv(null);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useVault(), { wrapper });
    const inputs = captureEncryptedInputs();

    await act(async () => {
      await result.current.setup(PASSPHRASE);
    });

    const ecdh = result.current.getEcdhPrivateKeyBytes();
    if (!ecdh) throw new Error("setup left no ECDH private key");
    const copies = inputs.filter((input) => sameBytes(input.atCall, ecdh));
    expect(copies).toHaveLength(1);
    expect(ecdh.some((b) => b !== 0)).toBe(true);
    expect(new Uint8Array(copies[0].buffer).every((b) => b === 0)).toBe(true);
  }, 60_000);

  it("rotateKey zeroes the working copy of the ECDH private key it re-encrypted", async () => {
    const result = await setUpWithRotation(COMMITTED);
    const ecdh = result.current.getEcdhPrivateKeyBytes();
    if (!ecdh) throw new Error("setup left no ECDH private key");
    const inputs = captureEncryptedInputs();

    await rotateIgnoringRefusal(result);

    expect(result.current.getKeyVersion()).toBe(2);
    const copies = inputs.filter((input) => sameBytes(input.atCall, ecdh));
    expect(copies).toHaveLength(1);
    expect(new Uint8Array(copies[0].buffer).every((b) => b === 0)).toBe(true);
    // The provider's own key is untouched by zeroing the copy.
    expect(sameBytes(ecdh, result.current.getEcdhPrivateKeyBytes())).toBe(true);
  }, 60_000);
});

describe("VaultProvider — session changes and vault status races", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearPrf();
  });

  type SessionValue = { data: { user: { id: string; email: string } } | null; status: string; update: Mock };
  const sessionOf = (id: string): SessionValue => ({
    data: { user: { id, email: `${id}@example.com` } },
    status: "authenticated",
    update: vi.fn(),
  });
  const signedOut = (): SessionValue => ({ data: null, status: "unauthenticated", update: vi.fn() });
  const refetching = (): SessionValue => ({ data: null, status: "loading", update: vi.fn() });

  /** Re-render under `value`, then let the status check it starts settle. */
  async function sessionBecomes(rerender: () => void, value: SessionValue) {
    mockUseSession.mockReturnValue(value);
    rerender();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  const statusBody = (setupRequired: boolean) => ({ setupRequired, hasRecoveryKey: false, vaultAutoLockMinutes: null });

  /**
   * Wrap the current fetch. Every vault status request is counted; the next
   * one is held while `hold` is set and then answers `hold.setupRequired`;
   * otherwise `answer` (when set) is the server's verdict ("error": a 500),
   * or the request passes through.
   */
  function interceptStatus() {
    const inner = globalThis.fetch;
    const ctl: {
      requests: number;
      answer: boolean | "error" | null;
      hold: { reached: ReturnType<typeof deferred>; gate: ReturnType<typeof deferred>; setupRequired: boolean } | null;
    } = { requests: 0, answer: null, hold: null };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === "/api/vault/status") {
        ctl.requests += 1;
        const held = ctl.hold;
        if (held) {
          ctl.hold = null;
          held.reached.resolve();
          await held.gate.promise;
          return { ok: true, json: async () => statusBody(held.setupRequired) };
        }
        const answer = ctl.answer;
        if (answer === "error") return { ok: false, status: 500, json: async () => ({}) };
        if (answer !== null) return { ok: true, json: async () => statusBody(answer) };
      }
      return inner(url, init);
    }) as unknown as typeof fetch;
    return ctl;
  }

  /** Start `path` with its unlock POST held until `gate` resolves. */
  async function unlockHeldAtPost(path: keyof typeof UNLOCKS) {
    const reached = deferred();
    const gate = deferred();
    const hook = await setUpThenLock(async () => {
      reached.resolve();
      await gate.promise;
    });
    stashPrf({ prfOutput: new Uint8Array(PRF_BYTES), prfData: hook.prfData });
    let settled!: Promise<{ ok?: boolean; caught?: unknown }>;
    act(() => {
      settled = UNLOCKS[path](hook.result.current).then(
        (ok) => ({ ok }),
        (caught: unknown) => ({ caught }),
      );
    });
    await act(async () => {
      await reached.promise;
    });
    const finish = async () => {
      gate.resolve();
      let settledWith: { ok?: boolean; caught?: unknown } = {};
      await act(async () => {
        settledWith = await settled;
      });
      return settledWith;
    };
    return { ...hook, finish };
  }

  // ── S7-7: a user switch out of SETUP_REQUIRED ──────────────────

  /**
   * A provider whose user-1 server holds no vault, settled in SETUP_REQUIRED,
   * with every status (re-)render recorded and the next status request held.
   */
  async function settledInSetupRequired() {
    const { fetchMock } = makeFetchEnv(null);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const seen: string[] = [];
    const { result, rerender } = renderHook(() => {
      const vault = useVault();
      seen.push(vault.status);
      return vault;
    }, { wrapper });
    await waitFor(() => expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED));
    const ctl = interceptStatus();
    const hold = { reached: deferred(), gate: deferred(), setupRequired: false };
    ctl.hold = hold;
    seen.length = 0;
    return { result, rerender, seen, hold };
  }

  it("does not render the previous user's setup wizard after a switch while the new user's status is pending", async () => {
    const { result, rerender, seen, hold } = await settledInSetupRequired();

    await sessionBecomes(rerender, sessionOf("user-2"));
    await act(async () => {
      await hold.reached.promise;
    });

    expect(result.current.status).toBe(VAULT_STATUS.LOADING);
    expect(seen).not.toContain(VAULT_STATUS.SETUP_REQUIRED);
    hold.gate.resolve();
    await waitFor(() => expect(result.current.status).toBe(VAULT_STATUS.LOCKED));
  }, 30_000);

  it("keeps SETUP_REQUIRED through a same-user session refetch", async () => {
    const { result, rerender, seen, hold } = await settledInSetupRequired();
    hold.setupRequired = true;

    await sessionBecomes(rerender, sessionOf("user-1"));
    await act(async () => {
      await hold.reached.promise;
    });

    expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED);
    expect(seen).not.toContain(VAULT_STATUS.LOADING);
    hold.gate.resolve();
  }, 30_000);

  // ── S6-1: a user switch ─────────────────────────────────────────

  it("drops the key material, leaves UNLOCKED and moves the lock epoch when the session switches to another user", async () => {
    const { fetchMock } = makeFetchEnv(null);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { result, rerender } = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await result.current.setup(PASSPHRASE);
    });
    const epochBefore = result.current.getLockEpoch();

    mockUseSession.mockReturnValue(sessionOf("user-2"));
    rerender();

    expect(result.current.status).toBe(VAULT_STATUS.LOCKED);
    expect(result.current.encryptionKey).toBeNull();
    expect(result.current.getSecretKey()).toBeNull();
    expect(result.current.getEcdhPrivateKeyBytes()).toBeNull();
    expect(result.current.getLockEpoch()).toBeGreaterThan(epochBefore);
  }, 60_000);

  it("keeps the vault unlocked and the lock epoch unmoved across a same-user session refetch", async () => {
    const { fetchMock } = makeFetchEnv(null);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { result, rerender } = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await result.current.setup(PASSPHRASE);
    });
    const epochBefore = result.current.getLockEpoch();

    await sessionBecomes(rerender, sessionOf("user-1"));

    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
    expect(result.current.encryptionKey).not.toBeNull();
    expect(result.current.getSecretKey()?.some((b) => b !== 0)).toBe(true);
    expect(result.current.getLockEpoch()).toBe(epochBefore);
  }, 60_000);

  // A focus refetch must not refuse an unlock in flight.
  it.each([
    ["a same-user refetch", () => [sessionOf("user-1")]],
    ["a refetch that briefly carries no user", () => [refetching(), sessionOf("user-1")]],
  ] as const)("lets an unlock in flight install across %s", async (_kind, sessions) => {
    const { result, rerender, finish } = await unlockHeldAtPost("unlock");
    const epochBefore = result.current.getLockEpoch();
    for (const value of sessions()) await sessionBecomes(rerender, value);

    const settledWith = await finish();

    expect(settledWith.caught).toBeUndefined();
    expect(settledWith.ok).toBe(true);
    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
    expect(result.current.getSecretKey()?.some((b) => b !== 0)).toBe(true);
    expect(result.current.getLockEpoch()).toBe(epochBefore);
  }, 60_000);

  it.each(Object.keys(UNLOCKS) as (keyof typeof UNLOCKS)[])(
    "%s installs nothing when the session switches to another user during the unlock POST",
    async (path) => {
      const { result, rerender, finish } = await unlockHeldAtPost(path);
      await sessionBecomes(rerender, sessionOf("user-2"));

      const settledWith = await finish();

      expect(settledWith.ok).toBeUndefined();
      expect(settledWith.caught).toBeInstanceOf(VaultUnlockError);
      expect((settledWith.caught as VaultUnlockError).code).toBe(VAULT_UNLOCK_INTERRUPTED);
      expect(result.current.status).toBe(VAULT_STATUS.LOCKED);
      expect(result.current.encryptionKey).toBeNull();
      expect(result.current.getSecretKey()).toBeNull();
    },
    60_000,
  );

  // The session ended with no key held, then another user's session arrived:
  // a level check sees an authenticated session again at install time.
  it.each(Object.keys(UNLOCKS) as (keyof typeof UNLOCKS)[])(
    "%s installs nothing when the session ends and another user's session arrives during the unlock POST",
    async (path) => {
      const { result, rerender, finish } = await unlockHeldAtPost(path);
      await sessionBecomes(rerender, signedOut());
      await sessionBecomes(rerender, sessionOf("user-2"));

      const settledWith = await finish();

      expect(settledWith.ok).toBeUndefined();
      expect(settledWith.caught).toBeInstanceOf(VaultUnlockError);
      expect(result.current.status).toBe(VAULT_STATUS.LOCKED);
      expect(result.current.encryptionKey).toBeNull();
      expect(result.current.getSecretKey()).toBeNull();
    },
    60_000,
  );

  it("refuses an unlock started after the session ended, with UNAUTHORIZED", async () => {
    const { result, rerender } = await setUpThenLock();
    await sessionBecomes(rerender, signedOut());

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.unlock(PASSPHRASE);
      } catch (e) {
        caught = e;
      }
    });

    expect(caught).toBeInstanceOf(VaultUnlockError);
    expect((caught as VaultUnlockError).code).toBe(API_ERROR.UNAUTHORIZED);
    expect(result.current.status).toBe(VAULT_STATUS.LOCKED);
    expect(result.current.getSecretKey()).toBeNull();
  }, 60_000);

  // ── T6-1: the session-change effect runs in the commit ─────────

  // next-auth updates its session from an async fetch: a default-priority
  // update, whose passive effects run in a task after the commit. An unlock
  // whose last await resolves in between must already see the ended session.
  it("refuses an unlock whose POST resolves in the commit that ends the session, before passive effects run", async () => {
    const listeners = new Set<(value: SessionValue) => void>();
    let current: SessionValue = sessionOf("user-1");
    mockUseSession.mockImplementation(function useStoreSession() {
      const [value, setValue] = useState(current);
      useEffect(() => {
        listeners.add(setValue);
        return () => {
          listeners.delete(setValue);
        };
      }, []);
      return value;
    });
    const { fetchMock } = makeFetchEnv(null);
    const baseHandler = fetchMock.getMockImplementation();
    const reached = deferred();
    const gate = deferred();
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (!baseHandler) throw new Error("fetch env has no base handler");
      if (url === "/api/vault/unlock/data") {
        // No ECDH key: the unlock reaches its install in microtasks once the
        // POST resolves, with no Web Crypto task in between.
        const res = await baseHandler(url, init);
        const body = (await res.json()) as Record<string, unknown>;
        const { encryptedEcdhPrivateKey: _k, ecdhPrivateKeyIv: _i, ecdhPrivateKeyAuthTag: _t, ...rest } = body;
        return { ok: true, json: async () => rest };
      }
      if (url === "/api/vault/unlock" && init?.method === "POST") {
        reached.resolve();
        await gate.promise;
      }
      return baseHandler(url, init);
    }) as unknown as typeof fetch;
    const { result } = renderHook(
      () => {
        const vault = useVault();
        // Resolves the held POST in the commit that ends the session; the
        // provider's layout effect runs in the same commit, after this one.
        useLayoutEffect(() => {
          if (vault.userId === null) gate.resolve();
        }, [vault.userId]);
        return vault;
      },
      { wrapper },
    );
    await act(async () => {
      await result.current.setup(PASSPHRASE);
    });
    act(() => {
      result.current.lock();
    });
    let settled!: Promise<{ ok?: boolean; caught?: unknown }>;
    act(() => {
      settled = result.current.unlock(PASSPHRASE).then(
        (ok) => ({ ok }),
        (caught: unknown) => ({ caught }),
      );
    });
    await act(async () => {
      await reached.promise;
    });

    // Outside act, so React schedules the render and its passive effects as
    // it does in the browser rather than flushing them together.
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const actEnvironment = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    let settledWith: { ok?: boolean; caught?: unknown } = {};
    try {
      current = signedOut();
      for (const listener of listeners) listener(current);
      settledWith = await settled;
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(settledWith.ok).toBeUndefined();
    expect(settledWith.caught).toBeInstanceOf(VaultUnlockError);
    expect((settledWith.caught as VaultUnlockError).code).toBe(API_ERROR.UNAUTHORIZED);
    expect(result.current.status).toBe(VAULT_STATUS.LOCKED);
    expect(result.current.getSecretKey()).toBeNull();
  }, 60_000);

  // ── F6-1: a status response from an ended session ──────────────

  it("ignores a status response that arrives after the session ended", async () => {
    const { fetchMock } = makeFetchEnv(null);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const ctl = interceptStatus();
    const held = { reached: deferred(), gate: deferred() };
    ctl.hold = { reached: held.reached, gate: held.gate, setupRequired: true };
    const { result, rerender } = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await held.reached.promise;
    });
    await sessionBecomes(rerender, signedOut());
    expect(result.current.status).toBe(VAULT_STATUS.LOCKED);

    held.gate.resolve();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.status).toBe(VAULT_STATUS.LOCKED);
  });

  // ── S6-2: a setup-required verdict across an unlock ────────────

  // The verdict was asked before the unlock installed: it may predate it, or
  // the vault may have been reset since. Asked again, the newest answer decides.
  it.each([
    ["requires setup and drops the keys when the re-check finds the vault reset", true, VAULT_STATUS.SETUP_REQUIRED],
    ["stays unlocked when the re-check finds the vault", null, VAULT_STATUS.UNLOCKED],
  ] as const)("re-asks a setup-required verdict that arrives after an unlock installed: %s", async (_kind, answer, expected) => {
    const { result, rerender } = await setUpThenLock();
    const ctl = interceptStatus();
    const held = { reached: deferred(), gate: deferred() };
    ctl.hold = { reached: held.reached, gate: held.gate, setupRequired: true };
    mockUseSession.mockReturnValue(sessionOf("user-1"));
    rerender();
    await act(async () => {
      await held.reached.promise;
    });
    await act(async () => {
      await result.current.unlock(PASSPHRASE);
    });
    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
    ctl.answer = answer;

    held.gate.resolve();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(ctl.requests).toBe(2);
    expect(result.current.status).toBe(expected);
    expect(result.current.getSecretKey() !== null).toBe(expected === VAULT_STATUS.UNLOCKED);
  }, 60_000);

  // The unlock's POST was accepted before the vault was reset; the reset
  // verdict was applied before the unlock installed.
  it.each(Object.keys(UNLOCKS) as (keyof typeof UNLOCKS)[])(
    "%s installs nothing into a vault a status check found reset while its POST was in flight",
    async (path) => {
      const { result, rerender, finish } = await unlockHeldAtPost(path);
      const ctl = interceptStatus();
      ctl.answer = true;
      await sessionBecomes(rerender, sessionOf("user-1"));
      expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED);

      const settledWith = await finish();

      expect(settledWith.ok).toBeUndefined();
      expect(settledWith.caught).toBeInstanceOf(VaultUnlockError);
      expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED);
      expect(result.current.encryptionKey).toBeNull();
      expect(result.current.getSecretKey()).toBeNull();
    },
    60_000,
  );

  it("lets an unlock install once a later status check finds the vault again", async () => {
    const { result, rerender } = await setUpThenLock();
    const ctl = interceptStatus();
    ctl.answer = true;
    await sessionBecomes(rerender, sessionOf("user-1"));
    expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED);
    ctl.answer = null;
    await sessionBecomes(rerender, sessionOf("user-1"));
    expect(result.current.status).toBe(VAULT_STATUS.LOCKED);

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.unlock(PASSPHRASE);
    });

    expect(ok).toBe(true);
    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
  }, 60_000);

  // What the server said about the previous user's vault is not about this one.
  it("lets another user's unlock install after the previous user's vault was found reset", async () => {
    const { result, rerender } = await setUpThenLock();
    const ctl = interceptStatus();
    ctl.answer = true;
    await sessionBecomes(rerender, sessionOf("user-1"));
    expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED);
    ctl.answer = "error";
    await sessionBecomes(rerender, sessionOf("user-2"));
    expect(result.current.status).toBe(VAULT_STATUS.LOCKED);

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.unlock(PASSPHRASE);
    });

    expect(ok).toBe(true);
    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
  }, 60_000);

  // ── T6-2: a refused unlock does not make a verdict stale ───────

  it("applies a setup-required verdict without re-asking when the only unlock since its request was refused", async () => {
    const { result, rerender } = await setUpThenLock(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    const ctl = interceptStatus();
    const held = { reached: deferred(), gate: deferred() };
    ctl.hold = { reached: held.reached, gate: held.gate, setupRequired: true };
    mockUseSession.mockReturnValue(sessionOf("user-1"));
    rerender();
    await act(async () => {
      await held.reached.promise;
    });
    await act(async () => {
      await expect(result.current.unlock(PASSPHRASE)).rejects.toMatchObject({ code: VAULT_UNLOCK_INTERRUPTED });
    });

    held.gate.resolve();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(ctl.requests).toBe(1);
    expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED);
  }, 60_000);

  // ── F6-4: setup refusals ───────────────────────────────────────

  function setupRefusedEnv(refusal: MockFetchResponse) {
    const { fetchMock } = makeFetchEnv(null);
    const baseHandler = fetchMock.getMockImplementation();
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (!baseHandler) throw new Error("fetch env has no base handler");
      const res = await baseHandler(url, init);
      // The server committed this setup (a lost 201 retried, or another tab).
      return url === "/api/vault/setup" ? refusal : res;
    }) as unknown as typeof fetch;
  }

  it("leaves the vault LOCKED for an unlock, without throwing, when setup finds it already set up", async () => {
    setupRefusedEnv({ ok: false, status: 409, json: async () => ({ error: API_ERROR.VAULT_ALREADY_SETUP }) });
    const { result } = renderHook(() => useVault(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED));

    await act(async () => {
      await result.current.setup(PASSPHRASE);
    });
    expect(result.current.status).toBe(VAULT_STATUS.LOCKED);
    expect(result.current.getSecretKey()).toBeNull();

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.unlock(PASSPHRASE);
    });
    expect(ok).toBe(true);
    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
  }, 60_000);

  it("throws UNAUTHORIZED and installs nothing when the setup POST is refused with 401", async () => {
    setupRefusedEnv({ ok: false, status: 401, json: async () => ({ error: API_ERROR.UNAUTHORIZED }) });
    const { result } = renderHook(() => useVault(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED));

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.setup(PASSPHRASE);
      } catch (e) {
        caught = e;
      }
    });

    expect(caught).toBeInstanceOf(VaultUnlockError);
    expect((caught as VaultUnlockError).code).toBe(API_ERROR.UNAUTHORIZED);
    expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED);
    expect(result.current.getSecretKey()).toBeNull();
  }, 60_000);

  // ── R7: setup is bound to the session and status it started under ──

  /**
   * Start setup with its POST held until `finish`. The base handler stores the
   * vault when the POST is released; `post`, when set, is what the POST then
   * answers instead. Vault status requests go through `ctl` (interceptStatus).
   */
  async function setupHeldAtPost(post?: MockFetchResponse) {
    const { fetchMock } = makeFetchEnv(null);
    const baseHandler = fetchMock.getMockImplementation();
    const reached = deferred();
    const gate = deferred();
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (!baseHandler) throw new Error("fetch env has no base handler");
      if (url === "/api/vault/setup") {
        reached.resolve();
        await gate.promise;
        const stored = await baseHandler(url, init);
        return post ?? stored;
      }
      return baseHandler(url, init);
    }) as unknown as typeof fetch;
    const hook = renderHook(() => useVault(), { wrapper });
    await waitFor(() => expect(hook.result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED));
    const ctl = interceptStatus();
    let settled!: Promise<{ caught?: unknown }>;
    act(() => {
      settled = hook.result.current.setup(PASSPHRASE).then(
        () => ({}),
        (caught: unknown) => ({ caught }),
      );
    });
    await act(async () => {
      await reached.promise;
    });
    const settle = async () => {
      let settledWith: { caught?: unknown } = {};
      await act(async () => {
        settledWith = await settled;
      });
      // Let a status check the setup asked for settle.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      return settledWith;
    };
    const finish = () => {
      gate.resolve();
      return settle();
    };
    return { ...hook, ctl, release: gate.resolve, settle, finish };
  }

  const ALREADY_SET_UP: MockFetchResponse = {
    ok: false,
    status: 409,
    json: async () => ({ error: API_ERROR.VAULT_ALREADY_SETUP }),
  };

  /**
   * Whether the provider still holds that the server reports no vault: an
   * unlock of the vault the (user-agnostic) mock server stores is then refused
   * at install, so it throws VAULT_UNLOCK_INTERRUPTED instead of unlocking.
   */
  async function expectSetupRequiredHeld(result: { current: ReturnType<typeof useVault> }) {
    await act(async () => {
      await expect(result.current.unlock(PASSPHRASE)).rejects.toMatchObject({ code: VAULT_UNLOCK_INTERRUPTED });
    });
    expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED);
    expect(result.current.getSecretKey()).toBeNull();
  }

  it.each([
    ["201", undefined],
    ["409 VAULT_ALREADY_SETUP", ALREADY_SET_UP],
  ] as const)(
    "a setup whose POST answers %s after the session switched to another user writes nothing into that user's SETUP_REQUIRED and asks the status again",
    async (_kind, post) => {
      const { result, rerender, ctl, finish } = await setupHeldAtPost(post);
      // user-2 has no vault.
      ctl.answer = true;
      await sessionBecomes(rerender, sessionOf("user-2"));
      expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED);
      const requestsBefore = ctl.requests;

      const settledWith = await finish();

      expect(settledWith.caught).toBeInstanceOf(VaultUnlockError);
      expect((settledWith.caught as VaultUnlockError).code).toBe(VAULT_UNLOCK_INTERRUPTED);
      expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED);
      expect(result.current.encryptionKey).toBeNull();
      expect(result.current.getSecretKey()).toBeNull();
      expect(result.current.getEcdhPrivateKeyBytes()).toBeNull();
      expect(ctl.requests).toBeGreaterThan(requestsBefore);
      await expectSetupRequiredHeld(result);
    },
    60_000,
  );

  // The vault is reset after the setup commits: the check made while the POST
  // was in flight, and the one the setup asks after it, both find no vault.
  it.each([
    ["201", undefined],
    ["409 VAULT_ALREADY_SETUP", ALREADY_SET_UP],
  ] as const)(
    "a setup whose POST answers %s does not erase a setup-required verdict that arrived while it was in flight",
    async (_kind, post) => {
      const { result, rerender, ctl, finish } = await setupHeldAtPost(post);
      ctl.answer = true;
      await sessionBecomes(rerender, sessionOf("user-1"));
      expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED);
      const requestsBefore = ctl.requests;

      const settledWith = await finish();

      expect(settledWith.caught).toBeInstanceOf(VaultUnlockError);
      expect((settledWith.caught as VaultUnlockError).code).toBe(VAULT_UNLOCK_INTERRUPTED);
      expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED);
      expect(result.current.encryptionKey).toBeNull();
      expect(result.current.getSecretKey()).toBeNull();
      expect(ctl.requests).toBeGreaterThan(requestsBefore);
      await expectSetupRequiredHeld(result);
    },
    60_000,
  );

  // The check made while the POST was in flight was answered before the setup
  // committed; the setup asks again after its response and finds the vault.
  it.each([
    ["201", undefined, VAULT_STATUS.UNLOCKED],
    ["409 VAULT_ALREADY_SETUP", ALREADY_SET_UP, VAULT_STATUS.LOCKED],
  ] as const)(
    "a setup whose POST answers %s still completes when a stale setup-required verdict arrived while it was in flight",
    async (_kind, post, expected) => {
      const { result, rerender, ctl, finish } = await setupHeldAtPost(post);
      ctl.answer = true;
      await sessionBecomes(rerender, sessionOf("user-1"));
      expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED);
      ctl.answer = null;
      const requestsBefore = ctl.requests;

      const settledWith = await finish();

      expect(settledWith.caught).toBeUndefined();
      expect(result.current.status).toBe(expected);
      expect(ctl.requests).toBe(requestsBefore + 1);
    },
    60_000,
  );

  // The setup's own re-ask finds the vault, but a further setup-required
  // verdict was applied while it was answered: that one is not ordered either.
  it("a setup writes nothing when another setup-required verdict arrives while its own status re-ask is answered", async () => {
    const { result, rerender, ctl, release, settle } = await setupHeldAtPost();
    ctl.answer = true;
    await sessionBecomes(rerender, sessionOf("user-1"));
    const reask = { reached: deferred(), gate: deferred() };
    ctl.hold = { reached: reask.reached, gate: reask.gate, setupRequired: false };
    release();
    // Bounded: a setup that asks nothing must fail here, not hold the act open.
    await act(async () => {
      await Promise.race([reask.reached.promise, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    });
    expect(ctl.hold).toBeNull();
    await sessionBecomes(rerender, sessionOf("user-1"));
    reask.gate.resolve();

    const settledWith = await settle();

    expect((settledWith.caught as VaultUnlockError).code).toBe(VAULT_UNLOCK_INTERRUPTED);
    expect(result.current.getSecretKey()).toBeNull();
    expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED);
  }, 60_000);

  it.each([
    ["201", undefined, VAULT_STATUS.UNLOCKED],
    ["409 VAULT_ALREADY_SETUP", ALREADY_SET_UP, VAULT_STATUS.LOCKED],
  ] as const)(
    "an uninterrupted setup whose POST answers %s completes without asking the status again",
    async (_kind, post, expected) => {
      const { result, ctl, finish } = await setupHeldAtPost(post);

      const settledWith = await finish();

      expect(settledWith.caught).toBeUndefined();
      expect(result.current.status).toBe(expected);
      expect(ctl.requests).toBe(0);
      if (expected === VAULT_STATUS.UNLOCKED) {
        expect(result.current.getSecretKey()?.some((b) => b !== 0)).toBe(true);
      } else {
        expect(result.current.getSecretKey()).toBeNull();
      }
    },
    60_000,
  );

  it("sends no setup POST under another user's session when the session switches while setup is preparing", async () => {
    const { fetchMock } = makeFetchEnv(null);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const reached = deferred();
    const gate = deferred();
    const actualGenerate = cryptoTeam.generateECDHKeyPair;
    vi.spyOn(cryptoTeam, "generateECDHKeyPair").mockImplementation(async () => {
      reached.resolve();
      await gate.promise;
      return actualGenerate();
    });
    const { result, rerender } = renderHook(() => useVault(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED));
    const ctl = interceptStatus();
    let settled!: Promise<{ caught?: unknown }>;
    act(() => {
      settled = result.current.setup(PASSPHRASE).then(
        () => ({}),
        (caught: unknown) => ({ caught }),
      );
    });
    await act(async () => {
      await reached.promise;
    });
    ctl.answer = true;
    await sessionBecomes(rerender, sessionOf("user-2"));

    gate.resolve();
    let settledWith: { caught?: unknown } = {};
    await act(async () => {
      settledWith = await settled;
    });

    expect((settledWith.caught as VaultUnlockError).code).toBe(VAULT_UNLOCK_INTERRUPTED);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/vault/setup")).toHaveLength(0);
    expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED);
  }, 60_000);

  /** Count every request from here on as "METHOD url". */
  function recordRequests() {
    const inner = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${url}`);
      return inner(url, init);
    }) as unknown as typeof fetch;
    return requests;
  }

  /** Hold the next call of `fn` (a pass-through spy) until the returned gate opens. */
  function holdNext<M extends Record<string, unknown>, K extends keyof M & string>(mod: M, fn: K) {
    const reached = deferred();
    const gate = deferred();
    const actual = mod[fn] as (...args: unknown[]) => Promise<unknown>;
    let held = false;
    vi.spyOn(mod as Record<string, (...args: unknown[]) => Promise<unknown>>, fn).mockImplementation(async (...args: unknown[]) => {
      if (!held) {
        held = true;
        reached.resolve();
        await gate.promise;
      }
      return actual(...args);
    });
    return { reached, gate };
  }

  it.each(Object.keys(UNLOCKS) as (keyof typeof UNLOCKS)[])(
    "%s sends no unlock POST under another user's session when the session switches while it derives the key",
    async (path) => {
      const { result, rerender, prfData } = await setUpThenLock();
      stashPrf({ prfOutput: new Uint8Array(PRF_BYTES), prfData });
      const { reached, gate } = holdNext(cryptoClient, "deriveEncryptionKey");
      const requests = recordRequests();
      let settled!: Promise<{ ok?: boolean; caught?: unknown }>;
      act(() => {
        settled = UNLOCKS[path](result.current).then(
          (ok) => ({ ok }),
          (caught: unknown) => ({ caught }),
        );
      });
      await act(async () => {
        await reached.promise;
      });
      await sessionBecomes(rerender, sessionOf("user-2"));

      gate.resolve();
      let settledWith: { ok?: boolean; caught?: unknown } = {};
      await act(async () => {
        settledWith = await settled;
      });

      expect((settledWith.caught as VaultUnlockError).code).toBe(VAULT_UNLOCK_INTERRUPTED);
      expect(requests).not.toContain("POST /api/vault/unlock");
      expect(result.current.getSecretKey()).toBeNull();
    },
    60_000,
  );

  it("unlockWithPasskey sends no verify POST under another user's session when the session switches during the ceremony", async () => {
    const { result, rerender } = await setUpThenLock();
    // setUpThenLock already stubs the ceremony; this stub holds it first.
    const reached = deferred();
    const gate = deferred();
    vi.spyOn(webauthnClient, "startPasskeyAuthentication").mockImplementation(async () => {
      reached.resolve();
      await gate.promise;
      return {
        responseJSON: { id: "cred-1" },
        prfOutput: new Uint8Array(PRF_BYTES),
      } as Awaited<ReturnType<typeof webauthnClient.startPasskeyAuthentication>>;
    });
    const requests = recordRequests();
    let settled!: Promise<{ ok?: boolean; caught?: unknown }>;
    act(() => {
      settled = result.current.unlockWithPasskey().then(
        (ok) => ({ ok }),
        (caught: unknown) => ({ caught }),
      );
    });
    await act(async () => {
      await reached.promise;
    });
    await sessionBecomes(rerender, sessionOf("user-2"));

    gate.resolve();
    let settledWith: { ok?: boolean; caught?: unknown } = {};
    await act(async () => {
      settledWith = await settled;
    });

    expect((settledWith.caught as VaultUnlockError).code).toBe(VAULT_UNLOCK_INTERRUPTED);
    expect(requests).not.toContain("POST /api/webauthn/authenticate/verify");
    expect(result.current.getSecretKey()).toBeNull();
  }, 60_000);

  it("unlock reports a wrong passphrase as a failed attempt when the session stays the same", async () => {
    const unlockPosts: string[] = [];
    const { result } = await setUpThenLock((authHash) => {
      unlockPosts.push(authHash);
    });

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.unlock("a wrong passphrase entirely");
    });

    expect(ok).toBe(false);
    expect(unlockPosts).toEqual(["0".repeat(64)]);
  }, 60_000);

  it("unlock reports no failed attempt under another user's session when the session switches while a wrong passphrase is derived", async () => {
    const { result, rerender } = await setUpThenLock();
    const { reached, gate } = holdNext(cryptoClient, "deriveWrappingKey");
    const requests = recordRequests();
    let settled!: Promise<{ ok?: boolean; caught?: unknown }>;
    act(() => {
      settled = result.current.unlock("a wrong passphrase entirely").then(
        (ok) => ({ ok }),
        (caught: unknown) => ({ caught }),
      );
    });
    await act(async () => {
      await reached.promise;
    });
    await sessionBecomes(rerender, sessionOf("user-2"));

    gate.resolve();
    let settledWith: { ok?: boolean; caught?: unknown } = {};
    await act(async () => {
      settledWith = await settled;
    });

    expect((settledWith.caught as VaultUnlockError).code).toBe(VAULT_UNLOCK_INTERRUPTED);
    expect(requests).not.toContain("POST /api/vault/unlock");
  }, 60_000);

  it("unlock reports no failed attempt under another user's session when the session switches while the verification artifact is checked", async () => {
    const { result, rerender } = await setUpThenLock();
    const reached = deferred();
    const gate = deferred();
    // The artifact does not verify: the second failure report site.
    vi.spyOn(cryptoClient, "verifyKey").mockImplementation(async () => {
      reached.resolve();
      await gate.promise;
      return false;
    });
    const requests = recordRequests();
    let settled!: Promise<{ ok?: boolean; caught?: unknown }>;
    act(() => {
      settled = result.current.unlock(PASSPHRASE).then(
        (ok) => ({ ok }),
        (caught: unknown) => ({ caught }),
      );
    });
    await act(async () => {
      await reached.promise;
    });
    await sessionBecomes(rerender, sessionOf("user-2"));

    gate.resolve();
    let settledWith: { ok?: boolean; caught?: unknown } = {};
    await act(async () => {
      settledWith = await settled;
    });

    expect((settledWith.caught as VaultUnlockError).code).toBe(VAULT_UNLOCK_INTERRUPTED);
    expect(requests).not.toContain("POST /api/vault/unlock");
  }, 60_000);

  // SessionChangedError: the proxy refused the request because the cookie no
  // longer belongs to the page's user. No attempt reached a route, so it is
  // never a wrong passphrase (false); any other transport failure still is.
  it.each(Object.keys(UNLOCKS) as (keyof typeof UNLOCKS)[])(
    "%s rethrows SessionChangedError when its unlock POST is refused for a changed session",
    async (path) => {
      const { result, prfData } = await setUpThenLock(() => {
        throw new SessionChangedError();
      });
      stashPrf({ prfOutput: new Uint8Array(PRF_BYTES), prfData });

      let settledWith: { ok?: boolean; caught?: unknown } = {};
      await act(async () => {
        settledWith = await UNLOCKS[path](result.current).then(
          (ok) => ({ ok }),
          (caught: unknown) => ({ caught }),
        );
      });

      expect(settledWith.caught).toBeInstanceOf(SessionChangedError);
      expect(result.current.getSecretKey()).toBeNull();
    },
    60_000,
  );

  it.each(Object.keys(UNLOCKS) as (keyof typeof UNLOCKS)[])(
    "%s still returns false when its unlock POST rejects in transit",
    async (path) => {
      const { result, prfData } = await setUpThenLock(() => {
        throw new TypeError("Failed to fetch");
      });
      stashPrf({ prfOutput: new Uint8Array(PRF_BYTES), prfData });

      let settledWith: { ok?: boolean; caught?: unknown } = {};
      await act(async () => {
        settledWith = await UNLOCKS[path](result.current).then(
          (ok) => ({ ok }),
          (caught: unknown) => ({ caught }),
        );
      });

      expect(settledWith).toEqual({ ok: false });
    },
    60_000,
  );

  it.each([
    ["a wrong passphrase", "a wrong passphrase entirely", false],
    ["an artifact that does not verify", PASSPHRASE, true],
  ] as const)(
    "unlock rethrows SessionChangedError when the failed-attempt report for %s is refused for a changed session",
    async (_kind, passphrase, artifactFails) => {
      const { result } = await setUpThenLock(() => {
        throw new SessionChangedError();
      });
      if (artifactFails) vi.spyOn(cryptoClient, "verifyKey").mockResolvedValue(false);

      let settledWith: { ok?: boolean; caught?: unknown } = {};
      await act(async () => {
        settledWith = await result.current.unlock(passphrase).then(
          (ok) => ({ ok }),
          (caught: unknown) => ({ caught }),
        );
      });

      expect(settledWith.caught).toBeInstanceOf(SessionChangedError);
    },
    60_000,
  );

  it("unlock still reports a wrong passphrase when the failed-attempt report rejects in transit", async () => {
    const { result } = await setUpThenLock(() => {
      throw new TypeError("Failed to fetch");
    });

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.unlock("a wrong passphrase entirely");
    });

    expect(ok).toBe(false);
  }, 60_000);

  // A same-user page hide during the derivation is no move: the attempt was
  // made under this user's session and counts toward their lockout.
  it.each([
    ["a wrong passphrase is derived", "deriveWrappingKey", "a wrong passphrase entirely"],
    ["the verification artifact is checked", "verifyKey", PASSPHRASE],
  ] as const)(
    "unlock still reports the failed attempt when the page is hidden, same user, while %s",
    async (_while, held, passphrase) => {
      const unlockPosts: string[] = [];
      const { result } = await setUpThenLock((authHash) => {
        unlockPosts.push(authHash);
      });
      const reached = deferred();
      const gate = deferred();
      if (held === "verifyKey") {
        vi.spyOn(cryptoClient, "verifyKey").mockImplementation(async () => {
          reached.resolve();
          await gate.promise;
          return false;
        });
      } else {
        const hold = holdNext(cryptoClient, "deriveWrappingKey");
        void hold.reached.promise.then(() => reached.resolve());
        void gate.promise.then(() => hold.gate.resolve());
      }
      let settled!: Promise<{ ok?: boolean; caught?: unknown }>;
      act(() => {
        settled = result.current.unlock(passphrase).then(
          (ok) => ({ ok }),
          (caught: unknown) => ({ caught }),
        );
      });
      await act(async () => {
        await reached.promise;
      });
      act(() => {
        window.dispatchEvent(new Event("pagehide"));
      });

      gate.resolve();
      let settledWith: { ok?: boolean; caught?: unknown } = {};
      await act(async () => {
        settledWith = await settled;
      });

      expect(settledWith).toEqual({ ok: false });
      expect(unlockPosts).toEqual(["0".repeat(64)]);
    },
    60_000,
  );

  // Another user signed in while the change was in flight and unlocked their
  // own vault: the change's unknown outcome is not theirs to lock.
  const unknownOutcome = (): MockFetchResponse => ({
    ok: false,
    status: 500,
    json: async () => ({ error: API_ERROR.INTERNAL_ERROR }),
  });
  const conflict = (error: string) => (): MockFetchResponse => ({ ok: false, status: 409, json: async () => ({ error }) });
  const inTransit = (): MockFetchResponse => {
    throw new TypeError("Failed to fetch");
  };
  it.each([
    ["changePassphrase", "an unknown outcome", "/api/vault/change-passphrase", unknownOutcome, VaultChangeOutcomeUnknownError],
    ["changePassphrase", "a POST lost in transit", "/api/vault/change-passphrase", inTransit, VaultChangeOutcomeUnknownError],
    ["changePassphrase", "a wrap moved elsewhere", "/api/vault/change-passphrase", conflict(API_ERROR.VAULT_WRAP_CONFLICT), VaultChangedElsewhereError],
    ["rotateKey", "an unknown outcome", "/api/vault/rotate-key", unknownOutcome, VaultChangeOutcomeUnknownError],
    ["rotateKey", "a POST lost in transit", "/api/vault/rotate-key", inTransit, VaultChangeOutcomeUnknownError],
    ["rotateKey", "a wrap moved elsewhere", "/api/vault/rotate-key", conflict(API_ERROR.KEY_VERSION_MISMATCH), VaultChangedElsewhereError],
  ] as const)(
    "%s does not lock another user's vault, nor revoke their delegations, on %s after a user switch",
    async (op, _kind, postPath, respond, expectedError) => {
      const { fetchMock } = makeFetchEnv(null);
      const reached = deferred();
      const gate = deferred();
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
        if (url === postPath && init?.method === "POST") {
          reached.resolve();
          await gate.promise;
          return respond();
        }
        return fetchMock(url, init);
      }) as unknown as typeof fetch;
      const { result, rerender } = renderHook(() => useVault(), { wrapper });
      await act(async () => {
        await result.current.setup(PASSPHRASE);
      });
      let settled!: Promise<{ caught?: unknown }>;
      act(() => {
        const started =
          op === "changePassphrase"
            ? result.current.changePassphrase(PASSPHRASE, "a different long passphrase")
            : result.current.rotateKey(PASSPHRASE);
        settled = started.then(
          () => ({}),
          (caught: unknown) => ({ caught }),
        );
      });
      await act(async () => {
        await reached.promise;
      });
      await sessionBecomes(rerender, sessionOf("user-2"));
      expect(result.current.status).toBe(VAULT_STATUS.LOCKED);
      await act(async () => {
        expect(await result.current.unlock(PASSPHRASE)).toBe(true);
      });
      const requests = recordRequests();

      gate.resolve();
      let settledWith: { caught?: unknown } = {};
      await act(async () => {
        settledWith = await settled;
      });

      expect(settledWith.caught).toBeInstanceOf(expectedError);
      expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
      expect(result.current.getSecretKey()?.some((b) => b !== 0)).toBe(true);
      expect(requests).not.toContain("DELETE /api/vault/delegation");
    },
    60_000,
  );

  // The id only arriving (undefined → defined) is the same session, as for the
  // session-change drop: the change's unknown outcome still locks.
  it("changePassphrase still locks on an unknown outcome when the session's user id arrives during the POST", async () => {
    mockUseSession.mockReturnValue({ data: { user: { email: "u@example.com" } }, status: "authenticated", update: vi.fn() });
    const { fetchMock } = makeFetchEnv(null);
    const reached = deferred();
    const gate = deferred();
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === "/api/vault/change-passphrase" && init?.method === "POST") {
        reached.resolve();
        await gate.promise;
        return unknownOutcome();
      }
      return fetchMock(url, init);
    }) as unknown as typeof fetch;
    const { result, rerender } = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await result.current.setup(PASSPHRASE);
    });
    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
    let settled!: Promise<{ caught?: unknown }>;
    act(() => {
      settled = result.current.changePassphrase(PASSPHRASE, "a different long passphrase").then(
        () => ({}),
        (caught: unknown) => ({ caught }),
      );
    });
    await act(async () => {
      await reached.promise;
    });
    await sessionBecomes(rerender, sessionOf("user-1"));
    expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
    const requests = recordRequests();

    gate.resolve();
    let settledWith: { caught?: unknown } = {};
    await act(async () => {
      settledWith = await settled;
    });

    expect(settledWith.caught).toBeInstanceOf(VaultChangeOutcomeUnknownError);
    expect(result.current.status).toBe(VAULT_STATUS.LOCKED);
    expect(requests).toContain("DELETE /api/vault/delegation");
  }, 60_000);
});
