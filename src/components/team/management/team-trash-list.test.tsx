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

const { mockFetch, mockGetEntryDecryptionKey, mockToast } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockGetEntryDecryptionKey: vi.fn(),
  mockToast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("sonner", () => ({ toast: mockToast }));

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
    JSON.stringify({ title: "Trashed", username: "u" }),
  ),
}));

vi.mock("@/lib/crypto/crypto-aad", () => ({
  buildTeamEntryAAD: vi.fn(() => "aad"),
}));

vi.mock("@/lib/events", () => ({
  notifyTeamDataChanged: vi.fn(),
}));

vi.mock("@/components/bulk/entry-list-shell", () => ({
  EntryListShell: ({
    entries,
    renderEntry,
  }: {
    entries: { id: string; title: string }[];
    renderEntry: (e: { id: string; title: string }, selection: null) => React.ReactNode;
  }) => (
    <div data-testid="list-shell">
      {entries.map((e) => (
        <div key={e.id}>{renderEntry(e, null)}</div>
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

import { TeamTrashList } from "./team-trash-list";

const SAMPLE_TRASH = {
  id: "t1",
  entryType: "LOGIN",
  encryptedOverview: "eo",
  overviewIv: "oi",
  overviewAuthTag: "oa",
  itemKeyVersion: 1,
  encryptedItemKey: "eik",
  itemKeyIv: "iki",
  itemKeyAuthTag: "ika",
  teamKeyVersion: 1,
  deletedAt: "2026-04-01T00:00:00Z",
};

describe("TeamTrashList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEntryDecryptionKey.mockResolvedValue({});
  });

  it("shows empty trash card when no entries", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
    await act(async () => {
      render(
        <TeamTrashList
          teamId="team-1"
          teamName="Team"
          role={TEAM_ROLE.OWNER}
          searchQuery=""
          refreshKey={0}
        />,
      );
    });
    await waitFor(() => {
      expect(screen.getByText("noTrash")).toBeInTheDocument();
    });
  });

  it("renders decrypted trash entries with title and team name", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([SAMPLE_TRASH]),
    });
    await act(async () => {
      render(
        <TeamTrashList
          teamId="team-1"
          teamName="MyTeam"
          role={TEAM_ROLE.OWNER}
          searchQuery=""
          refreshKey={0}
        />,
      );
    });
    await waitFor(() => {
      expect(screen.getByText("Trashed")).toBeInTheDocument();
      expect(screen.getByText("MyTeam")).toBeInTheDocument();
    });
  });

  it("hides empty-trash button for non-admin/non-owner roles", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([SAMPLE_TRASH]),
    });
    await act(async () => {
      render(
        <TeamTrashList
          teamId="team-1"
          teamName="Team"
          role={TEAM_ROLE.MEMBER}
          searchQuery=""
          refreshKey={0}
        />,
      );
    });
    await waitFor(() => {
      // emptyTrash button text should not appear for MEMBER role
      expect(screen.queryByText("emptyTrash")).toBeNull();
    });
  });

  it("renders fallback title when decrypt fails", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([SAMPLE_TRASH]),
    });
    mockGetEntryDecryptionKey.mockRejectedValueOnce(new Error("fail"));
    await act(async () => {
      render(
        <TeamTrashList
          teamId="team-1"
          teamName="Team"
          role={TEAM_ROLE.OWNER}
          searchQuery=""
          refreshKey={0}
        />,
      );
    });
    await waitFor(() => {
      expect(screen.getByText("(decryption failed)")).toBeInTheDocument();
    });
  });

  // §Sec-3 cross-tenant denial
  it("renders empty state for cross-tenant context (no leak)", async () => {
    const ctx = mockTeamMismatch({ actorTeamId: "team-a", resourceTeamId: "team-b" });
    expect(ctx.useTeamVault().currentTeamId).not.toBe(ctx.teamId);
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
    await act(async () => {
      render(
        <TeamTrashList
          teamId={ctx.teamId}
          teamName="Other"
          role={TEAM_ROLE.MEMBER}
          searchQuery=""
          refreshKey={0}
        />,
      );
    });
    await waitFor(() => {
      expect(screen.getByText("noTrash")).toBeInTheDocument();
    });
    expect(screen.queryByText("Trashed")).toBeNull();
  });
});
