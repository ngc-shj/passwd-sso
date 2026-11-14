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

import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { SCIM_BULK_ADMISSION_MAX } from "@/lib/constants/team/scim-admission";

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

// A real Response: its body can be read once, as in a browser.
function errorResponse(status: number, error?: string): Response {
  return new Response(JSON.stringify(error === undefined ? {} : { error }), { status });
}

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
        return Promise.resolve(errorResponse(403, "SESSION_STEP_UP_REQUIRED"));
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
        return Promise.resolve(errorResponse(403, "SESSION_STEP_UP_REQUIRED"));
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
        return Promise.resolve(errorResponse(403, "SESSION_STEP_UP_REQUIRED"));
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
        return Promise.resolve(errorResponse(403, "SESSION_STEP_UP_REQUIRED"));
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
        return Promise.resolve(errorResponse(409, "SCIM_APPROVAL_ROLE_CHANGED"));
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
    { button: "approveButton", path: "approve", status: 409, error: "TEAM_BUSY", message: "approvalBusyRetry" },
    { button: "approveButton", path: "approve", status: 429, error: "RATE_LIMIT_EXCEEDED", message: "rateLimitExceeded" },
    { button: "rejectButton", path: "reject", status: 404, error: "MEMBER_NOT_FOUND", message: "requestAlreadyHandled" },
    { button: "rejectButton", path: "reject", status: 403, error: "FORBIDDEN", message: "forbidden" },
    { button: "rejectButton", path: "reject", status: 409, error: "CONFLICT", message: "approvalBusyRetry" },
    { button: "rejectButton", path: "reject", status: 409, error: "TEAM_BUSY", message: "approvalBusyRetry" },
    { button: "rejectButton", path: "reject", status: 429, error: "RATE_LIMIT_EXCEEDED", message: "rateLimitExceeded" },
  ])("$path $status $error shows $message, not a network error", async ({ button, path, status, error, message }) => {
    const pending = makeMember({ id: "mem-pending", userId: "user-pending", role: "ADMIN", pendingApproval: true });
    setupFetchReady({ members: [pending] });

    const baseImpl = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === `/api/teams/team-1/members/mem-pending/${path}`) {
        return Promise.resolve(errorResponse(status, error));
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
        return Promise.resolve(errorResponse(409, "SOME_OTHER_CODE"));
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

describe("TeamMembersPage (role change / removal refusals)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
  });

  async function renderWithFailure(method: "PUT" | "DELETE", failure: () => Promise<Response>) {
    setupFetchReady({ members: [makeMember({ id: "mem-1", userId: "user-member", role: "MEMBER" })] });
    const baseImpl = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((url: string, init?: RequestInit) =>
      init?.method === method ? failure() : baseImpl(url, init),
    );
    await act(async () => {
      render(<TeamMembersPage params={Promise.resolve({ teamId: "team-1" })} />);
    });
    await waitFor(() => {
      expect(screen.getByTestId("select-change-MEMBER")).toBeInTheDocument();
    });
    await act(async () => {
      if (method === "PUT") fireEvent.click(screen.getByTestId("select-change-MEMBER"));
      else fireEvent.click(screen.getAllByTestId("alert-action")[0]);
    });
  }

  it.each(["PUT", "DELETE"] as const)("%s TEAM_BUSY shows the busy message, not a network error", async (method) => {
    await renderWithFailure(method, () => Promise.resolve(errorResponse(409, "TEAM_BUSY")));
    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("teamBusy");
    });
    expect(mockToast.error).not.toHaveBeenCalledWith("networkError");
  });

  it.each(["PUT", "DELETE"] as const)("%s CONFLICT shows the conflict message, not a network error", async (method) => {
    await renderWithFailure(method, () => Promise.resolve(errorResponse(409, "CONFLICT")));
    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("conflict");
    });
    expect(mockToast.error).not.toHaveBeenCalledWith("networkError");
  });

  it.each(["PUT", "DELETE"] as const)("%s non-JSON 5xx shows networkError", async (method) => {
    await renderWithFailure(method, () => Promise.resolve(new Response("bad gateway", { status: 502 })));
    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("networkError");
    });
  });

  it.each(["PUT", "DELETE"] as const)("%s thrown fetch shows networkError", async (method) => {
    await renderWithFailure(method, () => Promise.reject(new TypeError("fetch failed")));
    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("networkError");
    });
  });
});

describe("TeamMembersPage (SCIM bulk admission, C5)", () => {
  const BULK_URL = (kind: "approve" | "reject") => `/api/teams/team-1/members/bulk-${kind}`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
    mockReauthenticateWithPasskey.mockResolvedValue({ ok: true, verifiedAt: "2026-05-10T00:00:00Z" });
  });

  function pendingRows(
    count: number,
    overrides: (i: number) => Parameters<typeof makeMember>[0] = () => ({}),
  ) {
    return Array.from({ length: count }, (_, i) => {
      const n = String(i + 1).padStart(3, "0");
      return makeMember({
        id: `p-${n}`,
        userId: `u-${n}`,
        name: `Pending ${n}`,
        email: `pending${n}@example.com`,
        role: "MEMBER",
        pendingApproval: true,
        ...overrides(i),
      });
    });
  }

  async function renderPage(
    members: ReturnType<typeof makeMember>[],
    teamRole = "OWNER",
    bulkResponse?: (kind: "approve" | "reject", init: RequestInit) => Response,
  ) {
    setupFetchReady({
      members,
      team: { id: "team-1", name: "Team One", slug: "team-one", description: null, role: teamRole },
    });
    const baseImpl = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const kind = url === BULK_URL("approve") ? "approve" : url === BULK_URL("reject") ? "reject" : null;
      if (kind && bulkResponse) return Promise.resolve(bulkResponse(kind, init ?? {}));
      return baseImpl(url, init);
    });
    await act(async () => {
      render(<TeamMembersPage params={Promise.resolve({ teamId: "team-1" })} />);
    });
    await waitFor(() => {
      expect(screen.getByPlaceholderText("searchMembers")).toBeInTheDocument();
    });
  }

  const bulkCalls = (kind: "approve" | "reject") =>
    mockFetch.mock.calls.filter((c) => c[0] === BULK_URL(kind));
  const bulkBody = (kind: "approve" | "reject") =>
    JSON.parse((bulkCalls(kind)[0][1] as RequestInit).body as string);
  const bulkDialog = (kind: "approve" | "reject") =>
    screen
      .getAllByTestId("alert-content")
      .find((el) => el.textContent?.includes(kind === "approve" ? "bulkApproveConfirm" : "bulkRejectButton:"))!;
  const confirmBulk = async (kind: "approve" | "reject") => {
    const action = bulkDialog(kind).querySelector('[data-testid="alert-action"]')!;
    await act(async () => {
      fireEvent.click(action);
    });
  };
  const okResults = (results: { memberId: string; outcome: string }[]) =>
    new Response(JSON.stringify({ results }), { status: 200 });

  it("renders neither bulk button for a single pending row, and keeps the row's own buttons", async () => {
    await renderPage(pendingRows(1));
    expect(screen.queryByText(/^bulkApproveButton/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^bulkRejectButton/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "approveButton" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "rejectButton" }).length).toBeGreaterThanOrEqual(1);
  });

  it("renders both bulk buttons with their counts at two pending rows, next to the per-row buttons", async () => {
    await renderPage(pendingRows(2));
    expect(screen.getAllByText('bulkApproveButton:{"count":2}').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('bulkRejectButton:{"count":2}').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole("button", { name: "approveButton" }).length).toBeGreaterThanOrEqual(2);
  });

  it("renders no bulk button for a non-admin viewer", async () => {
    await renderPage(pendingRows(3), "MEMBER");
    expect(screen.queryByText(/^bulkApproveButton/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^bulkRejectButton/)).not.toBeInTheDocument();
  });

  it("excludes tenant-inactive rows from the approve count but not the reject count", async () => {
    await renderPage(
      pendingRows(4, (i) => (i < 2 ? { pendingTenantInactive: true } : {})),
    );
    expect(screen.getAllByText('bulkApproveButton:{"count":2}').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('bulkRejectButton:{"count":4}').length).toBeGreaterThanOrEqual(1);
  });

  it("hides the approve button when only one approvable row remains, while reject stays", async () => {
    await renderPage(pendingRows(3, (i) => (i < 2 ? { pendingTenantInactive: true } : {})));
    expect(screen.queryByText(/^bulkApproveButton/)).not.toBeInTheDocument();
    expect(screen.getAllByText('bulkRejectButton:{"count":3}').length).toBeGreaterThanOrEqual(1);
  });

  it("counts follow the search filter", async () => {
    await renderPage(pendingRows(5));
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("searchMembers"), { target: { value: "pending00" } });
    });
    expect(screen.getAllByText('bulkRejectButton:{"count":5}').length).toBeGreaterThanOrEqual(1);
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("searchMembers"), { target: { value: "pending003" } });
    });
    expect(screen.queryByText(/^bulkRejectButton/)).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("searchMembers"), { target: { value: "pending001" } });
    });
    expect(screen.queryByText(/^bulkApproveButton/)).not.toBeInTheDocument();
  });

  it("the approve dialog shows the per-role counts, with the admin count on its own line", async () => {
    const roles = ["MEMBER", "MEMBER", "VIEWER", "ADMIN", "ADMIN"];
    await renderPage(pendingRows(5, (i) => ({ role: roles[i] })));
    const dialog = bulkDialog("approve");
    expect(dialog).toHaveTextContent('bulkApproveConfirm:{"count":5}');
    expect(dialog).toHaveTextContent('bulkApproveRoleCount:{"role":"roleMember","count":2}');
    expect(dialog).toHaveTextContent('bulkApproveRoleCount:{"role":"roleViewer","count":1}');
    const adminLine = screen.getByText('bulkApproveAdminCount:{"role":"roleAdmin","count":2}');
    expect(adminLine.tagName).toBe("P");
    expect(adminLine).toHaveClass("font-semibold");
  });

  it("the approve dialog has no admin line when no admin row is in the batch", async () => {
    await renderPage(pendingRows(3));
    expect(screen.queryByText(/^bulkApproveAdminCount/)).not.toBeInTheDocument();
  });

  it("sends no request before confirm or after cancel", async () => {
    await renderPage(pendingRows(3));
    expect(bulkCalls("approve")).toHaveLength(0);
    expect(bulkCalls("reject")).toHaveLength(0);
    const cancels = within(bulkDialog("approve")).getByRole("button", { name: "cancel" });
    await act(async () => {
      fireEvent.click(cancels);
    });
    const rejectCancel = within(bulkDialog("reject")).getByRole("button", { name: "cancel" });
    await act(async () => {
      fireEvent.click(rejectCancel);
    });
    expect(bulkCalls("approve")).toHaveLength(0);
    expect(bulkCalls("reject")).toHaveLength(0);
  });

  it("bulk approve posts the shown rows in display order with their displayed roles", async () => {
    const roles = ["VIEWER", "ADMIN", "MEMBER"];
    await renderPage(pendingRows(3, (i) => ({ role: roles[i] })), "OWNER", () =>
      okResults([]),
    );
    await confirmBulk("approve");
    await waitFor(() => expect(bulkCalls("approve")).toHaveLength(1));
    expect((bulkCalls("approve")[0][1] as RequestInit).method).toBe("POST");
    expect(bulkBody("approve")).toEqual({
      members: [
        { memberId: "p-001", expectedRole: "VIEWER" },
        { memberId: "p-002", expectedRole: "ADMIN" },
        { memberId: "p-003", expectedRole: "MEMBER" },
      ],
    });
  });

  it("bulk approve leaves out tenant-inactive rows and sends them in display order under a filter", async () => {
    await renderPage(
      pendingRows(5, (i) => (i === 1 ? { pendingTenantInactive: true } : {})),
      "OWNER",
      () => okResults([]),
    );
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("searchMembers"), { target: { value: "pending00" } });
    });
    await confirmBulk("approve");
    await waitFor(() => expect(bulkCalls("approve")).toHaveLength(1));
    expect(bulkBody("approve").members.map((m: { memberId: string }) => m.memberId)).toEqual([
      "p-001", "p-003", "p-004", "p-005",
    ]);
  });

  it("caps both requests at SCIM_BULK_ADMISSION_MAX and tells how many remain", async () => {
    const extra = 7;
    await renderPage(pendingRows(SCIM_BULK_ADMISSION_MAX + extra), "OWNER", () => okResults([]));
    expect(screen.getAllByText(`bulkApproveButton:{"count":${SCIM_BULK_ADMISSION_MAX}}`).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(`bulkRejectButton:{"count":${SCIM_BULK_ADMISSION_MAX}}`).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(`bulkRemainingNote:{"count":${extra}}`)).toHaveLength(2);

    await confirmBulk("approve");
    await confirmBulk("reject");
    await waitFor(() => {
      expect(bulkCalls("approve")).toHaveLength(1);
      expect(bulkCalls("reject")).toHaveLength(1);
    });
    const ids = bulkBody("approve").members.map((m: { memberId: string }) => m.memberId);
    expect(ids).toHaveLength(SCIM_BULK_ADMISSION_MAX);
    expect(ids[0]).toBe("p-001");
    expect(ids[ids.length - 1]).toBe(`p-${String(SCIM_BULK_ADMISSION_MAX).padStart(3, "0")}`);
    expect(bulkBody("reject").memberIds).toHaveLength(SCIM_BULK_ADMISSION_MAX);
  });

  it("states no remainder when the pending rows fit in one request", async () => {
    await renderPage(pendingRows(3));
    expect(screen.queryByText(/^bulkRemainingNote/)).not.toBeInTheDocument();
  });

  it("bulk reject posts the shown ids and reuses the single reject explanation", async () => {
    await renderPage(pendingRows(3, (i) => (i === 0 ? { pendingTenantInactive: true } : {})), "OWNER", () =>
      okResults([]),
    );
    expect(bulkDialog("reject")).toHaveTextContent("rejectConfirm");
    await confirmBulk("reject");
    await waitFor(() => expect(bulkCalls("reject")).toHaveLength(1));
    expect(bulkBody("reject")).toEqual({ memberIds: ["p-001", "p-002", "p-003"] });
  });

  it("toasts the approved count and reloads the list on success", async () => {
    await renderPage(pendingRows(2), "OWNER", () =>
      okResults([
        { memberId: "p-001", outcome: "approved" },
        { memberId: "p-002", outcome: "approved" },
      ]),
    );
    const before = mockFetch.mock.calls.filter((c) => c[0] === "/api/teams/team-1/members").length;
    await confirmBulk("approve");
    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('bulkApproved:{"count":2}');
    });
    expect(mockToast.error).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(mockFetch.mock.calls.filter((c) => c[0] === "/api/teams/team-1/members").length).toBeGreaterThan(before);
    });
  });

  it("toasts the rejected count on bulk reject success", async () => {
    await renderPage(pendingRows(2), "OWNER", () =>
      okResults([
        { memberId: "p-001", outcome: "rejected" },
        { memberId: "p-002", outcome: "rejected" },
      ]),
    );
    await confirmBulk("reject");
    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('bulkRejected:{"count":2}');
    });
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it.each(["approve", "reject"] as const)(
    "%s with every outcome not_found shows the already-handled message and no count",
    async (kind) => {
      await renderPage(pendingRows(2), "OWNER", () =>
        okResults([
          { memberId: "p-001", outcome: "not_found" },
          { memberId: "p-002", outcome: "not_found" },
        ]),
      );
      await confirmBulk(kind);
      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith("requestAlreadyHandled");
      });
      expect(mockToast.success).not.toHaveBeenCalled();
    },
  );

  it("a mixed approve result toasts the approved count and the skipped count", async () => {
    await renderPage(pendingRows(3), "OWNER", () =>
      okResults([
        { memberId: "p-001", outcome: "approved" },
        { memberId: "p-002", outcome: "role_changed" },
        { memberId: "p-003", outcome: "not_found" },
      ]),
    );
    await confirmBulk("approve");
    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('bulkApproved:{"count":1}');
      expect(mockToast.error).toHaveBeenCalledWith('bulkApproveSkipped:{"count":2}');
    });
  });

  it("an approve result with nothing approved and mixed outcomes toasts only the skipped count", async () => {
    await renderPage(pendingRows(2), "OWNER", () =>
      okResults([
        { memberId: "p-001", outcome: "role_changed" },
        { memberId: "p-002", outcome: "not_found" },
      ]),
    );
    await confirmBulk("approve");
    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('bulkApproveSkipped:{"count":2}');
    });
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalledWith("requestAlreadyHandled");
  });

  it("a mixed reject result toasts the rejected count and the skipped count", async () => {
    await renderPage(pendingRows(3), "OWNER", () =>
      okResults([
        { memberId: "p-001", outcome: "rejected" },
        { memberId: "p-002", outcome: "rejected" },
        { memberId: "p-003", outcome: "not_found" },
      ]),
    );
    await confirmBulk("reject");
    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('bulkRejected:{"count":2}');
      expect(mockToast.error).toHaveBeenCalledWith('bulkRejectSkipped:{"count":1}');
    });
  });

  it.each([
    { kind: "approve", status: 403, error: "FORBIDDEN", message: "approveNeedsKey" },
    { kind: "approve", status: 409, error: "CONFLICT", message: "approvalBusyRetry" },
    { kind: "approve", status: 409, error: "TEAM_BUSY", message: "approvalBusyRetry" },
    { kind: "approve", status: 429, error: "RATE_LIMIT_EXCEEDED", message: "rateLimitExceeded" },
    { kind: "reject", status: 403, error: "FORBIDDEN", message: "forbidden" },
    { kind: "reject", status: 409, error: "CONFLICT", message: "approvalBusyRetry" },
    { kind: "reject", status: 409, error: "TEAM_BUSY", message: "approvalBusyRetry" },
    { kind: "reject", status: 429, error: "RATE_LIMIT_EXCEEDED", message: "rateLimitExceeded" },
  ] as const)("bulk $kind $status $error shows $message, not a network error", async ({ kind, status, error, message }) => {
    await renderPage(pendingRows(2), "OWNER", () => errorResponse(status, error));
    await confirmBulk(kind);
    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith(message);
    });
    expect(mockToast.error).not.toHaveBeenCalledWith("networkError");
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it("an unrecognised bulk error falls to the generic network error", async () => {
    await renderPage(pendingRows(2), "OWNER", () => errorResponse(500, "SOME_OTHER_CODE"));
    await confirmBulk("approve");
    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("networkError");
    });
  });

  it.each(["approve", "reject"] as const)(
    "bulk %s step-up retry replays the captured list even after the shown list changed",
    async (kind) => {
      mockCanUsePasskeyRecovery.mockResolvedValue(true);
      let calls = 0;
      await renderPage(pendingRows(3, (i) => ({ role: ["VIEWER", "ADMIN", "MEMBER"][i] })), "OWNER", () => {
        calls += 1;
        return calls === 1
          ? errorResponse(403, "SESSION_STEP_UP_REQUIRED")
          : okResults([{ memberId: "p-001", outcome: kind === "approve" ? "approved" : "rejected" }]);
      });
      await confirmBulk(kind);
      await waitFor(() => {
        expect(screen.getByTestId("passkey-reauth-dialog")).toBeInTheDocument();
      });
      expect(mockToast.error).not.toHaveBeenCalled();

      // Narrow the list to one row while the reauth dialog is open.
      await act(async () => {
        fireEvent.change(screen.getByPlaceholderText("searchMembers"), { target: { value: "pending002" } });
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId("passkey-reauth-action"));
      });

      await waitFor(() => expect(bulkCalls(kind)).toHaveLength(2));
      const [first, second] = bulkCalls(kind).map((c) => (c[1] as RequestInit).body);
      expect(second).toBe(first);
      if (kind === "approve") {
        expect(JSON.parse(second as string)).toEqual({
          members: [
            { memberId: "p-001", expectedRole: "VIEWER" },
            { memberId: "p-002", expectedRole: "ADMIN" },
            { memberId: "p-003", expectedRole: "MEMBER" },
          ],
        });
      } else {
        expect(JSON.parse(second as string)).toEqual({ memberIds: ["p-001", "p-002", "p-003"] });
      }
    },
  );
});
