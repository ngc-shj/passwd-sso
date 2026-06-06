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
vi.mock("@/lib/team/team-vault-context", () => ({
  useTeamVault: () => ({
    getTeamEncryptionKey: mockGetTeamKey,
    getEntryDecryptionKey: mockGetEntryKey,
  }),
}));

import { renderHook, waitFor } from "@testing-library/react";
import { decryptTeamOverview, useTeamVaultListAdapter } from "./team-vault-list-adapter";
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
    mockFetchApi.mockResolvedValue({ ok: true, json: async () => ({}) });
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

  it("becomes ready once the team key probe resolves", async () => {
    const { result } = renderHook(() => useTeamVaultListAdapter(TEAM_ID, "OWNER"));
    await waitFor(() => expect(result.current.availability.ready).toBe(true));
    expect(result.current.availability.reason).toBe("key-pending");
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
});
