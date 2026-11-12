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

import TeamTransferOwnershipPage from "./page";

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
}: {
  team?: Record<string, unknown>;
  members?: ReturnType<typeof makeMember>[];
} = {}) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url === "/api/teams/team-1" && (!init?.method || init.method === "GET")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(team) });
    }
    if (url === "/api/teams/team-1/members" && (!init?.method || init.method === "GET")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(members) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

describe("TeamTransferOwnershipPage (admin full-page, step-up denial)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
    mockReauthenticateWithPasskey.mockResolvedValue({ ok: true, verifiedAt: "2026-05-10T00:00:00Z" });
  });

  it("transfer — opens RecentSessionRequiredDialog when SESSION_STEP_UP_REQUIRED is returned", async () => {
    const member = makeMember({ id: "mem-1", userId: "user-member", role: "MEMBER" });
    setupFetchReady({ members: [member] });

    const baseImpl = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return Promise.resolve(errorResponse(403, "SESSION_STEP_UP_REQUIRED"));
      }
      return baseImpl(url, init);
    });

    await act(async () => {
      render(<TeamTransferOwnershipPage params={Promise.resolve({ teamId: "team-1" })} />);
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

describe("TeamTransferOwnershipPage (refusals)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
  });

  async function transferWith(failure: () => Promise<Response>) {
    setupFetchReady({ members: [makeMember({ id: "mem-1", userId: "user-member", role: "MEMBER" })] });
    const baseImpl = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((url: string, init?: RequestInit) =>
      init?.method === "PUT" ? failure() : baseImpl(url, init),
    );
    await act(async () => {
      render(<TeamTransferOwnershipPage params={Promise.resolve({ teamId: "team-1" })} />);
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("alert-action").length).toBeGreaterThanOrEqual(1);
    });
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("alert-action")[0]);
    });
  }

  it.each([
    ["TEAM_BUSY", "teamBusy"],
    ["CONFLICT", "conflict"],
  ])("%s shows %s, not a network error", async (code, message) => {
    await transferWith(() => Promise.resolve(errorResponse(409, code)));
    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith(message);
    });
    expect(mockToast.error).not.toHaveBeenCalledWith("networkError");
  });

  it("a non-JSON 5xx shows networkError", async () => {
    await transferWith(() => Promise.resolve(new Response("bad gateway", { status: 502 })));
    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("networkError");
    });
  });

  it("a thrown fetch shows networkError", async () => {
    await transferWith(() => Promise.reject(new TypeError("fetch failed")));
    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("networkError");
    });
  });
});

describe("TeamTransferOwnershipPage (SCIM pending admission, C5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
    mockReauthenticateWithPasskey.mockResolvedValue({ ok: true, verifiedAt: "2026-05-10T00:00:00Z" });
  });

  it("excludes a pending row from transfer candidates", async () => {
    const pending = makeMember({ id: "mem-pending", userId: "user-pending", name: "Pending Pat", role: "ADMIN", pendingApproval: true });
    const active = makeMember({ id: "mem-active", userId: "user-active", name: "Active Alice", role: "MEMBER" });
    setupFetchReady({ members: [pending, active] });

    await act(async () => {
      render(<TeamTransferOwnershipPage params={Promise.resolve({ teamId: "team-1" })} />);
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("alert-trigger").length).toBeGreaterThanOrEqual(1);
    });

    // Only the active member is offered as a transfer target.
    expect(screen.getAllByTestId("alert-trigger")).toHaveLength(1);
  });
});
