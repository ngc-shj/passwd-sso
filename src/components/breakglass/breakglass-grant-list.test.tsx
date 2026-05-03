// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockFetchApi, mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (path: string, init?: RequestInit) => mockFetchApi(path, init),
}));

vi.mock("@/lib/format/format-datetime", () => ({
  formatDateTime: (s: string) => s,
}));

vi.mock("@/lib/format/format-user", () => ({
  formatUserName: (u: { name: string | null; email: string | null } | null) =>
    u ? (u.name ?? u.email ?? "-") : "-",
}));

vi.mock("sonner", () => ({
  toast: { success: mockToastSuccess, error: mockToastError },
}));

vi.mock("./breakglass-personal-log-viewer", () => ({
  BreakGlassPersonalLogViewer: ({ grantId, onBack }: { grantId: string; onBack: () => void }) => (
    <div data-testid="log-viewer">
      <span>viewer-for:{grantId}</span>
      <button onClick={onBack}>back</button>
    </div>
  ),
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, disabled, onClick }: React.ComponentProps<"button">) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
  }) => (open ? <div data-testid="alert-dialog">{children}</div> : null),
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
    onClick: () => void;
  }) => <button onClick={onClick}>{children}</button>,
}));

import { BreakGlassGrantList } from "./breakglass-grant-list";

const activeGrant = {
  id: "g1",
  status: "active",
  reason: "active reason",
  incidentRef: null,
  createdAt: "2026-05-04",
  expiresAt: "2026-05-05",
  revokedAt: null,
  requester: { id: "u-r", name: "Requester", email: null },
  targetUser: { id: "u-t", name: "Target", email: null },
};

const expiredGrant = {
  ...activeGrant,
  id: "g2",
  status: "expired",
};

describe("BreakGlassGrantList", () => {
  beforeEach(() => {
    mockFetchApi.mockReset();
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
  });

  it("shows loader initially then empty state when there are no grants", async () => {
    mockFetchApi.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ items: [] }),
    }));

    render(<BreakGlassGrantList refreshTrigger={0} />);

    await waitFor(() => {
      expect(screen.getByText("noActiveGrants")).toBeInTheDocument();
    });
    expect(screen.getByText("noGrants")).toBeInTheDocument();
  });

  it("renders active grants with target name", async () => {
    mockFetchApi.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ items: [activeGrant] }),
    }));

    render(<BreakGlassGrantList refreshTrigger={0} />);

    await waitFor(() => {
      expect(screen.getByText("Target")).toBeInTheDocument();
    });
    expect(screen.getByText("statusActive")).toBeInTheDocument();
  });

  it("opens revoke alert dialog and calls DELETE on confirm", async () => {
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [activeGrant] }),
    });
    // Revoke DELETE
    mockFetchApi.mockResolvedValueOnce({ ok: true });
    // Refresh after revoke
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] }),
    });

    render(<BreakGlassGrantList refreshTrigger={0} />);

    await waitFor(() => {
      expect(screen.getByText("Target")).toBeInTheDocument();
    });

    // Multiple "revoke" buttons exist (row revoke + alert action). Find the
    // FIRST one — the row trigger.
    const revokeButtons = screen.getAllByText("revoke");
    fireEvent.click(revokeButtons[0]);

    expect(screen.getByTestId("alert-dialog")).toBeInTheDocument();

    // Click the action revoke (second one in the alert dialog)
    const allRevokes = screen.getAllByText("revoke");
    // The last "revoke" is in the AlertDialogAction
    fireEvent.click(allRevokes[allRevokes.length - 1]);

    await waitFor(() => {
      expect(mockFetchApi).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ method: "DELETE" }),
      );
    });
    expect(mockToastSuccess).toHaveBeenCalled();
  });

  it("toggles history visibility and renders historical grants", async () => {
    mockFetchApi.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ items: [expiredGrant] }),
    }));

    render(<BreakGlassGrantList refreshTrigger={0} />);

    await waitFor(() => {
      expect(screen.getByText("showHistory")).toBeInTheDocument();
    });

    // History is hidden until clicked
    expect(screen.queryByText("statusExpired")).toBeNull();

    fireEvent.click(screen.getByText("showHistory"));

    await waitFor(() => {
      expect(screen.getByText("statusExpired")).toBeInTheDocument();
    });
  });

  it("opens log viewer when viewLogs clicked, returns on back", async () => {
    mockFetchApi.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ items: [activeGrant] }),
    }));

    render(<BreakGlassGrantList refreshTrigger={0} />);

    await waitFor(() => screen.getByText("Target"));

    fireEvent.click(screen.getByText("viewLogs"));

    expect(screen.getByTestId("log-viewer")).toBeInTheDocument();
    expect(screen.getByText("viewer-for:g1")).toBeInTheDocument();

    fireEvent.click(screen.getByText("back"));

    await waitFor(() => {
      expect(screen.queryByTestId("log-viewer")).toBeNull();
    });
    expect(screen.getByText("Target")).toBeInTheDocument();
  });

  it("re-fetches when refreshTrigger changes", async () => {
    mockFetchApi.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ items: [] }),
    }));

    const { rerender } = render(<BreakGlassGrantList refreshTrigger={0} />);

    await waitFor(() => {
      expect(mockFetchApi).toHaveBeenCalledTimes(1);
    });

    rerender(<BreakGlassGrantList refreshTrigger={1} />);

    await waitFor(() => {
      expect(mockFetchApi).toHaveBeenCalledTimes(2);
    });
  });
});
