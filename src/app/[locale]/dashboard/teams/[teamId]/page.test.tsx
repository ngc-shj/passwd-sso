// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, waitFor, act } from "@testing-library/react";
import React from "react";

/* ---------- hoisted mocks ---------- */
const { mockSearchParams, mockFetch, mockGetOrgEncryptionKey } = vi.hoisted(() => ({
  mockSearchParams: new URLSearchParams(),
  mockFetch: vi.fn(),
  mockGetOrgEncryptionKey: vi.fn().mockResolvedValue(null),
}));

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
  PasswordCard: () => <div data-testid="password-card" />,
}));
vi.mock("@/components/team/team-password-form", () => ({
  TeamPasswordForm: () => null,
}));
vi.mock("@/components/team/team-archived-list", () => ({
  TeamArchivedList: () => null,
}));
vi.mock("@/components/team/team-trash-list", () => ({
  TeamTrashList: () => null,
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
    getTeamEncryptionKey: mockGetOrgEncryptionKey,
    getTeamKeyInfo: vi.fn().mockResolvedValue(null),
    invalidateTeamKey: vi.fn(),
    clearAll: vi.fn(),
    distributePendingKeys: vi.fn(),
  }),
}));

vi.mock("@/lib/crypto-client", () => ({
  decryptData: vi.fn(),
}));

vi.mock("@/lib/crypto-aad", () => ({
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
  });

  it("includes folder param in password fetch when folder is active", async () => {
    mockSearchParams.set("folder", "folder-abc");
    setupFetch();

    await act(async () => {
      renderPage();
    });

    await waitFor(() => {
      const calls = mockFetch.mock.calls.map((c: [string]) => c[0]);
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
      const calls = mockFetch.mock.calls.map((c: [string]) => c[0]);
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
      const calls = mockFetch.mock.calls.map((c: [string]) => c[0]);
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
  });

  it("does NOT fetch passwords when scope=archive", async () => {
    mockSearchParams.set("scope", "archive");
    setupFetch();

    await act(async () => {
      renderPage();
    });

    await waitFor(() => {
      // Team fetch should happen
      const calls = mockFetch.mock.calls.map((c: [string]) => c[0]);
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
      const calls = mockFetch.mock.calls.map((c: [string]) => c[0]);
      expect(calls.some((u: string) => u.includes("/api/teams/team-1") && !u.includes("/passwords"))).toBe(true);
    });

    const passwordCalls = mockFetch.mock.calls
      .map((c: [string]) => c[0])
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
      const calls = mockFetch.mock.calls.map((c: [string]) => c[0]);
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
      const calls = mockFetch.mock.calls.map((c: [string]) => c[0]);
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
