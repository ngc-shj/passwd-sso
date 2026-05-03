// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockFetch, mockToast, mockUseVault } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
  mockUseVault: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () =>
    (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => mockUseVault(),
}));

vi.mock("@/components/settings/developer/create-delegation-dialog", () => ({
  CreateDelegationDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange: (v: boolean) => void;
  }) => (
    <div data-testid="create-delegation-dialog" data-open={String(open)}>
      <button type="button" onClick={() => onOpenChange(false)}>
        close
      </button>
    </div>
  ),
}));

import { DelegationManager } from "./delegation-manager";

describe("DelegationManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when vault is not unlocked", () => {
    mockUseVault.mockReturnValue({ status: "locked" });
    const { container } = render(<DelegationManager />);
    expect(container.firstChild).toBeNull();
  });

  it("renders no-sessions message when sessions list is empty", async () => {
    mockUseVault.mockReturnValue({ status: "unlocked" });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ sessions: [], availableTokens: [] }),
    });
    render(<DelegationManager />);
    await waitFor(() => {
      expect(screen.getByText("noSessions")).toBeInTheDocument();
    });
  });

  it("renders existing sessions and supports per-session revoke", async () => {
    mockUseVault.mockReturnValue({ status: "unlocked" });
    const futureMs = Date.now() + 30 * 60_000;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({}),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            sessions: [
              {
                id: "s1",
                mcpTokenId: "t1",
                mcpClientName: "Claude",
                mcpClientId: "client-1",
                entryCount: 5,
                note: null,
                expiresAt: new Date(futureMs).toISOString(),
                createdAt: new Date().toISOString(),
              },
            ],
            availableTokens: [],
          }),
      });
    });
    render(<DelegationManager />);
    await waitFor(() => {
      expect(screen.getByText("Claude")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "revoke" }));

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith("revoked");
    });
  });

  it("opens the create dialog when newDelegation is clicked", async () => {
    mockUseVault.mockReturnValue({ status: "unlocked" });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ sessions: [], availableTokens: [] }),
    });
    render(<DelegationManager />);
    await waitFor(() => {
      expect(screen.getByText("noSessions")).toBeInTheDocument();
    });

    expect(
      screen.getByTestId("create-delegation-dialog"),
    ).toHaveAttribute("data-open", "false");

    fireEvent.click(
      screen.getByRole("button", { name: /newDelegation/ }),
    );
    expect(
      screen.getByTestId("create-delegation-dialog"),
    ).toHaveAttribute("data-open", "true");
  });
});
