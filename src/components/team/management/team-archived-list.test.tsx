// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

import { render, screen, waitFor, act } from "@testing-library/react";
import { mockTeamMismatch } from "@/__tests__/helpers/mock-app-navigation";
import { TEAM_ROLE } from "@/lib/constants";

const { mockFetch, mockGetEntryDecryptionKey } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockGetEntryDecryptionKey: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

vi.mock("@/lib/team/team-vault-context", () => ({
  useTeamVault: () => ({
    getEntryDecryptionKey: mockGetEntryDecryptionKey,
  }),
}));

vi.mock("@/lib/crypto/crypto-client", () => ({
  decryptData: vi.fn(async () =>
    JSON.stringify({
      title: "Decrypted Title",
      username: "alice",
      urlHost: "example.com",
    }),
  ),
}));

vi.mock("@/lib/crypto/crypto-aad", () => ({
  buildTeamEntryAAD: vi.fn(() => "aad"),
}));

vi.mock("@/lib/events", () => ({
  notifyTeamDataChanged: vi.fn(),
}));

vi.mock("@/components/passwords/detail/password-card", () => ({
  PasswordCard: ({
    entry,
  }: {
    entry: { id: string; title: string };
  }) => <div data-testid={`card-${entry.id}`}>{entry.title}</div>,
}));

vi.mock("@/components/team/management/team-edit-dialog-loader", () => ({
  TeamEditDialogLoader: () => null,
}));

vi.mock("@/components/bulk/entry-list-shell", () => ({
  EntryListShell: ({
    entries,
    renderEntry,
  }: {
    entries: { id: string; title: string }[];
    renderEntry: (e: { id: string; title: string }) => React.ReactNode;
  }) => (
    <div data-testid="list-shell">
      {entries.map((e) => (
        <div key={e.id}>{renderEntry(e)}</div>
      ))}
    </div>
  ),
}));

vi.mock("@/hooks/bulk/use-bulk-selection", () => ({
  useBulkSelection: () => ({
    selectedIds: new Set<string>(),
    atLimit: false,
    toggleSelectOne: vi.fn(),
    clearSelection: vi.fn(),
  }),
}));

vi.mock("@/hooks/bulk/use-bulk-action", () => ({
  useBulkAction: () => ({
    dialogOpen: false,
    setDialogOpen: vi.fn(),
    pendingAction: null,
    processing: false,
    requestAction: vi.fn(),
    executeAction: vi.fn(),
  }),
}));

import { TeamArchivedList } from "./team-archived-list";

const SAMPLE_ENCRYPTED = {
  id: "e1",
  entryType: "LOGIN",
  encryptedBlob: "eb",
  blobIv: "iv",
  blobAuthTag: "at",
  encryptedOverview: "eo",
  overviewIv: "oi",
  overviewAuthTag: "oa",
  itemKeyVersion: 1,
  encryptedItemKey: "eik",
  itemKeyIv: "iki",
  itemKeyAuthTag: "ika",
  teamKeyVersion: 1,
  isFavorite: false,
  isArchived: true,
  tags: [],
  createdBy: { id: "u1", name: "User", email: "u@x", image: null },
  updatedBy: { id: "u1", name: "User", email: "u@x" },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
};

describe("TeamArchivedList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEntryDecryptionKey.mockResolvedValue({});
  });

  it("renders empty state when no archived entries", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
    await act(async () => {
      render(
        <TeamArchivedList
          teamId="team-1"
          teamName="Team"
          role={TEAM_ROLE.OWNER}
          searchQuery=""
          refreshKey={0}
        />,
      );
    });
    await waitFor(() => {
      expect(screen.getByText("noArchive")).toBeInTheDocument();
    });
  });

  it("renders decrypted entries from server", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([SAMPLE_ENCRYPTED]),
    });
    await act(async () => {
      render(
        <TeamArchivedList
          teamId="team-1"
          teamName="Team"
          role={TEAM_ROLE.OWNER}
          searchQuery=""
          refreshKey={0}
        />,
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("card-e1")).toHaveTextContent("Decrypted Title");
    });
  });

  it("renders fallback title when decrypt fails (no crash, no leak)", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([SAMPLE_ENCRYPTED]),
    });
    // Force decrypt key resolution to throw
    mockGetEntryDecryptionKey.mockRejectedValueOnce(new Error("decrypt failure"));
    await act(async () => {
      render(
        <TeamArchivedList
          teamId="team-1"
          teamName="Team"
          role={TEAM_ROLE.OWNER}
          searchQuery=""
          refreshKey={0}
        />,
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("card-e1")).toHaveTextContent("(decryption failed)");
    });
  });

  // §Sec-3 cross-tenant denial — UI does not crash, no leaked entries
  it("renders empty when server returns empty list (cross-tenant context)", async () => {
    const ctx = mockTeamMismatch({ actorTeamId: "team-a", resourceTeamId: "team-b" });
    expect(ctx.useTeamVault().currentTeamId).not.toBe(ctx.teamId);

    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
    await act(async () => {
      render(
        <TeamArchivedList
          teamId={ctx.teamId}
          teamName="Other"
          role={TEAM_ROLE.MEMBER}
          searchQuery=""
          refreshKey={0}
        />,
      );
    });
    await waitFor(() => {
      expect(screen.getByText("noArchive")).toBeInTheDocument();
    });
    // No raw card exposing entry data
    expect(screen.queryByTestId("card-e1")).toBeNull();
  });
});
