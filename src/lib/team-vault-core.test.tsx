// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const {
  mockUnwrapTeamKey,
  mockDeriveTeamEncryptionKey,
  mockCreateTeamKeyEscrow,
  mockUnwrapItemKey,
  mockDeriveItemEncryptionKey,
} = vi.hoisted(() => ({
  mockUnwrapTeamKey: vi.fn(),
  mockDeriveTeamEncryptionKey: vi.fn(),
  mockCreateTeamKeyEscrow: vi.fn(),
  mockUnwrapItemKey: vi.fn(),
  mockDeriveItemEncryptionKey: vi.fn(),
}));

const { mockBuildItemKeyWrapAAD } = vi.hoisted(() => ({
  mockBuildItemKeyWrapAAD: vi.fn(),
}));

vi.mock("@/lib/crypto-team", () => ({
  unwrapTeamKey: (...args: unknown[]) => mockUnwrapTeamKey(...args),
  deriveTeamEncryptionKey: (...args: unknown[]) => mockDeriveTeamEncryptionKey(...args),
  createTeamKeyEscrow: (...args: unknown[]) => mockCreateTeamKeyEscrow(...args),
  unwrapItemKey: (...args: unknown[]) => mockUnwrapItemKey(...args),
  deriveItemEncryptionKey: (...args: unknown[]) => mockDeriveItemEncryptionKey(...args),
}));

vi.mock("@/lib/crypto-aad", () => ({
  buildItemKeyWrapAAD: (...args: unknown[]) => mockBuildItemKeyWrapAAD(...args),
}));

import {
  TeamVaultProvider,
  useTeamVault,
  useTeamVaultOptional,
} from "@/lib/team-vault-core";

describe("team-vault-core", () => {
  const originalCrypto = globalThis.crypto;
  const originalFetch = globalThis.fetch;
  const importKeyMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    Object.defineProperty(globalThis, "crypto", {
      value: {
        subtle: {
          importKey: importKeyMock,
        },
      },
      configurable: true,
    });
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    importKeyMock.mockResolvedValue({ type: "private" } as CryptoKey);
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(globalThis, "crypto", {
      value: originalCrypto,
      configurable: true,
    });
    globalThis.fetch = originalFetch;
  });

  function makeWrapper(options?: {
    getBytes?: () => Uint8Array | null;
    getUserId?: () => string | null;
    vaultUnlocked?: boolean;
  }) {
    return function Wrapper({ children }: { children: ReactNode }) {
      return (
        <TeamVaultProvider
          getEcdhPrivateKeyBytes={options?.getBytes ?? (() => new Uint8Array([1, 2, 3, 4]))}
          getUserId={options?.getUserId ?? (() => "user-1")}
          vaultUnlocked={options?.vaultUnlocked ?? false}
        >
          {children}
        </TeamVaultProvider>
      );
    };
  }

  it("throws outside provider and optional hook returns null", () => {
    expect(() => renderHook(() => useTeamVault())).toThrow(
      "useTeamVault must be used within a TeamVaultProvider",
    );

    const { result } = renderHook(() => useTeamVaultOptional());
    expect(result.current).toBeNull();
  });

  it("fetches, caches, invalidates, and clears team keys", async () => {
    const rawKeyBytes = new Uint8Array([9, 8, 7, 6]);
    const unwrappedKey = new Uint8Array([7, 7, 7, 7]);
    const encryptionKey = { type: "secret" } as CryptoKey;
    mockUnwrapTeamKey.mockResolvedValue(unwrappedKey);
    mockDeriveTeamEncryptionKey.mockResolvedValue(encryptionKey);

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        encryptedTeamKey: "cipher",
        teamKeyIv: "iv",
        teamKeyAuthTag: "tag",
        ephemeralPublicKey: "epk",
        hkdfSalt: "salt",
        keyVersion: 3,
        wrapVersion: 1,
      }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useTeamVault(), {
      wrapper: makeWrapper({ getBytes: () => rawKeyBytes }),
    });

    let key: CryptoKey | null = null;
    await act(async () => {
      key = await result.current.getTeamEncryptionKey("team-1");
    });

    expect(key).toBe(encryptionKey);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockUnwrapTeamKey).toHaveBeenCalledTimes(1);
    expect(mockDeriveTeamEncryptionKey).toHaveBeenCalledWith(unwrappedKey);
    expect(Array.from(rawKeyBytes)).toEqual([0, 0, 0, 0]);
    expect(Array.from(unwrappedKey)).toEqual([0, 0, 0, 0]);

    let keyInfo: Awaited<ReturnType<typeof result.current.getTeamKeyInfo>> | null = null;
    await act(async () => {
      keyInfo = await result.current.getTeamKeyInfo("team-1");
    });
    expect(keyInfo).toEqual({ key: encryptionKey, keyVersion: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.invalidateTeamKey("team-1");
      await result.current.getTeamEncryptionKey("team-1");
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      result.current.clearAll();
      await result.current.getTeamEncryptionKey("team-1");
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns null and logs a warning when member key fetch fails", async () => {
    const rawKeyBytes = new Uint8Array([1, 2, 3, 4]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: "forbidden" }),
    })) as unknown as typeof fetch;

    const { result } = renderHook(() => useTeamVault(), {
      wrapper: makeWrapper({ getBytes: () => rawKeyBytes }),
    });

    let key: CryptoKey | null = null;
    await act(async () => {
      key = await result.current.getTeamEncryptionKey("team-1");
    });

    expect(key).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      "[getTeamEncryptionKey] member-key request failed",
      expect.objectContaining({ teamId: "team-1", status: 403, error: "forbidden" }),
    );
    expect(Array.from(rawKeyBytes)).toEqual([0, 0, 0, 0]);
    warnSpy.mockRestore();
  });

  it("returns null and logs detailed errors for malformed responses", async () => {
    const rawKeyBytes = new Uint8Array([1, 2, 3, 4]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ encryptedTeamKey: "cipher" }),
    })) as unknown as typeof fetch;

    const { result } = renderHook(() => useTeamVault(), {
      wrapper: makeWrapper({ getBytes: () => rawKeyBytes }),
    });

    await act(async () => {
      await result.current.getTeamEncryptionKey("team-1");
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("stage=parse_member_key"),
    );
    expect(Array.from(rawKeyBytes)).toEqual([0, 0, 0, 0]);
    errorSpy.mockRestore();
  });

  describe("getItemEncryptionKey", () => {
    function setupTeamKeyMocks() {
      mockUnwrapTeamKey.mockResolvedValue(new Uint8Array([7, 7, 7, 7]));
      mockDeriveTeamEncryptionKey.mockResolvedValue({ type: "secret" } as CryptoKey);
    }

    function setupEntryFetch(overrides: Record<string, unknown> = {}) {
      const entryData = {
        itemKeyVersion: 1,
        encryptedItemKey: "enc-ik",
        itemKeyIv: "ik-iv",
        itemKeyAuthTag: "ik-tag",
        teamKeyVersion: 3,
        ...overrides,
      };
      return entryData;
    }

    function setupFetchMock(entryData: Record<string, unknown>) {
      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes("/passwords/entry-1")) {
          return { ok: true, json: async () => entryData };
        }
        // TeamMemberKey fetch for getTeamEncryptionKey
        return {
          ok: true,
          json: async () => ({
            encryptedTeamKey: "cipher",
            teamKeyIv: "iv",
            teamKeyAuthTag: "tag",
            ephemeralPublicKey: "epk",
            hkdfSalt: "salt",
            keyVersion: 3,
            wrapVersion: 1,
          }),
        };
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      return fetchMock;
    }

    it("fetches entry, unwraps ItemKey, derives encryption key, and caches", async () => {
      setupTeamKeyMocks();
      const rawItemKey = new Uint8Array([1, 2, 3, 4]);
      const itemEncKey = { type: "secret", usage: "item" } as unknown as CryptoKey;
      mockUnwrapItemKey.mockResolvedValue(rawItemKey);
      mockDeriveItemEncryptionKey.mockResolvedValue(itemEncKey);
      mockBuildItemKeyWrapAAD.mockReturnValue(new Uint8Array([99]));

      const entryData = setupEntryFetch();
      const fetchMock = setupFetchMock(entryData);

      const { result } = renderHook(() => useTeamVault(), {
        wrapper: makeWrapper(),
      });

      let key: CryptoKey | null = null;
      await act(async () => {
        key = await result.current.getItemEncryptionKey("team-1", "entry-1");
      });

      expect(key).toBe(itemEncKey);
      expect(mockBuildItemKeyWrapAAD).toHaveBeenCalledWith("team-1", "entry-1", 3);
      expect(mockUnwrapItemKey).toHaveBeenCalledWith(
        { ciphertext: "enc-ik", iv: "ik-iv", authTag: "ik-tag" },
        expect.anything(),
        new Uint8Array([99]),
      );
      expect(mockDeriveItemEncryptionKey).toHaveBeenCalledWith(rawItemKey);
      expect(Array.from(rawItemKey)).toEqual([0, 0, 0, 0]); // zeroed

      // Second call should use cache (no additional fetch)
      const entryFetchCount = fetchMock.mock.calls.filter(
        (c) => (c[0] as string).includes("/passwords/entry-1"),
      ).length;

      await act(async () => {
        key = await result.current.getItemEncryptionKey("team-1", "entry-1");
      });

      const entryFetchCountAfter = fetchMock.mock.calls.filter(
        (c) => (c[0] as string).includes("/passwords/entry-1"),
      ).length;
      expect(entryFetchCountAfter).toBe(entryFetchCount); // no new fetch
      expect(key).toBe(itemEncKey);
    });

    it("throws when itemKeyVersion < 1", async () => {
      setupTeamKeyMocks();
      const entryData = setupEntryFetch({ itemKeyVersion: 0 });
      setupFetchMock(entryData);

      const { result } = renderHook(() => useTeamVault(), {
        wrapper: makeWrapper(),
      });

      await expect(
        act(async () => {
          await result.current.getItemEncryptionKey("team-1", "entry-1");
        }),
      ).rejects.toThrow("Entry does not have ItemKey");
    });

    it("throws when entry fetch fails", async () => {
      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({}),
      })) as unknown as typeof fetch;

      const { result } = renderHook(() => useTeamVault(), {
        wrapper: makeWrapper(),
      });

      await expect(
        act(async () => {
          await result.current.getItemEncryptionKey("team-1", "entry-1");
        }),
      ).rejects.toThrow("Failed to fetch entry ItemKey data");
    });

    it("invalidateTeamKey clears ItemKey cache", async () => {
      setupTeamKeyMocks();
      const itemEncKey = { type: "secret", usage: "item" } as unknown as CryptoKey;
      mockUnwrapItemKey.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
      mockDeriveItemEncryptionKey.mockResolvedValue(itemEncKey);
      mockBuildItemKeyWrapAAD.mockReturnValue(new Uint8Array([99]));

      const entryData = setupEntryFetch();
      const fetchMock = setupFetchMock(entryData);

      const { result } = renderHook(() => useTeamVault(), {
        wrapper: makeWrapper(),
      });

      await act(async () => {
        await result.current.getItemEncryptionKey("team-1", "entry-1");
      });

      const fetchesBefore = fetchMock.mock.calls.filter(
        (c) => (c[0] as string).includes("/passwords/entry-1"),
      ).length;

      // Invalidate and re-fetch
      await act(async () => {
        result.current.invalidateTeamKey("team-1");
        mockUnwrapItemKey.mockResolvedValue(new Uint8Array([5, 6, 7, 8]));
        await result.current.getItemEncryptionKey("team-1", "entry-1");
      });

      const fetchesAfter = fetchMock.mock.calls.filter(
        (c) => (c[0] as string).includes("/passwords/entry-1"),
      ).length;
      expect(fetchesAfter).toBeGreaterThan(fetchesBefore);
    });

    it("clearAll clears ItemKey cache", async () => {
      setupTeamKeyMocks();
      const itemEncKey = { type: "secret", usage: "item" } as unknown as CryptoKey;
      mockUnwrapItemKey.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
      mockDeriveItemEncryptionKey.mockResolvedValue(itemEncKey);
      mockBuildItemKeyWrapAAD.mockReturnValue(new Uint8Array([99]));

      const entryData = setupEntryFetch();
      const fetchMock = setupFetchMock(entryData);

      const { result } = renderHook(() => useTeamVault(), {
        wrapper: makeWrapper(),
      });

      await act(async () => {
        await result.current.getItemEncryptionKey("team-1", "entry-1");
      });

      const fetchesBefore = fetchMock.mock.calls.filter(
        (c) => (c[0] as string).includes("/passwords/entry-1"),
      ).length;

      // Clear all and re-fetch
      await act(async () => {
        result.current.clearAll();
        mockUnwrapItemKey.mockResolvedValue(new Uint8Array([5, 6, 7, 8]));
        await result.current.getItemEncryptionKey("team-1", "entry-1");
      });

      const fetchesAfter = fetchMock.mock.calls.filter(
        (c) => (c[0] as string).includes("/passwords/entry-1"),
      ).length;
      expect(fetchesAfter).toBeGreaterThan(fetchesBefore);
    });
  });

  it("distributes pending keys on unlock, skips missing public keys, and cleans up listeners", async () => {
    const rawKeyBytes = new Uint8Array([5, 6, 7, 8]);
    const ownTeamKeyBytes = new Uint8Array([3, 3, 3, 3]);
    mockUnwrapTeamKey.mockResolvedValue(ownTeamKeyBytes);
    mockCreateTeamKeyEscrow.mockResolvedValue({
      encryptedTeamKey: "wrapped",
      teamKeyIv: "iv",
      teamKeyAuthTag: "tag",
      ephemeralPublicKey: "pub",
      hkdfSalt: "salt",
      keyVersion: 4,
      wrapVersion: 1,
    });

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/teams/pending-key-distributions") {
        return {
          ok: true,
          json: async () => [
            {
              memberId: "member-1",
              teamId: "team-1",
              userId: "user-2",
              ecdhPublicKey: "user-2-pub",
              teamKeyVersion: 4,
            },
            {
              memberId: "member-2",
              teamId: "team-1",
              userId: "user-3",
              ecdhPublicKey: null,
              teamKeyVersion: 4,
            },
          ],
        };
      }
      if (url === "/api/teams/team-1/member-key") {
        return {
          ok: true,
          json: async () => ({
            encryptedTeamKey: "cipher",
            teamKeyIv: "iv",
            teamKeyAuthTag: "tag",
            ephemeralPublicKey: "epk",
            hkdfSalt: "salt",
            keyVersion: 4,
            wrapVersion: 1,
          }),
        };
      }
      if (url === "/api/teams/team-1/members/member-1/confirm-key") {
        return {
          ok: true,
          json: async () => ({}),
        };
      }
      throw new Error(`unexpected url: ${url} ${init?.method ?? "GET"}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const addDocSpy = vi.spyOn(document, "addEventListener");
    const removeDocSpy = vi.spyOn(document, "removeEventListener");
    const addWinSpy = vi.spyOn(window, "addEventListener");
    const removeWinSpy = vi.spyOn(window, "removeEventListener");

    const { unmount } = renderHook(() => useTeamVault(), {
      wrapper: makeWrapper({ getBytes: () => rawKeyBytes, vaultUnlocked: true }),
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/teams/pending-key-distributions");
    expect(mockCreateTeamKeyEscrow).toHaveBeenCalledWith(
      ownTeamKeyBytes,
      "user-2-pub",
      "team-1",
      "user-2",
      4,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/teams/team-1/members/member-1/confirm-key",
      expect.objectContaining({ method: "POST" }),
    );
    expect(Array.from(rawKeyBytes)).toEqual([0, 0, 0, 0]);
    expect(Array.from(ownTeamKeyBytes)).toEqual([0, 0, 0, 0]);
    expect(addDocSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(addWinSpy).toHaveBeenCalledWith("online", expect.any(Function));

    unmount();

    expect(removeDocSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(removeWinSpy).toHaveBeenCalledWith("online", expect.any(Function));
  });
});
