// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDecryptData, mockBuildTeamAAD, mockFetchApi, mockGetTeamKey, mockGetEntryKey, mockNotifyTeam } =
  vi.hoisted(() => ({
    mockDecryptData: vi.fn(),
    mockBuildTeamAAD: vi.fn(),
    mockFetchApi: vi.fn(),
    mockGetTeamKey: vi.fn(),
    mockGetEntryKey: vi.fn(),
    mockNotifyTeam: vi.fn(),
  }));

vi.mock("@/lib/crypto/crypto-client", () => ({
  decryptData: (...args: unknown[]) => mockDecryptData(...args),
}));
vi.mock("@/lib/crypto/crypto-aad", () => ({
  buildTeamEntryAAD: (...args: unknown[]) => mockBuildTeamAAD(...args),
  VAULT_TYPE: { BLOB: "blob", OVERVIEW: "overview" },
}));
vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetchApi(...args),
}));
vi.mock("@/lib/events", () => ({ notifyTeamDataChanged: mockNotifyTeam }));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));
vi.mock("@/lib/team/team-vault-context", () => ({
  useTeamVault: () => ({
    getTeamEncryptionKey: mockGetTeamKey,
    getEntryDecryptionKey: mockGetEntryKey,
  }),
}));

import { renderHook } from "@testing-library/react";
import { decryptTeamOverview, useTeamVaultListAdapter } from "./team-vault-list-adapter";
import { isStepUpRequiredError } from "@/lib/http/handle-step-up-error";
import type { TeamDisplayEntry } from "@/types/team-display-entry";

const TEAM_ID = "team-1";
const STABLE_KEY = {} as CryptoKey;

function rawEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "e1",
    entryType: "LOGIN",
    encryptedOverview: "ct",
    overviewIv: "iv",
    overviewAuthTag: "tag",
    itemKeyVersion: 2,
    teamKeyVersion: 1,
    isFavorite: true,
    isArchived: false,
    requireReprompt: false,
    tags: [{ id: "t1", name: "work", color: null }],
    createdBy: { id: "u1", name: "A", email: "a@x", image: null },
    updatedBy: { id: "u1", name: "A", email: "a@x" },
    createdAt: "2026-01-01",
    updatedAt: "2026-01-02",
    ...overrides,
  };
}

describe("decryptTeamOverview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildTeamAAD.mockReturnValue("aad-bytes");
    mockGetEntryKey.mockResolvedValue(STABLE_KEY);
  });

  it("derives the OVERVIEW-scope team AAD with (teamId, entryId, 'overview', itemKeyVersion)", async () => {
    mockDecryptData.mockResolvedValue(JSON.stringify({ title: "GitHub", username: "u" }));

    const result = await decryptTeamOverview(TEAM_ID, rawEntry(), { getEntryDecryptionKey: mockGetEntryKey });

    // INV-C6.2: single team OVERVIEW AAD site, exact arg shape.
    expect(mockBuildTeamAAD).toHaveBeenCalledWith(TEAM_ID, "e1", "overview", 2);
    expect(result.title).toBe("GitHub");
    expect(result.username).toBe("u");
    // Metadata carried from the raw row.
    expect(result.isFavorite).toBe(true);
    expect(result.tags).toEqual([{ id: "t1", name: "work", color: null }]);
  });

  it("includes deletedAt only when present (trash rows — INV-C1.5)", async () => {
    mockDecryptData.mockResolvedValue(JSON.stringify({ title: "X" }));

    const trashed = await decryptTeamOverview(
      TEAM_ID,
      rawEntry({ deletedAt: "2026-02-01T00:00:00Z" }),
      { getEntryDecryptionKey: mockGetEntryKey },
    );
    expect(trashed.deletedAt).toBe("2026-02-01T00:00:00Z");

    const active = await decryptTeamOverview(TEAM_ID, rawEntry(), { getEntryDecryptionKey: mockGetEntryKey });
    expect("deletedAt" in active).toBe(false);
  });

  it("returns a placeholder entry (NOT throw, NOT skip) when decryption fails (F6)", async () => {
    mockDecryptData.mockRejectedValue(new Error("bad auth tag"));

    const result = await decryptTeamOverview(TEAM_ID, rawEntry(), { getEntryDecryptionKey: mockGetEntryKey });

    expect(result.title).toBe("(decryption failed)");
    expect(result.id).toBe("e1");
    // Base metadata still present so the row stays visible + counted.
    expect(result.isFavorite).toBe(true);
    expect(result.createdBy).toEqual({ id: "u1", name: "A", email: "a@x", image: null });
  });
});

describe("useTeamVaultListAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTeamKey.mockResolvedValue(STABLE_KEY);
    mockFetchApi.mockResolvedValue({ ok: true, json: async () => [] });
  });

  it("keeps favorites for team (supportsFavorite=true) and team bulk scope", () => {
    const { result } = renderHook(() => useTeamVaultListAdapter(TEAM_ID, "OWNER"));
    expect(result.current.supportsFavorite).toBe(true);
    expect(result.current.kind).toBe("team");
    expect(result.current.bulkScope("normal")).toEqual({ type: "team", teamId: TEAM_ID });
  });

  it("derives permissions from role (page.tsx:303-306 verbatim)", () => {
    const owner = renderHook(() => useTeamVaultListAdapter(TEAM_ID, "OWNER")).result.current.permissions;
    expect(owner).toEqual({ canCreate: true, canEdit: true, canDelete: true, canShare: true });

    const member = renderHook(() => useTeamVaultListAdapter(TEAM_ID, "MEMBER")).result.current.permissions;
    expect(member).toEqual({ canCreate: true, canEdit: true, canDelete: false, canShare: true });

    const viewer = renderHook(() => useTeamVaultListAdapter(TEAM_ID, "VIEWER")).result.current.permissions;
    expect(viewer).toEqual({ canCreate: false, canEdit: false, canDelete: false, canShare: false });
  });

  it("reports ready:true (the team page gates on its own key probe)", () => {
    const { result } = renderHook(() => useTeamVaultListAdapter(TEAM_ID, "OWNER"));
    expect(result.current.availability.ready).toBe(true);
  });

  it("builds the team list URL per view + query (favorites/archive/trash/folder/tag/type)", async () => {
    const { result } = renderHook(() => useTeamVaultListAdapter(TEAM_ID, "OWNER"));
    const signal = new AbortController().signal;

    await result.current.fetchOverviewEntries("favorites", {}, signal);
    await result.current.fetchOverviewEntries("archive", {}, signal);
    await result.current.fetchOverviewEntries("trash", {}, signal);
    await result.current.fetchOverviewEntries(
      "normal",
      { tagId: "tg", folderId: "fd", entryType: "LOGIN" },
      signal,
    );

    const urls = mockFetchApi.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toBe(`/api/teams/${TEAM_ID}/passwords?favorites=true`);
    expect(urls[1]).toBe(`/api/teams/${TEAM_ID}/passwords?archived=true`);
    expect(urls[2]).toBe(`/api/teams/${TEAM_ID}/passwords?trash=true`);
    expect(urls[3]).toBe(`/api/teams/${TEAM_ID}/passwords?tag=tg&folder=fd&type=LOGIN`);
  });

  it("returns [] (no fetch) when the team key is unavailable (key pending)", async () => {
    mockGetTeamKey.mockResolvedValue(null);
    const { result } = renderHook(() => useTeamVaultListAdapter(TEAM_ID, "OWNER"));
    const out = await result.current.fetchOverviewEntries("normal", {}, new AbortController().signal);
    expect(out).toEqual([]);
    // No list fetch issued when the key is pending.
    expect(mockFetchApi).not.toHaveBeenCalled();
  });

  it("routes mutations to the correct team endpoints (network-only)", async () => {
    const { result } = renderHook(() => useTeamVaultListAdapter(TEAM_ID, "OWNER"));
    const entry = { id: "e1" } as TeamDisplayEntry;

    await result.current.setFavorite(entry, true);
    await result.current.setArchived(entry, true);
    await result.current.softDelete(entry);
    await result.current.restore(entry);
    await result.current.deletePermanently(entry);
    await result.current.emptyTrash();

    const calls = mockFetchApi.mock.calls.map((c) => [c[0], (c[1] as RequestInit | undefined)?.method]);
    expect(calls).toEqual(
      expect.arrayContaining([
        [`/api/teams/${TEAM_ID}/passwords/e1/favorite`, "POST"],
        [`/api/teams/${TEAM_ID}/passwords/e1`, "PUT"],
        [`/api/teams/${TEAM_ID}/passwords/e1`, "DELETE"],
        [`/api/teams/${TEAM_ID}/passwords/e1/restore`, "POST"],
        [`/api/teams/${TEAM_ID}/passwords/e1?permanent=true`, "DELETE"],
        [`/api/teams/${TEAM_ID}/passwords/empty-trash`, "POST"],
      ]),
    );
  });

  // ---------------------------------------------------------------------------
  // Step-up (SESSION_STEP_UP_REQUIRED) handling — deletePermanently/emptyTrash only
  // ---------------------------------------------------------------------------
  it("deletePermanently rejects with StepUpRequiredError on a 403 SESSION_STEP_UP_REQUIRED", async () => {
    mockFetchApi.mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
    });

    const { result } = renderHook(() => useTeamVaultListAdapter(TEAM_ID, "OWNER"));
    const entry = { id: "e1" } as TeamDisplayEntry;

    const caught = await result.current.deletePermanently(entry).catch((e: unknown) => e);
    expect(isStepUpRequiredError(caught)).toBe(true);
  });

  it("emptyTrash rejects with StepUpRequiredError on a 403 SESSION_STEP_UP_REQUIRED", async () => {
    mockFetchApi.mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
    });

    const { result } = renderHook(() => useTeamVaultListAdapter(TEAM_ID, "OWNER"));

    const caught = await result.current.emptyTrash().catch((e: unknown) => e);
    expect(isStepUpRequiredError(caught)).toBe(true);
  });

  it("an ungated mutation (restore) rejects with a plain Error (not StepUpRequiredError) on the same 403 body", async () => {
    mockFetchApi.mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
    });

    const { result } = renderHook(() => useTeamVaultListAdapter(TEAM_ID, "OWNER"));
    const entry = { id: "e1" } as TeamDisplayEntry;

    const caught = await result.current.restore(entry).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(Error);
    expect(isStepUpRequiredError(caught)).toBe(false);
    expect((caught as Error).message).toBe("restore failed");
  });
});
