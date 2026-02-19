// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, waitFor, act } from "@testing-library/react";
import React from "react";

/* ---------- hoisted mocks ---------- */
const { mockSearchParams, mockFetch } = vi.hoisted(() => ({
  mockSearchParams: new URLSearchParams(),
  mockFetch: vi.fn(),
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
vi.mock("@/components/org/org-password-form", () => ({
  OrgPasswordForm: () => null,
}));
vi.mock("@/components/org/org-archived-list", () => ({
  OrgArchivedList: () => null,
}));
vi.mock("@/components/org/org-trash-list", () => ({
  OrgTrashList: () => null,
}));
vi.mock("@/components/org/org-role-badge", () => ({
  OrgRoleBadge: () => <span>ROLE</span>,
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

import OrgDashboardPage from "./page";

/* ---------- helpers ---------- */

function makeOrgResponse(role = "OWNER") {
  return {
    id: "org-1",
    name: "Test Org",
    slug: "test-org",
    role,
    memberCount: 3,
    passwordCount: 5,
  };
}

function setupFetch(orgRes = makeOrgResponse(), passwords: unknown[] = []) {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes("/api/orgs/org-1") && !url.includes("/passwords")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(orgRes),
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
      <OrgDashboardPage params={Promise.resolve({ orgId: "org-1" })} />
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

vi.mock("@/components/org/org-favorites-list", () => ({
  OrgFavoritesList: () => null,
}));

/* ---------- tests ---------- */

describe("OrgDashboardPage — folder query propagation", () => {
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

describe("OrgDashboardPage — scopes", () => {
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
      // Org fetch should happen
      const calls = mockFetch.mock.calls.map((c: [string]) => c[0]);
      expect(calls.some((u: string) => u.includes("/api/orgs/org-1") && !u.includes("/passwords"))).toBe(true);
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
      expect(calls.some((u: string) => u.includes("/api/orgs/org-1") && !u.includes("/passwords"))).toBe(true);
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

describe("OrgDashboardPage — role-based rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of [...mockSearchParams.keys()]) {
      mockSearchParams.delete(key);
    }
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  it("shows newItem button for OWNER role", async () => {
    setupFetch(makeOrgResponse("OWNER"));

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
    setupFetch(makeOrgResponse("VIEWER"));

    let view: ReturnType<typeof render>;
    await act(async () => {
      view = renderPage();
    });

    await waitFor(() => {
      // Wait for org data to load
      const calls = mockFetch.mock.calls.map((c: [string]) => c[0]);
      expect(calls.some((u: string) => u.includes("/api/orgs/org-1"))).toBe(true);
    });

    // newItem should not appear in actions
    const actions = view!.container.querySelector("[data-testid='header-actions']");
    expect(actions?.textContent ?? "").not.toContain("newItem");
  });
});

describe("OrgDashboardPage — error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of [...mockSearchParams.keys()]) {
      mockSearchParams.delete(key);
    }
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  it("shows error state when org fetch fails", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/api/orgs/org-1") && !url.includes("/passwords")) {
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
