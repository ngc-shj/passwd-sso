// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockDecryptData,
  mockBuildPersonalAAD,
  mockFetchApi,
  mockNotifyVault,
  mockBuildPersonalGetDetail,
  vaultState,
} =
  vi.hoisted(() => {
    // Mutable cell so individual tests can swap encryptionKey/userId without
    // breaking the module-scope vi.mock (which runs before imports).
    const vaultState = {
      encryptionKey: {} as CryptoKey | null,
      userId: "user-1" as string | null,
    };
    return {
      mockDecryptData: vi.fn(),
      mockBuildPersonalAAD: vi.fn(),
      mockFetchApi: vi.fn(),
      mockNotifyVault: vi.fn(),
      mockBuildPersonalGetDetail: vi.fn(),
      vaultState,
    };
  });

vi.mock("@/lib/crypto/crypto-client", () => ({
  decryptData: (...args: unknown[]) => mockDecryptData(...args),
}));
vi.mock("@/lib/crypto/crypto-aad", () => ({
  buildPersonalEntryAAD: (...args: unknown[]) => mockBuildPersonalAAD(...args),
  VAULT_TYPE: { BLOB: "blob", OVERVIEW: "overview" },
}));
vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetchApi(...args),
}));
vi.mock("@/lib/events", () => ({ notifyVaultDataChanged: mockNotifyVault }));
vi.mock("@/lib/vault/build-personal-get-detail", () => ({
  buildPersonalGetDetail: (...args: unknown[]) => mockBuildPersonalGetDetail(...args),
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    get encryptionKey() { return vaultState.encryptionKey; },
    get userId() { return vaultState.userId; },
  }),
}));
vi.mock("@/hooks/use-travel-mode", () => ({
  useTravelMode: () => ({ active: false }),
}));

import { renderHook } from "@testing-library/react";
import { decryptPersonalOverview, usePersonalVaultListAdapter } from "./personal-vault-list-adapter";
import type { DisplayEntry } from "@/types/display-entry";

const STABLE_KEY = {} as CryptoKey;

function rawEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "e1",
    entryType: "LOGIN",
    encryptedOverview: { ciphertext: "ct", iv: "iv", authTag: "tag" },
    aadVersion: 1,
    isFavorite: false,
    isArchived: false,
    requireReprompt: false,
    expiresAt: null,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-02",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// decryptPersonalOverview
// ---------------------------------------------------------------------------

describe("decryptPersonalOverview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildPersonalAAD.mockReturnValue(new Uint8Array([1, 2, 3]));
  });

  it("happy path: decrypts overview and maps all fields to DisplayEntry shape", async () => {
    const overviewPayload = {
      title: "GitHub",
      username: "alice",
      urlHost: "github.com",
      snippet: "some snippet",
      brand: null,
      lastFour: null,
      cardholderName: null,
      fullName: null,
      idNumberLast4: null,
      relyingPartyId: null,
      bankName: null,
      accountNumberLast4: null,
      softwareName: null,
      licensee: null,
      keyType: null,
      fingerprint: null,
      requireReprompt: false,
      travelSafe: true,
      tags: [{ id: "t1", name: "work", color: null }],
    };
    mockDecryptData.mockResolvedValue(JSON.stringify(overviewPayload));

    const result = await decryptPersonalOverview(rawEntry(), { encryptionKey: STABLE_KEY, userId: "user-1" });

    // INV-C5.2: single personal OVERVIEW AAD derivation site
    expect(mockBuildPersonalAAD).toHaveBeenCalledWith("user-1", "e1", "overview");

    expect(result.id).toBe("e1");
    expect(result.entryType).toBe("LOGIN");
    expect(result.title).toBe("GitHub");
    expect(result.username).toBe("alice");
    expect(result.urlHost).toBe("github.com");
    expect(result.snippet).toBe("some snippet");
    expect(result.isFavorite).toBe(false);
    expect(result.isArchived).toBe(false);
    expect(result.tags).toEqual([{ id: "t1", name: "work", color: null }]);
    expect(result.createdAt).toBe("2026-01-01");
    expect(result.updatedAt).toBe("2026-01-02");
    expect(result.expiresAt).toBeNull();
  });

  it("uses ENTRY_TYPE.LOGIN as default when entryType is missing from raw entry", async () => {
    mockDecryptData.mockResolvedValue(JSON.stringify({ title: "X", tags: [] }));

    const entry = rawEntry({ entryType: undefined });
    const result = await decryptPersonalOverview(entry, { encryptionKey: STABLE_KEY, userId: "user-1" });

    expect(result.entryType).toBe("LOGIN");
  });

  it("maps null/undefined optional fields to null in the output", async () => {
    mockDecryptData.mockResolvedValue(JSON.stringify({ title: "Min Entry", tags: [] }));

    const result = await decryptPersonalOverview(rawEntry(), { encryptionKey: STABLE_KEY, userId: "user-1" });

    expect(result.username).toBeNull();
    expect(result.urlHost).toBeNull();
    expect(result.snippet).toBeNull();
    expect(result.brand).toBeNull();
    expect(result.lastFour).toBeNull();
    expect(result.cardholderName).toBeNull();
    expect(result.fullName).toBeNull();
    expect(result.idNumberLast4).toBeNull();
    expect(result.relyingPartyId).toBeNull();
    expect(result.bankName).toBeNull();
    expect(result.accountNumberLast4).toBeNull();
    expect(result.softwareName).toBeNull();
    expect(result.licensee).toBeNull();
    expect(result.keyType).toBeNull();
    expect(result.fingerprint).toBeNull();
  });

  it("includes deletedAt only when present (trash rows — INV-C5.1)", async () => {
    mockDecryptData.mockResolvedValue(JSON.stringify({ title: "Trashed", tags: [] }));

    const trashed = await decryptPersonalOverview(
      rawEntry({ deletedAt: "2026-02-01T00:00:00Z" }),
      { encryptionKey: STABLE_KEY, userId: "user-1" },
    );
    expect(trashed.deletedAt).toBe("2026-02-01T00:00:00Z");

    const active = await decryptPersonalOverview(rawEntry(), { encryptionKey: STABLE_KEY, userId: "user-1" });
    expect("deletedAt" in active).toBe(false);
  });

  it("defaults travelSafe to true when not set in overview", async () => {
    // overview without travelSafe field → defaults to true
    mockDecryptData.mockResolvedValue(JSON.stringify({ title: "NoTravelFlag", tags: [] }));

    const result = await decryptPersonalOverview(rawEntry(), { encryptionKey: STABLE_KEY, userId: "user-1" });

    expect(result.travelSafe).toBe(true);
  });

  it("preserves travelSafe:false when explicitly set", async () => {
    mockDecryptData.mockResolvedValue(JSON.stringify({ title: "Unsafe", tags: [], travelSafe: false }));

    const result = await decryptPersonalOverview(rawEntry(), { encryptionKey: STABLE_KEY, userId: "user-1" });

    expect(result.travelSafe).toBe(false);
  });

  it("uses empty array for tags when overview.tags is missing", async () => {
    // tags field absent → should default to []
    mockDecryptData.mockResolvedValue(JSON.stringify({ title: "No Tags" }));

    const result = await decryptPersonalOverview(rawEntry(), { encryptionKey: STABLE_KEY, userId: "user-1" });

    expect(result.tags).toEqual([]);
  });

  it("skips AAD derivation (passes undefined) when aadVersion < 1", async () => {
    mockDecryptData.mockResolvedValue(JSON.stringify({ title: "LegacyEntry", tags: [] }));

    await decryptPersonalOverview(rawEntry({ aadVersion: 0 }), { encryptionKey: STABLE_KEY, userId: "user-1" });

    expect(mockBuildPersonalAAD).not.toHaveBeenCalled();
    // decryptData called with undefined aad
    expect(mockDecryptData).toHaveBeenCalledWith(
      expect.anything(),
      STABLE_KEY,
      undefined,
    );
  });

  it("skips AAD derivation when userId is null", async () => {
    mockDecryptData.mockResolvedValue(JSON.stringify({ title: "NoUser", tags: [] }));

    await decryptPersonalOverview(rawEntry({ aadVersion: 1 }), { encryptionKey: STABLE_KEY, userId: null });

    expect(mockBuildPersonalAAD).not.toHaveBeenCalled();
    expect(mockDecryptData).toHaveBeenCalledWith(
      expect.anything(),
      STABLE_KEY,
      undefined,
    );
  });

  it("throws on decrypt failure (F6 — personal policy: skip in caller, not here)", async () => {
    mockDecryptData.mockRejectedValue(new Error("bad auth tag"));

    await expect(
      decryptPersonalOverview(rawEntry(), { encryptionKey: STABLE_KEY, userId: "user-1" }),
    ).rejects.toThrow("bad auth tag");
  });
});

// ---------------------------------------------------------------------------
// usePersonalVaultListAdapter
// ---------------------------------------------------------------------------

describe("usePersonalVaultListAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchApi.mockResolvedValue({ ok: true, json: async () => [] });
    mockBuildPersonalAAD.mockReturnValue(new Uint8Array([1, 2, 3]));
  });

  it("returns kind:personal, supportsFavorite:true, and personal bulkScope", () => {
    const { result } = renderHook(() => usePersonalVaultListAdapter());

    expect(result.current.kind).toBe("personal");
    expect(result.current.teamId).toBeUndefined();
    expect(result.current.supportsFavorite).toBe(true);
    expect(result.current.bulkScope("normal")).toEqual({ type: "personal" });
  });

  it("returns all permissions as true (owner-only personal vault)", () => {
    const { result } = renderHook(() => usePersonalVaultListAdapter());

    expect(result.current.permissions).toEqual({
      canCreate: true,
      canEdit: true,
      canDelete: true,
      canShare: true,
    });
  });

  it("reports availability.ready:true when encryptionKey is present", () => {
    const { result } = renderHook(() => usePersonalVaultListAdapter());

    expect(result.current.availability.ready).toBe(true);
    expect(result.current.availability.reason).toBe("locked");
  });

  it("reports availability.ready:false when encryptionKey is null", () => {
    vaultState.encryptionKey = null;

    const { result } = renderHook(() => usePersonalVaultListAdapter());

    expect(result.current.availability.ready).toBe(false);

    vaultState.encryptionKey = STABLE_KEY;
  });

  it("builds the personal list URL per view + query (favorites/archive/trash/tag/folder/type)", async () => {
    const { result } = renderHook(() => usePersonalVaultListAdapter());
    const signal = new AbortController().signal;

    await result.current.fetchOverviewEntries("favorites", {}, signal);
    await result.current.fetchOverviewEntries("archive", {}, signal);
    await result.current.fetchOverviewEntries("trash", {}, signal);
    await result.current.fetchOverviewEntries(
      "normal",
      { tagId: "tg1", folderId: "fd1", entryType: "LOGIN" },
      signal,
    );

    const urls = mockFetchApi.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toBe("/api/passwords?favorites=true");
    expect(urls[1]).toBe("/api/passwords?archived=true");
    expect(urls[2]).toBe("/api/passwords?trash=true");
    expect(urls[3]).toBe("/api/passwords?tag=tg1&folder=fd1&type=LOGIN");
  });

  it("returns [] without fetching when encryptionKey is null", async () => {
    vaultState.encryptionKey = null;

    const { result } = renderHook(() => usePersonalVaultListAdapter());
    const out = await result.current.fetchOverviewEntries("normal", {}, new AbortController().signal);

    expect(out).toEqual([]);
    expect(mockFetchApi).not.toHaveBeenCalled();

    vaultState.encryptionKey = STABLE_KEY;
  });

  it("returns [] when the API response is not ok", async () => {
    mockFetchApi.mockResolvedValue({ ok: false });

    const { result } = renderHook(() => usePersonalVaultListAdapter());
    const out = await result.current.fetchOverviewEntries("normal", {}, new AbortController().signal);

    expect(out).toEqual([]);
  });

  it("skips entries without encryptedOverview", async () => {
    mockFetchApi.mockResolvedValue({
      ok: true,
      json: async () => [
        { id: "e1" }, // no encryptedOverview
        { id: "e2", encryptedOverview: "ct" },
      ],
    });
    mockDecryptData.mockResolvedValue(JSON.stringify({ title: "Entry2", tags: [] }));

    const { result } = renderHook(() => usePersonalVaultListAdapter());
    const out = await result.current.fetchOverviewEntries("normal", {}, new AbortController().signal);

    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("e2");
  });

  it("skips (does NOT throw) entries that fail to decrypt — F6 personal policy", async () => {
    mockFetchApi.mockResolvedValue({
      ok: true,
      json: async () => [
        rawEntry({ id: "bad", encryptedOverview: "bad-ct" }),
        rawEntry({ id: "good", encryptedOverview: "good-ct" }),
      ],
    });
    mockDecryptData
      .mockRejectedValueOnce(new Error("auth tag mismatch"))
      .mockResolvedValueOnce(JSON.stringify({ title: "Good Entry", tags: [] }));

    const { result } = renderHook(() => usePersonalVaultListAdapter());
    const out = await result.current.fetchOverviewEntries("normal", {}, new AbortController().signal);

    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("good");
  });

  it("returns empty list when server returns empty array", async () => {
    mockFetchApi.mockResolvedValue({ ok: true, json: async () => [] });

    const { result } = renderHook(() => usePersonalVaultListAdapter());
    const out = await result.current.fetchOverviewEntries("normal", {}, new AbortController().signal);

    expect(out).toEqual([]);
  });

  it("routes mutations to correct personal endpoints (network-only)", async () => {
    const { result } = renderHook(() => usePersonalVaultListAdapter());
    const entry = { id: "e1" } as DisplayEntry;

    await result.current.setFavorite(entry, true);
    await result.current.setArchived(entry, true);
    await result.current.softDelete(entry);
    await result.current.restore(entry);
    await result.current.deletePermanently(entry);
    await result.current.emptyTrash();

    const calls = mockFetchApi.mock.calls.map((c) => [c[0], (c[1] as RequestInit | undefined)?.method]);
    expect(calls).toEqual(
      expect.arrayContaining([
        ["/api/passwords/e1", "PUT"],      // setFavorite
        ["/api/passwords/e1", "PUT"],      // setArchived
        ["/api/passwords/e1", "DELETE"],   // softDelete
        ["/api/passwords/e1/restore", "POST"],
        ["/api/passwords/e1?permanent=true", "DELETE"],
        ["/api/passwords/empty-trash", "POST"],
      ]),
    );
  });

  it("throws when a mutation returns non-ok response", async () => {
    mockFetchApi.mockResolvedValue({ ok: false });

    const { result } = renderHook(() => usePersonalVaultListAdapter());
    const entry = { id: "e1" } as DisplayEntry;

    await expect(result.current.setFavorite(entry, true)).rejects.toThrow("setFavorite failed");
    await expect(result.current.softDelete(entry)).rejects.toThrow("softDelete failed");
    await expect(result.current.restore(entry)).rejects.toThrow("restore failed");
    await expect(result.current.deletePermanently(entry)).rejects.toThrow("deletePermanently failed");
    await expect(result.current.emptyTrash()).rejects.toThrow("emptyTrash failed");
  });

  it("notifyDataChanged calls notifyVaultDataChanged (personal event)", () => {
    const { result } = renderHook(() => usePersonalVaultListAdapter());

    result.current.notifyDataChanged();

    expect(mockNotifyVault).toHaveBeenCalledOnce();
  });

  it("buildGetDetail delegates to buildPersonalGetDetail when vault is unlocked", () => {
    const mockGetDetailFn = vi.fn().mockResolvedValue({});
    mockBuildPersonalGetDetail.mockReturnValue(mockGetDetailFn);

    const { result } = renderHook(() => usePersonalVaultListAdapter());
    const entry = { id: "e1" } as DisplayEntry;

    const getDetail = result.current.buildGetDetail(entry);

    expect(mockBuildPersonalGetDetail).toHaveBeenCalledWith(entry, { encryptionKey: vaultState.encryptionKey, userId: "user-1" });
    expect(typeof getDetail).toBe("function");
  });

  it("buildGetDetail returns error-throwing closure when vault is locked", async () => {
    vaultState.encryptionKey = null;

    const { result } = renderHook(() => usePersonalVaultListAdapter());
    const entry = { id: "e1" } as DisplayEntry;

    const getDetail = result.current.buildGetDetail(entry);
    await expect(getDetail()).rejects.toThrow("Vault locked");

    vaultState.encryptionKey = {} as CryptoKey;
  });
});
