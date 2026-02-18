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
vi.mock("@/components/org/org-export-dialog", () => ({
  OrgExportDialog: () => null,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...rest }: React.ComponentProps<"button">) => (
    <button {...rest}>{children}</button>
  ),
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
