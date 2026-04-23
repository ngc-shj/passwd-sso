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

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockFetch, mockToast, mockUseTenantRole, mockFilterMembers } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockToast: { error: vi.fn(), success: vi.fn() },
  mockUseTenantRole: vi.fn(),
  mockFilterMembers: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("sonner", () => ({
  toast: mockToast,
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

vi.mock("@/hooks/use-tenant-role", () => ({
  useTenantRole: () => mockUseTenantRole(),
}));

vi.mock("@/lib/filter-members", () => ({
  filterMembers: (...args: unknown[]) => mockFilterMembers(...args),
}));

vi.mock("@/components/member-info", () => ({
  MemberInfo: ({
    name,
    email,
    nameExtra,
  }: {
    name: string | null;
    email: string | null;
    nameExtra?: ReactNode;
  }) => (
    <div data-testid="member-info">
      <span data-testid="member-name">{name ?? email}</span>
      <span data-testid="member-email">{email}</span>
      {nameExtra && <span data-testid="member-extra">{nameExtra}</span>}
    </div>
  ),
}));

vi.mock("@/components/settings/security/tenant-vault-reset-button", () => ({
  TenantVaultResetButton: ({
    userId,
    disabled,
  }: {
    userId: string;
    disabled?: boolean;
    memberName?: string;
    onSuccess?: () => void;
  }) => (
    <button
      data-testid={`vault-reset-${userId}`}
      disabled={disabled}
    >
      VaultReset
    </button>
  ),
}));

vi.mock("@/components/settings/security/tenant-reset-history-dialog", () => ({
  TenantResetHistoryDialog: ({
    userId,
    pendingResets,
  }: {
    userId: string;
    memberName?: string;
    pendingResets?: number;
    onRevoke?: () => void;
  }) => (
    <button data-testid={`reset-history-${userId}`}>
      History({pendingResets ?? 0})
    </button>
  ),
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: ReactNode }) => (
    <div data-testid="card">{children}</div>
  ),
  CardContent: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div data-testid="card-content" className={className}>{children}</div>
  ),
  CardHeader: ({ children }: { children: ReactNode }) => (
    <div data-testid="card-header">{children}</div>
  ),
  CardTitle: ({ children }: { children: ReactNode }) => (
    <h2 data-testid="card-title">{children}</h2>
  ),
  CardDescription: ({ children }: { children: ReactNode }) => (
    <p data-testid="card-description">{children}</p>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({
    children,
    variant,
    className,
  }: {
    children: ReactNode;
    variant?: string;
    className?: string;
  }) => (
    <span data-testid="badge" data-variant={variant} className={className}>
      {children}
    </span>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input data-testid="search-input" {...props} />
  ),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: ReactNode;
    value?: string;
    onValueChange?: (v: string) => void;
  }) => (
    <div data-testid="select" data-value={value}>
      {/* Render children, and expose a change trigger for testing */}
      {children}
      <button
        data-testid={`select-change-${value}`}
        onClick={() => onValueChange?.("ADMIN")}
      >
        ChangeRole
      </button>
    </div>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => (
    <div data-testid="select-trigger">{children}</div>
  ),
  SelectValue: () => <span data-testid="select-value" />,
  SelectContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="select-content">{children}</div>
  ),
  SelectItem: ({
    children,
    value,
  }: {
    children: ReactNode;
    value: string;
  }) => <div data-testid={`select-item-${value}`}>{children}</div>,
}));

vi.mock("lucide-react", () => ({
  Loader2: () => <span data-testid="loader2" />,
  Search: () => <span data-testid="search-icon" />,
  Users: () => <span data-testid="users-icon" />,
}));

// ---------------------------------------------------------------------------
// Import SUT after mocks
// ---------------------------------------------------------------------------
import { TenantMembersCard } from "./tenant-members-card";

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------
function makeMember(overrides: Partial<{
  id: string;
  userId: string;
  role: string;
  deactivatedAt: string | null;
  scimManaged: boolean;
  name: string | null;
  email: string | null;
  image: string | null;
  pendingResets: number;
}> = {}) {
  return {
    id: "mem-1",
    userId: "user-1",
    role: "MEMBER",
    deactivatedAt: null,
    scimManaged: false,
    name: "Alice Smith",
    email: "alice@example.com",
    image: null,
    pendingResets: 0,
    ...overrides,
  };
}

/** Set up the common fetch mock for an admin/owner. */
function setupAsFetchReady({
  members = [makeMember()],
  currentUserId = "current-user-99",
}: {
  members?: ReturnType<typeof makeMember>[];
  currentUserId?: string;
} = {}) {
  mockFetch.mockImplementation((url: string) => {
    if (url === "/api/auth/session") {
      return Promise.resolve({
        json: () => Promise.resolve({ user: { id: currentUserId } }),
      });
    }
    if (url === "/api/tenant/members") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(members),
      });
    }
    // Default PUT handler
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("TenantMembersCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: pass-through filter
    mockFilterMembers.mockImplementation(
      (members: unknown[], _query: string) => members,
    );
  });

  // -------------------------------------------------------------------------
  // 1. Loading state
  // -------------------------------------------------------------------------
  describe("loading state", () => {
    it("shows spinner while roleLoading is true", async () => {
      mockUseTenantRole.mockReturnValue({
        role: null,
        isAdmin: false,
        loading: true,
      });
      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({ user: { id: "u1" } }),
      });

      await act(async () => {
        render(<TenantMembersCard />);
      });

      expect(screen.getByTestId("loader2")).toBeInTheDocument();
      expect(screen.getByTestId("card")).toBeInTheDocument();
    });

    it("shows spinner while data is loading (roleLoading=false, data loading)", async () => {
      // isAdmin=true but the members fetch hasn't resolved yet
      let resolveMembersJson!: (v: unknown) => void;
      const pendingJson = new Promise((r) => { resolveMembersJson = r; });

      mockUseTenantRole.mockReturnValue({
        role: "ADMIN",
        isAdmin: true,
        loading: false,
      });
      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/auth/session") {
          return Promise.resolve({ json: () => Promise.resolve({ user: { id: "u1" } }) });
        }
        // Intentionally never resolves for this test
        return Promise.resolve({ ok: true, json: () => pendingJson });
      });

      await act(async () => {
        render(<TenantMembersCard />);
      });

      expect(screen.getByTestId("loader2")).toBeInTheDocument();

      // Cleanup
      resolveMembersJson([]);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Non-admin returns null
  // -------------------------------------------------------------------------
  it("renders nothing when user is not admin", async () => {
    mockUseTenantRole.mockReturnValue({
      role: "MEMBER",
      isAdmin: false,
      loading: false,
    });
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ user: { id: "u1" } }),
    });

    const { container } = await act(async () =>
      render(<TenantMembersCard />),
    );

    await waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Empty state
  // -------------------------------------------------------------------------
  it("shows noMembers when there are no members", async () => {
    mockUseTenantRole.mockReturnValue({
      role: "ADMIN",
      isAdmin: true,
      loading: false,
    });
    setupAsFetchReady({ members: [] });

    await act(async () => {
      render(<TenantMembersCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noMembers")).toBeInTheDocument();
    });
    // Search box should NOT appear when no members
    expect(screen.queryByTestId("search-input")).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // 4. Member list rendering
  // -------------------------------------------------------------------------
  it("renders member list with MemberInfo components", async () => {
    mockUseTenantRole.mockReturnValue({
      role: "ADMIN",
      isAdmin: true,
      loading: false,
    });
    setupAsFetchReady({
      members: [
        makeMember({ id: "mem-1", userId: "u-1", name: "Alice", email: "alice@example.com" }),
        makeMember({ id: "mem-2", userId: "u-2", name: "Bob", email: "bob@example.com" }),
      ],
    });

    await act(async () => {
      render(<TenantMembersCard />);
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("member-info")).toHaveLength(2);
    });

    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("renders card title and description", async () => {
    mockUseTenantRole.mockReturnValue({
      role: "ADMIN",
      isAdmin: true,
      loading: false,
    });
    setupAsFetchReady({ members: [] });

    await act(async () => {
      render(<TenantMembersCard />);
    });

    await waitFor(() => {
      expect(screen.getByTestId("card-title")).toHaveTextContent("membersTitle");
    });
    expect(screen.getByTestId("card-description")).toHaveTextContent("membersDescription");
  });

  // -------------------------------------------------------------------------
  // 5. Search filtering
  // -------------------------------------------------------------------------
  it("passes searchQuery to filterMembers and renders filtered results", async () => {
    const alice = makeMember({ id: "mem-1", userId: "u-1", name: "Alice", email: "alice@example.com" });
    const bob = makeMember({ id: "mem-2", userId: "u-2", name: "Bob", email: "bob@example.com" });

    mockUseTenantRole.mockReturnValue({
      role: "ADMIN",
      isAdmin: true,
      loading: false,
    });
    setupAsFetchReady({ members: [alice, bob] });

    // Filter returns only Alice
    mockFilterMembers.mockImplementation(
      (members: typeof alice[], query: string) =>
        query === "alice" ? members.filter((m) => m.name === "Alice") : members,
    );

    await act(async () => {
      render(<TenantMembersCard />);
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("member-info")).toHaveLength(2);
    });

    const input = screen.getByTestId("search-input");
    fireEvent.change(input, { target: { value: "alice" } });

    await waitFor(() => {
      expect(mockFilterMembers).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ name: "Alice" })]),
        "alice",
      );
      expect(screen.getAllByTestId("member-info")).toHaveLength(1);
    });

    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.queryByText("Bob")).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // 6. No matching members
  // -------------------------------------------------------------------------
  it("shows noMatchingMembers when filterMembers returns empty array", async () => {
    mockUseTenantRole.mockReturnValue({
      role: "ADMIN",
      isAdmin: true,
      loading: false,
    });
    setupAsFetchReady({
      members: [makeMember({ id: "mem-1", userId: "u-1", name: "Alice", email: "alice@example.com" })],
    });

    // Filter returns nothing
    mockFilterMembers.mockReturnValue([]);

    await act(async () => {
      render(<TenantMembersCard />);
    });

    await waitFor(() => {
      // Search input should be visible because members.length > 0
      expect(screen.getByTestId("search-input")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("noMatchingMembers")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("member-info")).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // 7. Role change: success
  // -------------------------------------------------------------------------
  it("calls PUT API, shows success toast, and refetches on role change", async () => {
    const member = makeMember({
      id: "mem-1",
      userId: "user-member",
      role: "MEMBER",
      scimManaged: false,
    });

    mockUseTenantRole.mockReturnValue({
      role: "OWNER",
      isAdmin: true,
      loading: false,
    });
    setupAsFetchReady({
      members: [member],
      currentUserId: "current-owner",
    });

    // canChangeRole = true for OWNER acting on non-self, non-deactivated, non-OWNER, non-scimManaged
    // Select is rendered for this member
    await act(async () => {
      render(<TenantMembersCard />);
    });

    await waitFor(() => {
      expect(screen.getByTestId("member-info")).toBeInTheDocument();
    });

    // Simulate a role change via the select change button (value=MEMBER → ADMIN)
    const changeButton = screen.getByTestId("select-change-MEMBER");
    await act(async () => {
      fireEvent.click(changeButton);
    });

    await waitFor(() => {
      const putCalls = mockFetch.mock.calls.filter(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          c[0].includes("user-member") &&
          (c[1] as { method?: string })?.method === "PUT",
      );
      expect(putCalls).toHaveLength(1);
      const body = JSON.parse((putCalls[0][1] as { body: string }).body);
      expect(body.role).toBe("ADMIN");
    });

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith("roleChanged");
    });

    // Verify fetchMembers was called again (GET /api/tenant/members called twice: initial + refetch)
    const membersFetchCalls = mockFetch.mock.calls.filter(
      (c: unknown[]) => c[0] === "/api/tenant/members",
    );
    expect(membersFetchCalls.length).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // 8. Role change error: 409 (scimManaged conflict)
  // -------------------------------------------------------------------------
  it("shows scimManagedRoleError toast on 409 response", async () => {
    const member = makeMember({
      id: "mem-1",
      userId: "user-member",
      role: "MEMBER",
      scimManaged: false,
    });

    mockUseTenantRole.mockReturnValue({
      role: "OWNER",
      isAdmin: true,
      loading: false,
    });

    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/auth/session") {
        return Promise.resolve({ json: () => Promise.resolve({ user: { id: "current-owner" } }) });
      }
      if (url === "/api/tenant/members" && (!init?.method || init.method === "GET")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([member]) });
      }
      // PUT returns 409
      return Promise.resolve({ ok: false, status: 409 });
    });

    await act(async () => {
      render(<TenantMembersCard />);
    });

    await waitFor(() => {
      expect(screen.getByTestId("member-info")).toBeInTheDocument();
    });

    const changeButton = screen.getByTestId("select-change-MEMBER");
    await act(async () => {
      fireEvent.click(changeButton);
    });

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("scimManagedRoleError");
    });
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 9. Role change error: other (non-409 non-ok)
  // -------------------------------------------------------------------------
  it("shows roleChangeFailed toast on non-409 error response", async () => {
    const member = makeMember({
      id: "mem-1",
      userId: "user-member",
      role: "MEMBER",
      scimManaged: false,
    });

    mockUseTenantRole.mockReturnValue({
      role: "OWNER",
      isAdmin: true,
      loading: false,
    });

    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/auth/session") {
        return Promise.resolve({ json: () => Promise.resolve({ user: { id: "current-owner" } }) });
      }
      if (url === "/api/tenant/members" && (!init?.method || init.method === "GET")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([member]) });
      }
      return Promise.resolve({ ok: false, status: 500 });
    });

    await act(async () => {
      render(<TenantMembersCard />);
    });

    await waitFor(() => {
      expect(screen.getByTestId("member-info")).toBeInTheDocument();
    });

    const changeButton = screen.getByTestId("select-change-MEMBER");
    await act(async () => {
      fireEvent.click(changeButton);
    });

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("roleChangeFailed");
    });
  });

  // -------------------------------------------------------------------------
  // 9b. Role change error: network exception
  // -------------------------------------------------------------------------
  it("shows roleChangeFailed toast on fetch exception", async () => {
    const member = makeMember({
      id: "mem-1",
      userId: "user-member",
      role: "MEMBER",
      scimManaged: false,
    });

    mockUseTenantRole.mockReturnValue({
      role: "OWNER",
      isAdmin: true,
      loading: false,
    });

    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/auth/session") {
        return Promise.resolve({ json: () => Promise.resolve({ user: { id: "current-owner" } }) });
      }
      if (url === "/api/tenant/members" && (!init?.method || init.method === "GET")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([member]) });
      }
      return Promise.reject(new Error("Network error"));
    });

    await act(async () => {
      render(<TenantMembersCard />);
    });

    await waitFor(() => {
      expect(screen.getByTestId("member-info")).toBeInTheDocument();
    });

    const changeButton = screen.getByTestId("select-change-MEMBER");
    await act(async () => {
      fireEvent.click(changeButton);
    });

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("roleChangeFailed");
    });
  });

  // -------------------------------------------------------------------------
  // 10. canChangeRole logic
  // -------------------------------------------------------------------------
  describe("canChangeRole logic", () => {
    const setupOwner = (members: ReturnType<typeof makeMember>[]) => {
      mockUseTenantRole.mockReturnValue({
        role: "OWNER",
        isAdmin: true,
        loading: false,
      });
      setupAsFetchReady({ members, currentUserId: "owner-id" });
    };

    it("shows Select for owner acting on non-self non-deactivated MEMBER", async () => {
      const member = makeMember({
        id: "mem-1",
        userId: "other-user",
        role: "MEMBER",
        deactivatedAt: null,
        scimManaged: false,
      });
      setupOwner([member]);

      await act(async () => { render(<TenantMembersCard />); });
      await waitFor(() => expect(screen.getByTestId("member-info")).toBeInTheDocument());

      expect(screen.getByTestId("select")).toBeInTheDocument();
    });

    it("hides Select for self (isSelf=true)", async () => {
      const selfMember = makeMember({
        id: "mem-self",
        userId: "owner-id",  // same as currentUserId
        role: "MEMBER",
        deactivatedAt: null,
        scimManaged: false,
      });
      setupOwner([selfMember]);

      await act(async () => { render(<TenantMembersCard />); });
      await waitFor(() => expect(screen.getByTestId("member-info")).toBeInTheDocument());

      expect(screen.queryByTestId("select")).not.toBeInTheDocument();
    });

    it("hides Select for deactivated member", async () => {
      const member = makeMember({
        id: "mem-1",
        userId: "other-user",
        role: "MEMBER",
        deactivatedAt: "2025-01-01T00:00:00Z",
        scimManaged: false,
      });
      setupOwner([member]);

      await act(async () => { render(<TenantMembersCard />); });
      await waitFor(() => expect(screen.getByTestId("member-info")).toBeInTheDocument());

      expect(screen.queryByTestId("select")).not.toBeInTheDocument();
    });

    it("hides Select for member with OWNER role", async () => {
      const ownerMember = makeMember({
        id: "mem-owner2",
        userId: "other-owner",
        role: "OWNER",
        deactivatedAt: null,
        scimManaged: false,
      });
      setupOwner([ownerMember]);

      await act(async () => { render(<TenantMembersCard />); });
      await waitFor(() => expect(screen.getByTestId("member-info")).toBeInTheDocument());

      expect(screen.queryByTestId("select")).not.toBeInTheDocument();
    });

    it("hides Select for SCIM-managed member", async () => {
      const member = makeMember({
        id: "mem-scim",
        userId: "other-user",
        role: "MEMBER",
        deactivatedAt: null,
        scimManaged: true,
      });
      setupOwner([member]);

      await act(async () => { render(<TenantMembersCard />); });
      await waitFor(() => expect(screen.getByTestId("member-info")).toBeInTheDocument());

      expect(screen.queryByTestId("select")).not.toBeInTheDocument();
    });

    it("hides Select when acting user is ADMIN (not OWNER)", async () => {
      const member = makeMember({
        id: "mem-1",
        userId: "other-user",
        role: "MEMBER",
        deactivatedAt: null,
        scimManaged: false,
      });
      mockUseTenantRole.mockReturnValue({
        role: "ADMIN",
        isAdmin: true,
        loading: false,
      });
      setupAsFetchReady({ members: [member], currentUserId: "admin-id" });

      await act(async () => { render(<TenantMembersCard />); });
      await waitFor(() => expect(screen.getByTestId("member-info")).toBeInTheDocument());

      expect(screen.queryByTestId("select")).not.toBeInTheDocument();
    });

    it("shows role badge when canChangeRole is false", async () => {
      // Self member: canChangeRole=false, badge should appear
      const selfMember = makeMember({
        id: "mem-self",
        userId: "owner-id",
        role: "OWNER",
        deactivatedAt: null,
        scimManaged: false,
      });
      setupOwner([selfMember]);

      await act(async () => { render(<TenantMembersCard />); });
      await waitFor(() => expect(screen.getByTestId("member-info")).toBeInTheDocument());

      const badges = screen.getAllByTestId("badge");
      const roleBadge = badges.find((b) => b.textContent === "roleOwner");
      expect(roleBadge).toBeTruthy();
    });

    it("hides role badge when canChangeRole is true (Select shown instead)", async () => {
      const member = makeMember({
        id: "mem-1",
        userId: "other-user",
        role: "MEMBER",
        deactivatedAt: null,
        scimManaged: false,
      });
      setupOwner([member]);

      await act(async () => { render(<TenantMembersCard />); });
      await waitFor(() => expect(screen.getByTestId("select")).toBeInTheDocument());

      // The MEMBER role badge should NOT appear since the Select is shown
      const badges = screen.queryAllByTestId("badge");
      const roleBadge = badges.find((b) => b.textContent === "roleMember");
      expect(roleBadge).toBeFalsy();
    });
  });

  // -------------------------------------------------------------------------
  // 11. Deactivated member: opacity-50 class
  // -------------------------------------------------------------------------
  it("applies opacity-50 class to deactivated member row", async () => {
    const deactivated = makeMember({
      id: "mem-deact",
      userId: "deact-user",
      role: "MEMBER",
      deactivatedAt: "2025-01-01T00:00:00Z",
      name: "Deactivated User",
      email: "deact@example.com",
    });

    mockUseTenantRole.mockReturnValue({
      role: "ADMIN",
      isAdmin: true,
      loading: false,
    });
    setupAsFetchReady({ members: [deactivated] });

    await act(async () => {
      render(<TenantMembersCard />);
    });

    await waitFor(() => {
      expect(screen.getByTestId("member-info")).toBeInTheDocument();
    });

    // Find the row container wrapping the member
    const memberInfoEl = screen.getByTestId("member-info");
    const row = memberInfoEl.closest("[class*='opacity-50']") ??
      memberInfoEl.parentElement?.parentElement;
    expect(row?.className).toContain("opacity-50");
  });

  it("shows deactivated badge for deactivated member", async () => {
    const deactivated = makeMember({
      id: "mem-deact",
      userId: "deact-user",
      role: "MEMBER",
      deactivatedAt: "2025-01-01T00:00:00Z",
    });

    mockUseTenantRole.mockReturnValue({
      role: "ADMIN",
      isAdmin: true,
      loading: false,
    });
    setupAsFetchReady({ members: [deactivated] });

    await act(async () => {
      render(<TenantMembersCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("deactivated")).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // 12. Fetch error handling
  // -------------------------------------------------------------------------
  it("shows empty state when fetchMembers throws", async () => {
    mockUseTenantRole.mockReturnValue({
      role: "ADMIN",
      isAdmin: true,
      loading: false,
    });
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/auth/session") {
        return Promise.resolve({ json: () => Promise.resolve({ user: { id: "u1" } }) });
      }
      return Promise.reject(new Error("Network error"));
    });

    await act(async () => {
      render(<TenantMembersCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noMembers")).toBeInTheDocument();
    });
  });

  it("shows empty state when fetchMembers returns non-ok response", async () => {
    mockUseTenantRole.mockReturnValue({
      role: "ADMIN",
      isAdmin: true,
      loading: false,
    });
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/auth/session") {
        return Promise.resolve({ json: () => Promise.resolve({ user: { id: "u1" } }) });
      }
      return Promise.resolve({ ok: false, status: 500 });
    });

    await act(async () => {
      render(<TenantMembersCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noMembers")).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // 13. currentUserId from session
  // -------------------------------------------------------------------------
  it("fetches current user id from auth session endpoint", async () => {
    mockUseTenantRole.mockReturnValue({
      role: "ADMIN",
      isAdmin: true,
      loading: false,
    });
    setupAsFetchReady({ members: [], currentUserId: "session-user-42" });

    await act(async () => {
      render(<TenantMembersCard />);
    });

    await waitFor(() => {
      const sessionCalls = mockFetch.mock.calls.filter(
        (c: unknown[]) => c[0] === "/api/auth/session",
      );
      expect(sessionCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("handles session fetch failure gracefully (currentUserId stays null)", async () => {
    mockUseTenantRole.mockReturnValue({
      role: "ADMIN",
      isAdmin: true,
      loading: false,
    });
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/auth/session") {
        return Promise.reject(new Error("session fetch failed"));
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    await act(async () => {
      render(<TenantMembersCard />);
    });

    // Should render without crash
    await waitFor(() => {
      expect(screen.getByText("noMembers")).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // 14. VaultResetButton disabled state (canReset logic)
  // -------------------------------------------------------------------------
  it("disables VaultResetButton for self", async () => {
    const selfMember = makeMember({
      id: "mem-self",
      userId: "owner-id",
      role: "MEMBER",
    });

    mockUseTenantRole.mockReturnValue({
      role: "OWNER",
      isAdmin: true,
      loading: false,
    });
    setupAsFetchReady({ members: [selfMember], currentUserId: "owner-id" });

    await act(async () => {
      render(<TenantMembersCard />);
    });

    await waitFor(() => {
      expect(screen.getByTestId("vault-reset-owner-id")).toBeInTheDocument();
    });

    expect(screen.getByTestId("vault-reset-owner-id")).toBeDisabled();
  });

  it("enables VaultResetButton for lower-level non-self non-deactivated member", async () => {
    const member = makeMember({
      id: "mem-1",
      userId: "other-user",
      role: "MEMBER",  // MEMBER level=10 < OWNER level=30
      deactivatedAt: null,
    });

    mockUseTenantRole.mockReturnValue({
      role: "OWNER",
      isAdmin: true,
      loading: false,
    });
    setupAsFetchReady({ members: [member], currentUserId: "owner-id" });

    await act(async () => {
      render(<TenantMembersCard />);
    });

    await waitFor(() => {
      expect(screen.getByTestId("vault-reset-other-user")).toBeInTheDocument();
    });

    expect(screen.getByTestId("vault-reset-other-user")).not.toBeDisabled();
  });

  // -------------------------------------------------------------------------
  // 15. Multiple members
  // -------------------------------------------------------------------------
  it("renders TenantResetHistoryDialog and TenantVaultResetButton for each member", async () => {
    mockUseTenantRole.mockReturnValue({
      role: "ADMIN",
      isAdmin: true,
      loading: false,
    });
    setupAsFetchReady({
      members: [
        makeMember({ id: "m1", userId: "u1", name: "Alice", email: "a@e.com" }),
        makeMember({ id: "m2", userId: "u2", name: "Bob", email: "b@e.com" }),
      ],
    });

    await act(async () => {
      render(<TenantMembersCard />);
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("member-info")).toHaveLength(2);
    });

    expect(screen.getByTestId("reset-history-u1")).toBeInTheDocument();
    expect(screen.getByTestId("reset-history-u2")).toBeInTheDocument();
    expect(screen.getByTestId("vault-reset-u1")).toBeInTheDocument();
    expect(screen.getByTestId("vault-reset-u2")).toBeInTheDocument();
  });
});
