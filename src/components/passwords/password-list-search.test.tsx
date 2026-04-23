// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────────
const { mockFetchApi, mockDecryptData, mockEncryptionKey } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockDecryptData: vi.fn(),
  // Stable object reference — must not change between renders to avoid infinite
  // re-render loops caused by useCallback/useEffect deps on encryptionKey.
  mockEncryptionKey: {} as CryptoKey,
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/vault-context", () => ({
  useVault: () => ({
    encryptionKey: mockEncryptionKey,
    userId: "user-1",
  }),
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: mockFetchApi,
  withBasePath: (p: string) => p,
}));

vi.mock("@/lib/crypto-client", () => ({
  decryptData: mockDecryptData,
}));

vi.mock("@/lib/crypto-aad", () => ({
  buildPersonalEntryAAD: vi.fn().mockReturnValue("aad"),
}));

vi.mock("@/hooks/use-travel-mode", () => ({
  useTravelMode: () => ({ active: false }),
}));

vi.mock("@/lib/auth/travel-mode", () => ({
  filterTravelSafe: (entries: unknown[]) => entries,
}));

vi.mock("@/lib/entry-sort", () => ({
  compareEntriesWithFavorite: () => 0,
}));

vi.mock("@/hooks/use-bulk-selection", () => ({
  useBulkSelection: () => ({
    selectedIds: new Set<string>(),
    atLimit: false,
    toggleSelectOne: vi.fn(),
    clearSelection: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-bulk-action", () => ({
  useBulkAction: () => ({
    dialogOpen: false,
    setDialogOpen: vi.fn(),
    pendingAction: null,
    processing: false,
    requestAction: vi.fn(),
    executeAction: vi.fn(),
  }),
}));

// Render each entry title as a simple div so we can assert which entries are visible
vi.mock("@/components/passwords/password-card", () => ({
  PasswordCard: ({ entry }: { entry: { title: string } }) => (
    <div data-testid="password-card">{entry.title}</div>
  ),
}));

vi.mock("@/components/bulk/bulk-action-confirm-dialog", () => ({
  BulkActionConfirmDialog: () => null,
}));

vi.mock("@/components/bulk/floating-action-bar", () => ({
  FloatingActionBar: () => null,
}));

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: () => null,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick }: React.ComponentProps<"button">) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

// Lucide icons — render nothing in tests
vi.mock("lucide-react", () => ({
  Loader2: () => <span data-testid="loader" />,
  KeyRound: () => null,
  Star: () => null,
  Archive: () => null,
}));

import { PasswordList } from "./password-list";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeApiEntry(id: string) {
  return {
    id,
    entryType: "LOGIN",
    isFavorite: false,
    isArchived: false,
    requireReprompt: false,
    expiresAt: null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    aadVersion: 1,
    encryptedOverview: { ciphertext: "ct", iv: "iv", authTag: "tag" },
  };
}

function makeOverview(title: string, username?: string) {
  return JSON.stringify({
    title,
    username: username ?? null,
    tags: [],
    travelSafe: true,
  });
}

function okJsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(body),
  } as Response);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("PasswordList — client-side search decoupling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches once on mount regardless of searchQuery", async () => {
    mockFetchApi.mockReturnValue(okJsonResponse([makeApiEntry("e1")]));
    mockDecryptData.mockResolvedValue(makeOverview("GitHub"));

    const { rerender } = render(
      <PasswordList
        searchQuery=""
        tagId={null}
        refreshKey={0}
      />
    );

    // Wait for initial fetch + decrypt to complete
    await waitFor(() => {
      expect(screen.getByTestId("password-card")).toBeInTheDocument();
    });

    expect(mockFetchApi).toHaveBeenCalledTimes(1);

    // Changing searchQuery must NOT trigger a new fetch
    rerender(
      <PasswordList
        searchQuery="git"
        tagId={null}
        refreshKey={0}
      />
    );

    // Give React time to flush any async effects
    await act(async () => {});

    expect(mockFetchApi).toHaveBeenCalledTimes(1);
  });

  it("filters entries client-side by title without re-fetching", async () => {
    mockFetchApi.mockReturnValue(
      okJsonResponse([makeApiEntry("e1"), makeApiEntry("e2"), makeApiEntry("e3")])
    );
    mockDecryptData
      .mockResolvedValueOnce(makeOverview("GitHub"))
      .mockResolvedValueOnce(makeOverview("Notion"))
      .mockResolvedValueOnce(makeOverview("GitLab"));

    const { rerender } = render(
      <PasswordList
        searchQuery=""
        tagId={null}
        refreshKey={0}
      />
    );

    // All three entries visible with empty search
    await waitFor(() => {
      expect(screen.getAllByTestId("password-card")).toHaveLength(3);
    });

    const fetchCountAfterMount = mockFetchApi.mock.calls.length;

    // Apply a search term — only "GitHub" and "GitLab" should remain
    act(() => {
      rerender(
        <PasswordList
          searchQuery="git"
          tagId={null}
          refreshKey={0}
        />
      );
    });

    await waitFor(() => {
      const cards = screen.getAllByTestId("password-card");
      expect(cards).toHaveLength(2);
      expect(cards.map((c) => c.textContent)).toEqual(
        expect.arrayContaining(["GitHub", "GitLab"])
      );
      expect(screen.queryByText("Notion")).not.toBeInTheDocument();
    });

    // No additional API call should have been made
    expect(mockFetchApi).toHaveBeenCalledTimes(fetchCountAfterMount);
  });

  it("filters entries client-side by username without re-fetching", async () => {
    mockFetchApi.mockReturnValue(
      okJsonResponse([makeApiEntry("e1"), makeApiEntry("e2")])
    );
    mockDecryptData
      .mockResolvedValueOnce(makeOverview("GitHub", "alice@example.com"))
      .mockResolvedValueOnce(makeOverview("GitLab", "bob@example.com"));

    const { rerender } = render(
      <PasswordList
        searchQuery=""
        tagId={null}
        refreshKey={0}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("password-card")).toHaveLength(2);
    });

    act(() => {
      rerender(
        <PasswordList
          searchQuery="alice"
          tagId={null}
          refreshKey={0}
        />
      );
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("password-card")).toHaveLength(1);
      expect(screen.getByText("GitHub")).toBeInTheDocument();
      expect(screen.queryByText("GitLab")).not.toBeInTheDocument();
    });

    // Still only one fetch
    expect(mockFetchApi).toHaveBeenCalledTimes(1);
  });

  it("shows all entries when searchQuery is cleared after filtering", async () => {
    mockFetchApi.mockReturnValue(
      okJsonResponse([makeApiEntry("e1"), makeApiEntry("e2")])
    );
    mockDecryptData
      .mockResolvedValueOnce(makeOverview("GitHub"))
      .mockResolvedValueOnce(makeOverview("Notion"));

    const { rerender } = render(
      <PasswordList
        searchQuery="git"
        tagId={null}
        refreshKey={0}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
      expect(screen.queryByText("Notion")).not.toBeInTheDocument();
    });

    act(() => {
      rerender(
        <PasswordList
          searchQuery=""
          tagId={null}
          refreshKey={0}
        />
      );
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("password-card")).toHaveLength(2);
    });

    expect(mockFetchApi).toHaveBeenCalledTimes(1);
  });

  it("filters case-insensitively matching both title and username", async () => {
    mockFetchApi.mockReturnValue(
      okJsonResponse([makeApiEntry("e1"), makeApiEntry("e2"), makeApiEntry("e3")])
    );
    mockDecryptData
      .mockResolvedValueOnce(makeOverview("GitHub", "alice@example.com"))
      .mockResolvedValueOnce(makeOverview("Notion", "Bob@example.com"))
      .mockResolvedValueOnce(makeOverview("admin-panel", "Admin"));

    const { rerender } = render(
      <PasswordList
        searchQuery=""
        tagId={null}
        refreshKey={0}
      />
    );

    // All three entries visible initially
    await waitFor(() => {
      expect(screen.getAllByTestId("password-card")).toHaveLength(3);
    });

    // Lowercase "github" must match title "GitHub" (case-insensitive)
    act(() => {
      rerender(
        <PasswordList
          searchQuery="github"
          tagId={null}
          refreshKey={0}
        />
      );
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("password-card")).toHaveLength(1);
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    // Lowercase "admin" must match username "Admin" (case-insensitive)
    act(() => {
      rerender(
        <PasswordList
          searchQuery="admin"
          tagId={null}
          refreshKey={0}
        />
      );
    });

    await waitFor(() => {
      const cards = screen.getAllByTestId("password-card");
      // "admin-panel" matches by title; "admin-panel"'s username "Admin" also matches.
      // Both "admin-panel" (title match) entries and any username match appear.
      expect(cards.length).toBeGreaterThanOrEqual(1);
      const texts = cards.map((c) => c.textContent);
      expect(texts).toEqual(expect.arrayContaining(["admin-panel"]));
    });

    // No additional fetches triggered by search changes
    expect(mockFetchApi).toHaveBeenCalledTimes(1);
  });

  it("re-fetches when refreshKey changes", async () => {
    mockFetchApi.mockReturnValue(okJsonResponse([makeApiEntry("e1")]));
    mockDecryptData.mockResolvedValue(makeOverview("GitHub"));

    const { rerender } = render(
      <PasswordList
        searchQuery="git"
        tagId={null}
        refreshKey={0}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("password-card")).toBeInTheDocument();
    });

    expect(mockFetchApi).toHaveBeenCalledTimes(1);

    // refreshKey change must trigger a new fetch
    mockFetchApi.mockReturnValue(okJsonResponse([makeApiEntry("e1")]));
    mockDecryptData.mockResolvedValue(makeOverview("GitHub"));

    act(() => {
      rerender(
        <PasswordList
          searchQuery="git"
          tagId={null}
          refreshKey={1}
        />
      );
    });

    await waitFor(() => {
      expect(mockFetchApi).toHaveBeenCalledTimes(2);
    });
  });
});
