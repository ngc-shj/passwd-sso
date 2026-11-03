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

const { mockFetch, mockToast, mockCanUsePasskeyRecovery, mockReauthenticateWithPasskey } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
  mockCanUsePasskeyRecovery: vi.fn(),
  mockReauthenticateWithPasskey: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
  useLocale: () => "en",
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

import "@/__tests__/helpers/passkey-reauth-mocks";

vi.mock("@/lib/auth/webauthn/can-use-passkey-recovery", () => ({
  canUsePasskeyRecovery: mockCanUsePasskeyRecovery,
}));

vi.mock("@/lib/auth/webauthn/passkey-reauth-client", () => ({
  reauthenticateWithPasskey: mockReauthenticateWithPasskey,
}));

// Dialog (Add Member) is not exercised by the step-up tests — mock it away so
// TeamAddFromTenantSection / TeamInviteByEmailSection don't need real wiring.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open?: boolean }) => (
    open ? <>{children}</> : null
  ),
  DialogContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogHeader: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogTitle: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTrigger: ({ children }: { children: ReactNode; asChild?: boolean }) => (
    <div data-testid="alert-trigger">{children}</div>
  ),
  AlertDialogContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="alert-content">{children}</div>
  ),
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  AlertDialogAction: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: () => void;
  }) => (
    <button data-testid="alert-action" onClick={onClick}>
      {children}
    </button>
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
      {children}
      <button
        data-testid={`select-change-${value}`}
        onClick={() => onValueChange?.("ADMIN")}
      >
        ChangeRole
      </button>
    </div>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span />,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <div data-testid={`select-item-${value}`}>{children}</div>
  ),
}));

import TeamMembersPage from "./page";

function makeMember(overrides: Partial<{
  id: string;
  userId: string;
  role: string;
  name: string | null;
  email: string | null;
  image: string | null;
  tenantName: string | null;
  pendingApproval: boolean;
  pendingTenantInactive: boolean;
}> = {}) {
  return {
    id: "mem-1",
    userId: "user-member",
    role: "MEMBER",
    name: "Alice",
    email: "alice@example.com",
    image: null,
    tenantName: null,
    ...overrides,
  };
}

function setupFetchReady({
  team = { id: "team-1", name: "Team One", slug: "team-one", description: null, role: "OWNER" },
  members = [makeMember()],
  invitations = [] as unknown[],
  currentUserId = "current-owner",
}: {
  team?: Record<string, unknown>;
  members?: ReturnType<typeof makeMember>[];
  invitations?: unknown[];
  currentUserId?: string;
} = {}) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url === "/api/auth/session") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ user: { id: currentUserId } }) });
    }
    if (url === "/api/teams/team-1" && (!init?.method || init.method === "GET")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(team) });
    }
    if (url === "/api/teams/team-1/members" && (!init?.method || init.method === "GET")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(members) });
    }
    if (url === "/api/teams/team-1/invitations") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(invitations) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

describe("TeamMembersPage (admin full-page, step-up denial)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
    mockReauthenticateWithPasskey.mockResolvedValue({ ok: true, verifiedAt: "2026-05-10T00:00:00Z" });
  });

  it("role change — opens RecentSessionRequiredDialog when SESSION_STEP_UP_REQUIRED is returned", async () => {
    const member = makeMember({ id: "mem-1", userId: "user-member", role: "MEMBER" });
    setupFetchReady({ members: [member] });

    // Override the PUT response with a step-up denial (GET responses stay as configured above).
    const baseImpl = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
        });
      }
      return baseImpl(url, init);
    });

    await act(async () => {
      render(<TeamMembersPage params={Promise.resolve({ teamId: "team-1" })} />);
    });

    await waitFor(() => {
      expect(screen.getByTestId("select-change-MEMBER")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("select-change-MEMBER"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("recent-session-dialog")).toBeInTheDocument();
    });
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("remove member — opens RecentSessionRequiredDialog when SESSION_STEP_UP_REQUIRED is returned", async () => {
    const member = makeMember({ id: "mem-1", userId: "user-member", role: "MEMBER" });
    setupFetchReady({ members: [member] });

    const baseImpl = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
        });
      }
      return baseImpl(url, init);
    });

    await act(async () => {
      render(<TeamMembersPage params={Promise.resolve({ teamId: "team-1" })} />);
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("alert-action").length).toBeGreaterThanOrEqual(1);
    });

    await act(async () => {
      fireEvent.click(screen.getAllByTestId("alert-action")[0]);
    });

    await waitFor(() => {
      expect(screen.getByTestId("recent-session-dialog")).toBeInTheDocument();
    });
    expect(mockToast.error).not.toHaveBeenCalled();
  });
});

describe("TeamMembersPage (SCIM pending admission, C5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
    mockReauthenticateWithPasskey.mockResolvedValue({ ok: true, verifiedAt: "2026-05-10T00:00:00Z" });
  });

  it("renders Approve/Reject for a pending row and not for an active one", async () => {
    const pending = makeMember({ id: "mem-pending", userId: "user-pending", role: "ADMIN", pendingApproval: true });
    const active = makeMember({ id: "mem-active", userId: "user-active", role: "MEMBER" });
    setupFetchReady({ members: [pending, active] });

    await act(async () => {
      render(<TeamMembersPage params={Promise.resolve({ teamId: "team-1" })} />);
    });

    await waitFor(() => {
      expect(screen.getByText("awaitingApprovalBadge")).toBeInTheDocument();
    });

    // Exactly one pending row — Approve appears once, Reject's trigger +
    // confirm-action share the same label so it appears twice.
    expect(screen.getAllByRole("button", { name: "approveButton" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "rejectButton" })).toHaveLength(2);

    // The active row keeps its role select + remove button, not approve/reject.
    expect(screen.getByTestId("select-change-MEMBER")).toBeInTheDocument();
  });

  it("states that an approved member's role can still change through SCIM, only while a request is pending", async () => {
    setupFetchReady({
      members: [makeMember({ id: "mem-pending", userId: "user-pending", role: "MEMBER", pendingApproval: true })],
    });
    await act(async () => {
      render(<TeamMembersPage params={Promise.resolve({ teamId: "team-1" })} />);
    });
    await waitFor(() => {
      expect(screen.getByText("approveRoleNote")).toBeInTheDocument();
    });
  });

  it("shows no role-change note when nothing is pending", async () => {
    setupFetchReady({ members: [makeMember({ id: "mem-active", userId: "user-active", role: "MEMBER" })] });
    await act(async () => {
      render(<TeamMembersPage params={Promise.resolve({ teamId: "team-1" })} />);
    });
    await waitFor(() => {
      expect(screen.getByTestId("select-change-MEMBER")).toBeInTheDocument();
    });
    expect(screen.queryByText("approveRoleNote")).not.toBeInTheDocument();
  });

  it("a pendingTenantInactive row renders Reject but not Approve", async () => {
    const pending = makeMember({
      id: "mem-pending", userId: "user-pending", role: "ADMIN",
      pendingApproval: true, pendingTenantInactive: true,
    });
    setupFetchReady({ members: [pending] });

    await act(async () => {
      render(<TeamMembersPage params={Promise.resolve({ teamId: "team-1" })} />);
    });

    await waitFor(() => {
      expect(screen.getByText("awaitingApprovalBadge")).toBeInTheDocument();
    });

    expect(screen.getByText("pendingTenantInactive")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "approveButton" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "rejectButton" })).toHaveLength(2);
  });

  it("Approve posts expectedRole equal to the shown role", async () => {
    const pending = makeMember({ id: "mem-pending", userId: "user-pending", role: "ADMIN", pendingApproval: true });
    setupFetchReady({ members: [pending] });

    await act(async () => {
      render(<TeamMembersPage params={Promise.resolve({ teamId: "team-1" })} />);
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "approveButton" })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "approveButton" }));
    });

    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find(
        (c) => c[0] === "/api/teams/team-1/members/mem-pending/approve",
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(body).toEqual({ expectedRole: "ADMIN" });
    });
  });

  it("approve — opens RecentSessionRequiredDialog when SESSION_STEP_UP_REQUIRED is returned", async () => {
    const pending = makeMember({ id: "mem-pending", userId: "user-pending", role: "ADMIN", pendingApproval: true });
    setupFetchReady({ members: [pending] });

    const baseImpl = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/teams/team-1/members/mem-pending/approve") {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
        });
      }
      return baseImpl(url, init);
    });

    await act(async () => {
      render(<TeamMembersPage params={Promise.resolve({ teamId: "team-1" })} />);
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "approveButton" })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "approveButton" }));
    });

    await waitFor(() => {
      expect(screen.getByTestId("recent-session-dialog")).toBeInTheDocument();
    });
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("reject — opens RecentSessionRequiredDialog when SESSION_STEP_UP_REQUIRED is returned", async () => {
    const pending = makeMember({ id: "mem-pending", userId: "user-pending", role: "ADMIN", pendingApproval: true });
    setupFetchReady({ members: [pending] });

    const baseImpl = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/teams/team-1/members/mem-pending/reject") {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
        });
      }
      return baseImpl(url, init);
    });

    await act(async () => {
      render(<TeamMembersPage params={Promise.resolve({ teamId: "team-1" })} />);
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("alert-action").length).toBeGreaterThanOrEqual(1);
    });

    await act(async () => {
      fireEvent.click(screen.getAllByTestId("alert-action")[0]);
    });

    await waitFor(() => {
      expect(screen.getByTestId("recent-session-dialog")).toBeInTheDocument();
    });
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("role-changed 409 reloads the list and shows a message", async () => {
    const pending = makeMember({ id: "mem-pending", userId: "user-pending", role: "ADMIN", pendingApproval: true });
    setupFetchReady({ members: [pending] });

    const baseImpl = mockFetch.getMockImplementation()!;
    let approveCalls = 0;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/teams/team-1/members/mem-pending/approve") {
        approveCalls += 1;
        return Promise.resolve({
          ok: false,
          status: 409,
          json: () => Promise.resolve({ error: "SCIM_APPROVAL_ROLE_CHANGED" }),
        });
      }
      return baseImpl(url, init);
    });

    await act(async () => {
      render(<TeamMembersPage params={Promise.resolve({ teamId: "team-1" })} />);
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "approveButton" })).toBeInTheDocument();
    });

    const membersCallsBefore = mockFetch.mock.calls.filter(
      (c) => c[0] === "/api/teams/team-1/members",
    ).length;

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "approveButton" }));
    });

    await waitFor(() => {
      expect(approveCalls).toBe(1);
      expect(mockToast.error).toHaveBeenCalledWith("approveRoleChanged");
    });

    const membersCallsAfter = mockFetch.mock.calls.filter(
      (c) => c[0] === "/api/teams/team-1/members",
    ).length;
    expect(membersCallsAfter).toBeGreaterThan(membersCallsBefore);
  });

  it.each([
    { button: "approveButton", path: "approve", status: 403, error: "FORBIDDEN", message: "approveNeedsKey" },
    { button: "approveButton", path: "approve", status: 404, error: "MEMBER_NOT_FOUND", message: "requestAlreadyHandled" },
    { button: "approveButton", path: "approve", status: 409, error: "SCIM_APPROVAL_TARGET_INACTIVE", message: "approveTargetLeftTenant" },
    // The target leaving the tenant (above) and a lock/CAS conflict (below)
    // are now distinct codes (review round 2, S-R2-2/F-N1/F-N2/T-N2) — the
    // generic CONFLICT must not reuse the "reject instead" wording, since
    // nothing here says the target is actually gone.
    { button: "approveButton", path: "approve", status: 409, error: "CONFLICT", message: "approvalBusyRetry" },
    { button: "approveButton", path: "approve", status: 429, error: "RATE_LIMIT_EXCEEDED", message: "rateLimitExceeded" },
    { button: "rejectButton", path: "reject", status: 404, error: "MEMBER_NOT_FOUND", message: "requestAlreadyHandled" },
    { button: "rejectButton", path: "reject", status: 403, error: "FORBIDDEN", message: "forbidden" },
    { button: "rejectButton", path: "reject", status: 409, error: "CONFLICT", message: "approvalBusyRetry" },
    { button: "rejectButton", path: "reject", status: 429, error: "RATE_LIMIT_EXCEEDED", message: "rateLimitExceeded" },
  ])("$path $status $error shows $message, not a network error", async ({ button, path, status, error, message }) => {
    const pending = makeMember({ id: "mem-pending", userId: "user-pending", role: "ADMIN", pendingApproval: true });
    setupFetchReady({ members: [pending] });

    const baseImpl = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === `/api/teams/team-1/members/mem-pending/${path}`) {
        return Promise.resolve({ ok: false, status, json: () => Promise.resolve({ error }) });
      }
      return baseImpl(url, init);
    });

    await act(async () => {
      render(<TeamMembersPage params={Promise.resolve({ teamId: "team-1" })} />);
    });
    // The confirm dialog's action shares the reject label; the first match is
    // the row's trigger.
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: button })[0]).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: button })[0]);
    });
    if (path === "reject") {
      await waitFor(() => {
        expect(screen.getAllByTestId("alert-action").length).toBeGreaterThanOrEqual(1);
      });
      await act(async () => {
        fireEvent.click(screen.getAllByTestId("alert-action")[0]);
      });
    }

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith(message);
    });
    expect(mockToast.error).not.toHaveBeenCalledWith("networkError");
  });

  it("an unrecognised 409 on approve falls to the generic network error", async () => {
    const pending = makeMember({ id: "mem-pending", userId: "user-pending", role: "ADMIN", pendingApproval: true });
    setupFetchReady({ members: [pending] });

    const baseImpl = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/teams/team-1/members/mem-pending/approve") {
        return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ error: "SOME_OTHER_CODE" }) });
      }
      return baseImpl(url, init);
    });

    await act(async () => {
      render(<TeamMembersPage params={Promise.resolve({ teamId: "team-1" })} />);
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "approveButton" })).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "approveButton" }));
    });

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("networkError");
    });
  });
});
