// @vitest-environment jsdom
/**
 * Sidebar — Folder CRUD integration tests
 *
 * Tests the Sidebar's folder create/edit/delete handlers, verifying that:
 *   - API error responses show translated toast messages via showApiError
 *   - Successful operations trigger data re-fetch
 *   - Delete failure clears the deleting state
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ── Hoisted mocks ──────────────────────────────────────────

const { mockToast, mockApiErrorToI18nKey, mockUseVaultContext } = vi.hoisted(() => ({
  mockToast: { error: vi.fn(), success: vi.fn() },
  mockApiErrorToI18nKey: vi.fn((code: unknown) =>
    typeof code === "string" ? code : "unknownError",
  ),
  mockUseVaultContext: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/api-error-codes", () => ({
  apiErrorToI18nKey: mockApiErrorToI18nKey,
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

// Capture the onSubmit callback passed to FolderDialog
let capturedFolderDialogProps: {
  open: boolean;
  onSubmit: (data: { name: string; parentId: string | null }) => Promise<void>;
  onOpenChange: (open: boolean) => void;
} | null = null;

vi.mock("@/components/folders/folder-dialog", () => ({
  FolderDialog: (props: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSubmit: (data: { name: string; parentId: string | null }) => Promise<void>;
  }) => {
    capturedFolderDialogProps = props;
    return props.open ? (
      <div data-testid="folder-dialog">folder-dialog</div>
    ) : null;
  },
}));

vi.mock("@/components/tags/tag-dialog", () => ({
  TagDialog: () => null,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/ja/dashboard",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string; onClick?: () => void }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

vi.mock("@/i18n/locale-utils", () => ({
  stripLocalePrefix: (p: string) => p.replace(/^\/[a-z]{2}/, ""),
}));

vi.mock("@/hooks/use-local-storage", () => ({
  useLocalStorage: (_key: string, initial: Record<string, boolean>) => [initial, vi.fn()],
}));

vi.mock("@/lib/dynamic-styles", () => ({
  getTagColorClass: () => "",
}));

vi.mock("@/hooks/use-vault-context", () => ({
  useVaultContext: (orgs: unknown[]) => mockUseVaultContext(orgs),
}));

// Stub heavy UI components
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    asChild,
    ...rest
  }: React.ComponentProps<"button"> & { asChild?: boolean }) => {
    // When asChild, render children directly (Link wrapping)
    if (asChild) return <>{children}</>;
    return (
      <button onClick={onClick} disabled={disabled} {...rest}>
        {children}
      </button>
    );
  },
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, ...rest }: React.ComponentProps<"span">) => <span {...rest}>{children}</span>,
}));

vi.mock("@/components/ui/separator", () => ({
  Separator: () => <hr />,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button onClick={onClick} role="menuitem">
      {children}
    </button>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// AlertDialog — capture delete confirmation action
vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open: boolean;
  }) => (open ? <div data-testid="delete-alert-dialog">{children}</div> : null),
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => (
    <button>{children}</button>
  ),
  AlertDialogAction: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button data-testid="confirm-delete" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("radix-ui", () => ({
  VisuallyHidden: {
    Root: ({ children }: { children: React.ReactNode }) => (
      <span style={{ display: "none" }}>{children}</span>
    ),
  },
}));

vi.mock("@/components/layout/vault-selector", () => ({
  VaultSelector: () => null,
}));

import { Sidebar } from "./sidebar";
import { within } from "@testing-library/react";

// ── Test helpers ─────────────────────────────────────────────

const FOLDERS_DATA = [
  { id: "f1", name: "Work", parentId: null, sortOrder: 0, entryCount: 2 },
];

const ORG_FOLDERS_DATA = [
  { id: "of1", name: "OrgWork", parentId: null, sortOrder: 0, entryCount: 3 },
];

/** Mock fetch for initial data loads returning folders and empty tags/orgs. */
function mockFetchSuccess(overrides?: {
  foldersData?: unknown[];
  orgsData?: unknown[];
  orgFoldersData?: unknown[];
  orgTagsData?: unknown[];
}) {
  const folders = overrides?.foldersData ?? FOLDERS_DATA;
  const orgsData = overrides?.orgsData ?? [];
  const orgFolders = overrides?.orgFoldersData ?? [];
  const orgTags = overrides?.orgTagsData ?? [];
  return vi.fn((url: string) => {
    if (url.includes("/api/tags") && !url.includes("/api/teams/")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
      });
    }
    if (url.includes("/api/folders") && !url.includes("/api/teams/")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(folders),
      });
    }
    // Org-specific sub-resource fetches (tags, folders)
    if (url.match(/\/api\/teams\/[^/]+\/tags/)) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(orgTags),
      });
    }
    if (url.match(/\/api\/teams\/[^/]+\/folders/)) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(orgFolders),
      });
    }
    if (url.includes("/api/teams")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(orgsData),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  }) as Mock;
}

/** Get the desktop sidebar (aside) to scope queries and avoid mobile duplicates. */
function getDesktopSidebar() {
  return document.querySelector("aside")!;
}

describe("Sidebar folder CRUD integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedFolderDialogProps = null;
    mockUseVaultContext.mockReturnValue({ type: "personal" });
  });

  // ── Create folder: API error shows toast ────────────────────

  it("shows translated toast on folder create failure (POST 409)", async () => {
    const fetchMock = mockFetchSuccess();
    globalThis.fetch = fetchMock;

    await act(async () => {
      render(<Sidebar open={false} onOpenChange={vi.fn()} />);
    });

    // Scope to desktop sidebar to avoid duplicate mobile elements
    const sidebar = within(getDesktopSidebar());

    // Open folder dialog via the "+" button
    const createBtn = sidebar.getByRole("menuitem", { name: "createFolder" });
    fireEvent.click(createBtn);

    // FolderDialog should now be open with captured props
    expect(capturedFolderDialogProps).not.toBeNull();
    expect(capturedFolderDialogProps!.open).toBe(true);

    // Configure fetch to fail for the POST
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.includes("/api/folders")) {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: () => Promise.resolve({ error: "FOLDER_ALREADY_EXISTS" }),
        });
      }
      // Still return success for GET refetches
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    // Call onSubmit (simulating FolderDialog submit)
    await expect(
      capturedFolderDialogProps!.onSubmit({ name: "Duplicate", parentId: null }),
    ).rejects.toThrow();

    expect(mockApiErrorToI18nKey).toHaveBeenCalledWith("FOLDER_ALREADY_EXISTS");
    expect(mockToast.error).toHaveBeenCalledWith("FOLDER_ALREADY_EXISTS");
  });

  // ── Edit folder: API error shows toast ──────────────────────

  it("shows translated toast on folder edit failure (PUT 400)", async () => {
    const fetchMock = mockFetchSuccess();
    globalThis.fetch = fetchMock;

    await act(async () => {
      render(<Sidebar open={false} onOpenChange={vi.fn()} />);
    });

    const sidebar = within(getDesktopSidebar());

    // Wait for folders to render
    await waitFor(() => {
      expect(sidebar.getByText("Work")).toBeInTheDocument();
    });

    // Click the edit menu item for the "Work" folder (scoped to desktop)
    const editButtons = sidebar.getAllByRole("menuitem").filter(
      (el) => el.textContent?.includes("edit"),
    );
    expect(editButtons.length).toBeGreaterThan(0);
    fireEvent.click(editButtons[0]);

    // FolderDialog should now be open in edit mode
    expect(capturedFolderDialogProps).not.toBeNull();
    expect(capturedFolderDialogProps!.open).toBe(true);

    // Configure fetch to fail for the PUT
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "PUT" && url.includes("/api/folders/")) {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({ error: "FOLDER_CIRCULAR_REFERENCE" }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    await expect(
      capturedFolderDialogProps!.onSubmit({ name: "Updated", parentId: "f1" }),
    ).rejects.toThrow();

    expect(mockApiErrorToI18nKey).toHaveBeenCalledWith("FOLDER_CIRCULAR_REFERENCE");
    expect(mockToast.error).toHaveBeenCalledWith("FOLDER_CIRCULAR_REFERENCE");
  });

  // ── Delete folder: API error shows toast ────────────────────

  it("shows translated toast on folder delete failure and clears dialog", async () => {
    const fetchMock = mockFetchSuccess();
    globalThis.fetch = fetchMock;

    await act(async () => {
      render(<Sidebar open={false} onOpenChange={vi.fn()} />);
    });

    const sidebar = within(getDesktopSidebar());

    // Wait for folders to render
    await waitFor(() => {
      expect(sidebar.getByText("Work")).toBeInTheDocument();
    });

    // Click the delete menu item for the "Work" folder
    const deleteButtons = sidebar.getAllByRole("menuitem").filter(
      (el) => el.textContent?.includes("deleteFolder"),
    );
    expect(deleteButtons.length).toBeGreaterThan(0);
    fireEvent.click(deleteButtons[0]);

    // Delete AlertDialog should now be open
    expect(screen.getByTestId("delete-alert-dialog")).toBeInTheDocument();

    // Configure fetch to fail for the DELETE
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "DELETE" && url.includes("/api/folders/")) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: "INTERNAL_SERVER_ERROR" }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    // Click confirm delete
    const confirmBtn = screen.getByTestId("confirm-delete");
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mockApiErrorToI18nKey).toHaveBeenCalledWith("INTERNAL_SERVER_ERROR");
      expect(mockToast.error).toHaveBeenCalledWith("INTERNAL_SERVER_ERROR");
    });

    // Delete dialog should be closed (deletingFolder set to null)
    await waitFor(() => {
      expect(screen.queryByTestId("delete-alert-dialog")).not.toBeInTheDocument();
    });
  });

  // ── Successful create triggers data re-fetch ────────────────

  it("re-fetches folders after successful create", async () => {
    const fetchMock = mockFetchSuccess();
    globalThis.fetch = fetchMock;

    await act(async () => {
      render(<Sidebar open={false} onOpenChange={vi.fn()} />);
    });

    const sidebar = within(getDesktopSidebar());

    // Open folder dialog
    const createBtn = sidebar.getByRole("menuitem", { name: "createFolder" });
    fireEvent.click(createBtn);

    // Reset call count to track only the post-submit re-fetch
    const callCountBefore = fetchMock.mock.calls.length;

    // Configure fetch to succeed for the POST
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.includes("/api/folders")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: "f2", name: "New Folder" }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    await capturedFolderDialogProps!.onSubmit({ name: "New Folder", parentId: null });

    // fetchData() should have been called (GET /api/folders, /api/tags, /api/teams)
    await waitFor(() => {
      const postSubmitCalls = fetchMock.mock.calls.slice(callCountBefore);
      const getFoldersCalls = postSubmitCalls.filter(
        (c: [string, RequestInit?]) => c[0].includes("/api/folders") && !c[1]?.method,
      );
      expect(getFoldersCalls.length).toBeGreaterThan(0);
    });
  });

  // ── showApiError fallback for unparseable response ──────────

  it("shows unknownError toast when API response is not JSON", async () => {
    const fetchMock = mockFetchSuccess();
    globalThis.fetch = fetchMock;

    await act(async () => {
      render(<Sidebar open={false} onOpenChange={vi.fn()} />);
    });

    const sidebar = within(getDesktopSidebar());
    const createBtn = sidebar.getByRole("menuitem", { name: "createFolder" });
    fireEvent.click(createBtn);

    // Configure fetch to fail with non-JSON response
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.includes("/api/folders")) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.reject(new Error("not JSON")),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    await expect(
      capturedFolderDialogProps!.onSubmit({ name: "Test", parentId: null }),
    ).rejects.toThrow();

    expect(mockToast.error).toHaveBeenCalledWith("unknownError");
  });
});

// ── Org folder CRUD / permission tests ──────────────────────────
// Org folders are now inside the org's expanded submenu (Organizations section).
// Tests must toggle the org submenu open before checking folder UI.

describe("Sidebar org folder CRUD integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedFolderDialogProps = null;
    mockUseVaultContext.mockReturnValue({
      type: "org",
      orgId: "org-1",
      orgName: "Acme Corp",
      orgRole: "OWNER",
    });
  });

  /** Open org submenu by clicking the toggle button, then wait for folders. */
  async function openOrgSubmenu(sidebar: ReturnType<typeof within>, orgId: string) {
    const toggle = sidebar.queryByRole("button", { name: `toggle-${orgId}` });
    if (toggle) fireEvent.click(toggle);
  }

  it("shows org folder create button for OWNER role", async () => {
    const fetchMock = mockFetchSuccess({
      orgsData: [{ id: "org-1", name: "Acme Corp", slug: "acme", role: "OWNER" }],
      orgFoldersData: ORG_FOLDERS_DATA,
    });
    globalThis.fetch = fetchMock;

    await act(async () => {
      render(<Sidebar open={false} onOpenChange={vi.fn()} />);
    });

    const sidebar = within(getDesktopSidebar());
    await openOrgSubmenu(sidebar, "org-1");

    // Wait for org folder to appear inside the submenu
    await waitFor(() => {
      expect(sidebar.getByText("OrgWork")).toBeInTheDocument();
    });

    // Org folder create button with org-specific aria-label
    const orgCreateBtn = sidebar.getByRole("menuitem", { name: "createFolder" });
    expect(orgCreateBtn).toBeInTheDocument();
  });

  it("shows org folder create button for ADMIN role", async () => {
    const fetchMock = mockFetchSuccess({
      orgsData: [{ id: "org-1", name: "Acme Corp", slug: "acme", role: "ADMIN" }],
      orgFoldersData: ORG_FOLDERS_DATA,
    });
    globalThis.fetch = fetchMock;

    await act(async () => {
      render(<Sidebar open={false} onOpenChange={vi.fn()} />);
    });

    const sidebar = within(getDesktopSidebar());
    await openOrgSubmenu(sidebar, "org-1");

    await waitFor(() => {
      expect(sidebar.getByText("OrgWork")).toBeInTheDocument();
    });

    const orgCreateBtn = sidebar.getByRole("menuitem", { name: "createFolder" });
    expect(orgCreateBtn).toBeInTheDocument();
  });

  it("shows enabled org folder create button for MEMBER role", async () => {
    const fetchMock = mockFetchSuccess({
      orgsData: [{ id: "org-1", name: "Acme Corp", slug: "acme", role: "MEMBER" }],
      orgFoldersData: ORG_FOLDERS_DATA,
    });
    globalThis.fetch = fetchMock;

    await act(async () => {
      render(<Sidebar open={false} onOpenChange={vi.fn()} />);
    });

    const sidebar = within(getDesktopSidebar());
    await openOrgSubmenu(sidebar, "org-1");

    await waitFor(() => {
      expect(sidebar.getByText("OrgWork")).toBeInTheDocument();
    });

    const orgCreateBtn = sidebar.getByRole("menuitem", { name: "createFolder" });
    expect(orgCreateBtn).toBeEnabled();
  });

  it("shows edit/delete menu for org folders when role is MEMBER", async () => {
    const fetchMock = mockFetchSuccess({
      orgsData: [{ id: "org-1", name: "Acme Corp", slug: "acme", role: "MEMBER" }],
      orgFoldersData: ORG_FOLDERS_DATA,
    });
    globalThis.fetch = fetchMock;

    await act(async () => {
      render(<Sidebar open={false} onOpenChange={vi.fn()} />);
    });

    const sidebar = within(getDesktopSidebar());
    await openOrgSubmenu(sidebar, "org-1");

    await waitFor(() => {
      expect(sidebar.getByText("OrgWork")).toBeInTheDocument();
    });

    const orgMenuButton = sidebar.getByRole("button", { name: "OrgWork menu" });
    expect(orgMenuButton).toBeInTheDocument();
  });

  it("shows edit/delete menu for org folders when role is OWNER", async () => {
    const fetchMock = mockFetchSuccess({
      orgsData: [{ id: "org-1", name: "Acme Corp", slug: "acme", role: "OWNER" }],
      orgFoldersData: ORG_FOLDERS_DATA,
    });
    globalThis.fetch = fetchMock;

    await act(async () => {
      render(<Sidebar open={false} onOpenChange={vi.fn()} />);
    });

    const sidebar = within(getDesktopSidebar());
    await openOrgSubmenu(sidebar, "org-1");

    await waitFor(() => {
      expect(sidebar.getByText("OrgWork")).toBeInTheDocument();
    });

    const orgMenuButton = sidebar.getByRole("button", { name: "OrgWork menu" });
    expect(orgMenuButton).toBeInTheDocument();
  });

  it("calls org API endpoint when creating org folder", async () => {
    const fetchMock = mockFetchSuccess({
      orgsData: [{ id: "org-1", name: "Acme Corp", slug: "acme", role: "OWNER" }],
      orgFoldersData: ORG_FOLDERS_DATA,
    });
    globalThis.fetch = fetchMock;

    await act(async () => {
      render(<Sidebar open={false} onOpenChange={vi.fn()} />);
    });

    const sidebar = within(getDesktopSidebar());
    await openOrgSubmenu(sidebar, "org-1");

    await waitFor(() => {
      expect(sidebar.getByText("OrgWork")).toBeInTheDocument();
    });

    // Click the org folder create button
    const orgCreateBtn = sidebar.getByRole("menuitem", { name: "createFolder" });
    fireEvent.click(orgCreateBtn);

    expect(capturedFolderDialogProps).not.toBeNull();
    expect(capturedFolderDialogProps!.open).toBe(true);

    // Configure fetch to succeed for the POST
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: "of2", name: "New Org Folder" }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    await act(async () => {
      await capturedFolderDialogProps!.onSubmit({ name: "New Org Folder", parentId: null });
    });

    // Verify the POST was sent to the org folders endpoint
    const postCalls = fetchMock.mock.calls.filter(
      (c: [string, RequestInit?]) => c[1]?.method === "POST",
    );
    expect(postCalls.length).toBe(1);
    expect(postCalls[0][0]).toContain("/api/teams/org-1/folders");
  });

  it("shows org folder create button even when org has zero folders (OWNER)", async () => {
    const fetchMock = mockFetchSuccess({
      orgsData: [{ id: "org-1", name: "Acme Corp", slug: "acme", role: "OWNER" }],
      orgFoldersData: [], // No folders yet
    });
    globalThis.fetch = fetchMock;

    await act(async () => {
      render(<Sidebar open={false} onOpenChange={vi.fn()} />);
    });

    const sidebar = within(getDesktopSidebar());
    await openOrgSubmenu(sidebar, "org-1");

    // Even with zero org folders, OWNER should see the create button inside org submenu
    await waitFor(() => {
      expect(sidebar.getByRole("menuitem", { name: "createFolder" })).toBeInTheDocument();
    });
  });

  it("shows enabled org folder create button when MEMBER and org has zero folders", async () => {
    const fetchMock = mockFetchSuccess({
      orgsData: [{ id: "org-1", name: "Acme Corp", slug: "acme", role: "MEMBER" }],
      orgFoldersData: [], // No folders
    });
    globalThis.fetch = fetchMock;

    await act(async () => {
      render(<Sidebar open={false} onOpenChange={vi.fn()} />);
    });

    const sidebar = within(getDesktopSidebar());
    await openOrgSubmenu(sidebar, "org-1");

    // Give time for async fetch to resolve
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // MEMBER can create folders, even when org has zero folders.
    const orgCreateBtn = sidebar.getByRole("menuitem", { name: "createFolder" });
    expect(orgCreateBtn).toBeEnabled();
  });
});
