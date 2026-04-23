// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ── Hoisted mocks ──────────────────────────────────────────
const { mockFetchApi, mockUseVault, mockToast, mockNotifyTeamDataChanged, mockRouterPush } =
  vi.hoisted(() => ({
    mockFetchApi: vi.fn(),
    mockUseVault: vi.fn(),
    mockToast: { success: vi.fn(), error: vi.fn() },
    mockNotifyTeamDataChanged: vi.fn(),
    mockRouterPush: vi.fn(),
  }));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (values) return `${key}(${JSON.stringify(values)})`;
    return key;
  },
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: mockUseVault,
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetchApi(...args),
}));

vi.mock("sonner", () => ({
  toast: mockToast,
}));

vi.mock("@/lib/events", () => ({
  notifyTeamDataChanged: mockNotifyTeamDataChanged,
}));

vi.mock("@/lib/constants", () => ({
  VAULT_STATUS: {
    LOADING: "LOADING",
    LOCKED: "LOCKED",
    UNLOCKED: "UNLOCKED",
    SETUP_REQUIRED: "SETUP_REQUIRED",
  },
  API_PATH: {
    TEAMS_INVITATIONS_ACCEPT: "/api/teams/invitations/accept",
  },
  TEAM_ROLE: {
    OWNER: "OWNER",
    ADMIN: "ADMIN",
    MEMBER: "MEMBER",
    VIEWER: "VIEWER",
  },
}));

// Stub UI components
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

import AcceptInvitePage from "./page";

// ── Helpers ─────────────────────────────────────────────────

function renderPage(token = "test-token") {
  return render(
    <React.Suspense fallback={<div>Loading...</div>}>
      <AcceptInvitePage params={Promise.resolve({ token })} />
    </React.Suspense>,
  );
}

// ── Tests ────────────────────────────────────────────────────

describe("AcceptInvitePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("vault is UNLOCKED", () => {
    it("auto-accepts by calling fetchApi when vault is UNLOCKED", async () => {
      mockUseVault.mockReturnValue({ status: "UNLOCKED" });
      mockFetchApi.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            team: { id: "team-1", name: "Test Team", slug: "test-team" },
            role: "MEMBER",
            alreadyMember: false,
          }),
      });

      await act(async () => {
        renderPage("invite-token-123");
      });

      await waitFor(() => {
        expect(mockFetchApi).toHaveBeenCalledWith(
          "/api/teams/invitations/accept",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ token: "invite-token-123" }),
          }),
        );
      });
    });

    it("shows success result after accepted invitation", async () => {
      mockUseVault.mockReturnValue({ status: "UNLOCKED" });
      mockFetchApi.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            team: { id: "team-1", name: "Test Team", slug: "test-team" },
            role: "MEMBER",
            alreadyMember: false,
          }),
      });

      await act(async () => {
        renderPage();
      });

      await waitFor(() => {
        expect(screen.getByText("accepted")).toBeInTheDocument();
      });
      expect(mockToast.success).toHaveBeenCalledWith("accepted");
      expect(mockNotifyTeamDataChanged).toHaveBeenCalled();
    });
  });

  describe("vault is NOT UNLOCKED", () => {
    it("shows vault required message and does NOT call fetchApi when vault is SETUP_REQUIRED", async () => {
      mockUseVault.mockReturnValue({ status: "SETUP_REQUIRED" });

      await act(async () => {
        renderPage();
      });

      await waitFor(() => {
        expect(screen.getByText("vaultRequiredForInvite")).toBeInTheDocument();
      });

      expect(mockFetchApi).not.toHaveBeenCalled();
    });

    it("shows vault required message and does NOT call fetchApi when vault is LOCKED", async () => {
      mockUseVault.mockReturnValue({ status: "LOCKED" });

      await act(async () => {
        renderPage();
      });

      await waitFor(() => {
        expect(screen.getByText("vaultRequiredForInvite")).toBeInTheDocument();
      });

      expect(mockFetchApi).not.toHaveBeenCalled();
    });

    it("shows vault required message and does NOT call fetchApi when vault is LOADING", async () => {
      mockUseVault.mockReturnValue({ status: "LOADING" });

      await act(async () => {
        renderPage();
      });

      await waitFor(() => {
        expect(screen.getByText("vaultRequiredForInvite")).toBeInTheDocument();
      });

      expect(mockFetchApi).not.toHaveBeenCalled();
    });
  });

  describe("error states", () => {
    beforeEach(() => {
      mockUseVault.mockReturnValue({ status: "UNLOCKED" });
    });

    it("shows expired error on 410 response", async () => {
      mockFetchApi.mockResolvedValue({ ok: false, status: 410 });

      await act(async () => {
        renderPage();
      });

      await waitFor(() => {
        expect(screen.getByText("inviteExpired")).toBeInTheDocument();
      });
    });

    it("shows invalid error on 404 response", async () => {
      mockFetchApi.mockResolvedValue({ ok: false, status: 404 });

      await act(async () => {
        renderPage();
      });

      await waitFor(() => {
        // Both heading and error detail show "inviteInvalid" for 404
        expect(screen.getAllByText("inviteInvalid")).toHaveLength(2);
      });
    });

    it("shows network error on fetch failure", async () => {
      mockFetchApi.mockRejectedValue(new Error("Network failure"));

      await act(async () => {
        renderPage();
      });

      await waitFor(() => {
        expect(screen.getByText("networkError")).toBeInTheDocument();
      });
    });

    it("shows retry button on error", async () => {
      mockFetchApi.mockResolvedValue({ ok: false, status: 500 });

      await act(async () => {
        renderPage();
      });

      await waitFor(() => {
        expect(screen.getByText("retryAccept")).toBeInTheDocument();
      });
    });

    it("shows alreadyMember text when result has alreadyMember flag", async () => {
      mockFetchApi.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            team: { id: "team-1", name: "Test Team", slug: "test-team" },
            alreadyMember: true,
          }),
      });

      await act(async () => {
        renderPage();
      });

      await waitFor(() => {
        expect(screen.getByText("alreadyMember")).toBeInTheDocument();
      });
    });
  });
});
