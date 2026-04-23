// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, waitFor, act } from "@testing-library/react";
import React from "react";

/* ---------- hoisted mocks ---------- */
const { mockSearchParams, mockFetch, mockGetTeamEncryptionKey, mockDecryptData } = vi.hoisted(() => ({
  mockSearchParams: new URLSearchParams(),
  mockFetch: vi.fn(),
  mockGetTeamEncryptionKey: vi.fn().mockResolvedValue(null),
  mockDecryptData: vi.fn(),
}));

const teamArchivedListMock = vi.fn();
const teamTrashListMock = vi.fn();

const teamEditDialogLoaderMock = vi.fn();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) => {
    if (values) return `${key}(${JSON.stringify(values)})`;
    return key;
  },
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Stub child components to avoid deep dependency trees
vi.mock("@/components/passwords/password-card", () => ({
  PasswordCard: ({ onEditClick }: { onEditClick?: () => void }) => (
    <button data-testid="password-card" onClick={onEditClick}>
      password-card
    </button>
  ),
}));
vi.mock("@/components/team/team-login-form", () => ({
  TeamLoginForm: () => null,
}));
vi.mock("@/components/team/team-edit-dialog-loader", () => ({
  TeamEditDialogLoader: (props: unknown) => {
    teamEditDialogLoaderMock(props);
    return <div data-testid="team-edit-dialog-loader" />;
  },
}));
vi.mock("@/components/team/team-archived-list", () => ({
  TeamArchivedList: (props: unknown) => {
    teamArchivedListMock(props);
    return null;
  },
}));
vi.mock("@/components/team/team-trash-list", () => ({
  TeamTrashList: (props: unknown) => {
    teamTrashListMock(props);
    return null;
  },
}));
vi.mock("@/components/team/team-role-badge", () => ({
  TeamRoleBadge: () => <span>ROLE</span>,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, asChild, ...rest }: React.ComponentProps<"button"> & { asChild?: boolean }) => {
    void asChild;
    return <button {...rest}>{children}</button>;
  },
}));
vi.mock("@/components/ui/card", () => ({
  Card: ({ children, ...rest }: React.ComponentProps<"div">) => (
    <div {...rest}>{children}</div>
  ),
}));
vi.mock("@/components/ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import TeamDashboardPage from "./page";

/* ---------- helpers ---------- */

function makeTeamResponse(role = "OWNER") {
  return {
    id: "team-1",
    name: "Test Team",
    slug: "test-team",
    role,
    memberCount: 3,
    passwordCount: 5,
  };
}

function setupFetch(teamRes = makeTeamResponse(), passwords: unknown[] = []) {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes("/api/teams/team-1") && !url.includes("/passwords")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(teamRes),
      });
    }
    if (url.includes("/passwords")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(passwords),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });
}

function renderPage() {
  return render(
    <React.Suspense fallback={<div>Loading...</div>}>
      <TeamDashboardPage params={Promise.resolve({ teamId: "team-1" })} />
    </React.Suspense>,
  );
}

vi.mock("@/components/passwords/entry-list-header", () => ({
  EntryListHeader: ({
    title,
    subtitle,
    actions,
  }: {
    title: string;
    subtitle: string;
    showSubtitle: boolean;
    titleExtra: React.ReactNode;
    actions: React.ReactNode;
  }) => (
    <div data-testid="entry-list-header">
      <span data-testid="header-title">{title}</span>
      <span data-testid="header-subtitle">{subtitle}</span>
      <div data-testid="header-actions">{actions}</div>
    </div>
  ),
}));

vi.mock("@/components/passwords/entry-sort-menu", () => ({
  EntrySortMenu: () => null,
}));

vi.mock("@/components/team/team-favorites-list", () => ({
  TeamFavoritesList: () => null,
}));

vi.mock("@/lib/team-vault-context", () => ({
  useTeamVault: () => ({
    getTeamEncryptionKey: mockGetTeamEncryptionKey,
    getTeamKeyInfo: vi.fn().mockResolvedValue(null),
    invalidateTeamKey: vi.fn(),
    clearAll: vi.fn(),
    distributePendingKeys: vi.fn(),
  }),
}));

vi.mock("@/lib/crypto/crypto-client", () => ({
  decryptData: (...args: unknown[]) => mockDecryptData(...args),
}));

vi.mock("@/lib/crypto/crypto-aad", () => ({
  buildTeamEntryAAD: vi.fn().mockReturnValue(new Uint8Array()),
}));

/* ---------- tests ---------- */

describe("TeamDashboardPage — folder query propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset searchParams
    for (const key of [...mockSearchParams.keys()]) {
      mockSearchParams.delete(key);
    }
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockDecryptData.mockResolvedValue(
      JSON.stringify({
        title: "Entry One",
        username: "alice",
      }),
    );
  });

  it("includes folder param in password fetch when folder is active", async () => {
    mockSearchParams.set("folder", "folder-abc");
    setupFetch();

    await act(async () => {
      renderPage();
    });

    await waitFor(() => {
      const calls = mockFetch.mock.calls.map((c: unknown[]) => c[0] as string);
      const passwordCall = calls.find((u: string) => u.includes("/passwords"));
      expect(passwordCall).toBeDefined();
      expect(passwordCall).toContain("folder=folder-abc");
    });
  });

  it("does NOT include folder param when no folder is active", async () => {
    setupFetch();

    await act(async () => {
      renderPage();
    });

    await waitFor(() => {
      const calls = mockFetch.mock.calls.map((c: unknown[]) => c[0] as string);
      const passwordCall = calls.find((u: string) => u.includes("/passwords"));
      expect(passwordCall).toBeDefined();
      expect(passwordCall).not.toContain("folder=");
    });
  });

  it("combines folder and tag params in password fetch", async () => {
    mockSearchParams.set("folder", "folder-abc");
    mockSearchParams.set("tag", "tag-xyz");
    setupFetch();

    await act(async () => {
      renderPage();
    });

    await waitFor(() => {
      const calls = mockFetch.mock.calls.map((c: unknown[]) => c[0] as string);
      const passwordCall = calls.find((u: string) => u.includes("/passwords"));
      expect(passwordCall).toBeDefined();
      expect(passwordCall).toContain("folder=folder-abc");
      expect(passwordCall).toContain("tag=tag-xyz");
    });
  });
});

describe("TeamDashboardPage — scopes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of [...mockSearchParams.keys()]) {
      mockSearchParams.delete(key);
    }
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockDecryptData.mockResolvedValue(
      JSON.stringify({
        title: "Entry One",
        username: "alice",
      }),
    );
  });

  it("does NOT fetch passwords when scope=archive", async () => {
    mockSearchParams.set("scope", "archive");
    setupFetch();

    await act(async () => {
      renderPage();
    });

    await waitFor(() => {
      // Team fetch should happen
      const calls = mockFetch.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(calls.some((u: string) => u.includes("/api/teams/team-1") && !u.includes("/passwords"))).toBe(true);
    });

    // Password fetch should NOT happen for archive scope
    const passwordCalls = (mockFetch.mock.calls as string[][])
      .map((c) => c[0])
      .filter((u) => u.includes("/passwords"));
    expect(passwordCalls).toHaveLength(0);
  });

  it("does NOT fetch passwords when scope=trash", async () => {
    mockSearchParams.set("scope", "trash");
    setupFetch();

    await act(async () => {
      renderPage();
    });

    await waitFor(() => {
      const calls = mockFetch.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(calls.some((u: string) => u.includes("/api/teams/team-1") && !u.includes("/passwords"))).toBe(true);
    });

    const passwordCalls = mockFetch.mock.calls
      .map((c: unknown[]) => c[0] as string)
      .filter((u: string) => u.includes("/passwords"));
    expect(passwordCalls).toHaveLength(0);
  });

  it("includes favorites=true when scope=favorites", async () => {
    mockSearchParams.set("scope", "favorites");
    setupFetch();

    await act(async () => {
      renderPage();
    });

    await waitFor(() => {
      const calls = mockFetch.mock.calls.map((c: unknown[]) => c[0] as string);
      const passwordCall = calls.find((u: string) => u.includes("/passwords"));
      expect(passwordCall).toBeDefined();
      expect(passwordCall).toContain("favorites=true");
    });
  });
});

describe("TeamDashboardPage — role-based rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of [...mockSearchParams.keys()]) {
      mockSearchParams.delete(key);
    }
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockDecryptData.mockResolvedValue(
      JSON.stringify({
        title: "Entry One",
        username: "alice",
      }),
    );
  });

  it("shows newItem button for OWNER role", async () => {
    setupFetch(makeTeamResponse("OWNER"));

    let view: ReturnType<typeof render>;
    await act(async () => {
      view = renderPage();
    });

    await waitFor(() => {
      const actions = view!.container.querySelector("[data-testid='header-actions']");
      expect(actions?.textContent).toContain("newItem");
    });
  });

  it("does NOT show newItem button for VIEWER role", async () => {
    setupFetch(makeTeamResponse("VIEWER"));

    let view: ReturnType<typeof render>;
    await act(async () => {
      view = renderPage();
    });

    await waitFor(() => {
      // Wait for team data to load
      const calls = mockFetch.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(calls.some((u: string) => u.includes("/api/teams/team-1"))).toBe(true);
    });

    // newItem should not appear in actions
    const actions = view!.container.querySelector("[data-testid='header-actions']");
    expect(actions?.textContent ?? "").not.toContain("newItem");
  });
});

describe("TeamDashboardPage — error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of [...mockSearchParams.keys()]) {
      mockSearchParams.delete(key);
    }
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockDecryptData.mockResolvedValue(
      JSON.stringify({
        title: "Entry One",
        username: "alice",
      }),
    );
  });

  it("shows error state when team fetch fails", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/api/teams/team-1") && !url.includes("/passwords")) {
        return Promise.resolve({ ok: false, status: 403 });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    let view: ReturnType<typeof render>;
    await act(async () => {
      view = renderPage();
    });

    await waitFor(() => {
      expect(view!.container.textContent).toContain("forbidden");
    });
  });
});

describe("TeamDashboardPage — prop forwarding to archived/trash list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of [...mockSearchParams.keys()]) {
      mockSearchParams.delete(key);
    }
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockDecryptData.mockResolvedValue(
      JSON.stringify({
        title: "Entry One",
        username: "alice",
      }),
    );
  });

  it("passes teamName and role from loaded team to TeamArchivedList when scope=archive", async () => {
    mockSearchParams.set("scope", "archive");
    setupFetch(makeTeamResponse("ADMIN"));

    await act(async () => {
      renderPage();
    });

    await waitFor(() => {
      expect(teamArchivedListMock).toHaveBeenCalled();
    });

    expect(teamArchivedListMock).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: "Test Team",
        role: "ADMIN",
      }),
    );
  });

  it("passes teamName and role from loaded team to TeamTrashList when scope=trash", async () => {
    mockSearchParams.set("scope", "trash");
    setupFetch(makeTeamResponse("MEMBER"));

    await act(async () => {
      renderPage();
    });

    await waitFor(() => {
      expect(teamTrashListMock).toHaveBeenCalled();
    });

    expect(teamTrashListMock).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: "Test Team",
        role: "MEMBER",
      }),
    );
  });

  it("does NOT render TeamArchivedList when scope=archive but team is not yet loaded (null guard)", async () => {
    // Return a never-resolving team fetch so team stays null
    mockSearchParams.set("scope", "archive");
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/api/teams/team-1") && !url.includes("/passwords")) {
        return new Promise(() => {}); // never resolves
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    await act(async () => {
      renderPage();
    });

    // Give React a moment to settle without the team resolving
    await new Promise((r) => setTimeout(r, 50));

    expect(teamArchivedListMock).not.toHaveBeenCalled();
  });
});

describe("TeamDashboardPage - edit wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of [...mockSearchParams.keys()]) {
      mockSearchParams.delete(key);
    }
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  it("opens TeamEditDialogLoader with the clicked entry id", async () => {
    mockGetTeamEncryptionKey.mockResolvedValue({} as CryptoKey);
    setupFetch(makeTeamResponse("OWNER"), [
      {
        id: "entry-1",
        entryType: "LOGIN",
        encryptedOverview: "cipher",
        overviewIv: "iv",
        overviewAuthTag: "tag",
        tags: [],
        isFavorite: false,
        isArchived: false,
        requireReprompt: false,
        expiresAt: null,
        createdBy: { name: "Alice", email: "alice@example.com" },
        updatedBy: { name: "Alice", email: "alice@example.com" },
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      },
    ]);

    let view: ReturnType<typeof render>;
    await act(async () => {
      view = renderPage();
    });

    await waitFor(() => {
      expect(view!.getAllByTestId("password-card")).toHaveLength(1);
    });

    await act(async () => {
      view!.getByTestId("password-card").click();
    });

    await waitFor(() => {
      expect(view!.getByTestId("team-edit-dialog-loader")).toBeInTheDocument();
    });

    expect(teamEditDialogLoaderMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        teamId: "team-1",
        id: "entry-1",
        open: true,
      }),
    );
  });
});
