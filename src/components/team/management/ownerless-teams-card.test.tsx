// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { ReactNode } from "react";

const { mockFetch, mockToast, mockCanUsePasskeyRecovery } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
  mockCanUsePasskeyRecovery: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

import "@/__tests__/helpers/passkey-reauth-mocks";

vi.mock("@/lib/auth/webauthn/can-use-passkey-recovery", () => ({
  canUsePasskeyRecovery: mockCanUsePasskeyRecovery,
}));

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  AlertDialogAction: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button data-testid="alert-action" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children, onValueChange }: { children: ReactNode; onValueChange?: (v: string) => void }) => (
    <div>
      {children}
      <button data-testid="pick-owner" onClick={() => onValueChange?.("user-1")}>
        pick
      </button>
    </div>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span />,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { OwnerlessTeamsCard } from "./ownerless-teams-card";

const OWNER_PATH = "/api/tenant/teams/team-1/owner";

const TEAMS = [
  {
    id: "team-1",
    name: "Team One",
    slug: "team-one",
    members: [{ userId: "user-1", role: "ADMIN", name: "Alice", email: "alice@example.com" }],
  },
];

// A real Response: its body can be read once, as in a browser.
function errorResponse(status: number, error?: string): Response {
  return new Response(JSON.stringify(error === undefined ? {} : { error }), { status });
}

function listCalls() {
  return mockFetch.mock.calls.filter((c) => c[0] !== OWNER_PATH).length;
}

async function assignWith(ownerResponse: () => Response | Promise<Response>) {
  mockFetch.mockImplementation((url: string) => {
    if (url === OWNER_PATH) return Promise.resolve(ownerResponse());
    return Promise.resolve(new Response(JSON.stringify({ teams: TEAMS }), { status: 200 }));
  });
  await act(async () => {
    render(<OwnerlessTeamsCard />);
  });
  await waitFor(() => {
    expect(screen.getByTestId("pick-owner")).toBeInTheDocument();
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("pick-owner"));
  });
  const listCallsBefore = listCalls();
  await act(async () => {
    fireEvent.click(screen.getByTestId("alert-action"));
  });
  return listCallsBefore;
}

describe("OwnerlessTeamsCard assign owner refusals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
  });

  it.each([
    ["CONFLICT", 409, "ownerAssignConflict"],
    ["TEAM_BUSY", 409, "teamBusy"],
    ["MEMBER_NOT_FOUND", 404, "ownerAssignMemberGone"],
    ["FORBIDDEN", 403, "ownerAssignNotPermitted"],
  ])("%s shows %s and refreshes the list", async (code, status, message) => {
    const before = await assignWith(() => errorResponse(status, code));

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith(message);
    });
    expect(mockToast.error).not.toHaveBeenCalledWith("networkError");
    await waitFor(() => {
      expect(listCalls()).toBeGreaterThan(before);
    });
  });

  it("an unrecognised code shows networkError and does not refresh", async () => {
    const before = await assignWith(() => errorResponse(500, "INTERNAL_ERROR"));

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("networkError");
    });
    expect(listCalls()).toBe(before);
  });

  it("opens the re-authentication dialog on a step-up refusal without a toast", async () => {
    await assignWith(() => errorResponse(403, "SESSION_STEP_UP_REQUIRED"));

    await waitFor(() => {
      expect(screen.getByTestId("recent-session-dialog")).toBeInTheDocument();
    });
    expect(mockToast.error).not.toHaveBeenCalled();
  });
});
