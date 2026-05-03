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

// Stable identity for useTranslations: avoid re-render storms triggered by
// useCallback dependency on `t`.
const stableT = (key: string) => key;
vi.mock("next-intl", () => ({
  useTranslations: () => stableT,
  useLocale: () => "en",
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (path: string, init?: RequestInit) => mockFetchApi(path, init),
}));

vi.mock("@/lib/format/format-datetime", () => ({
  formatDateTime: (s: string) => s,
}));

vi.mock("sonner", () => ({
  toast: { success: mockToastSuccess, error: mockToastError },
}));

vi.mock("bowser", () => ({
  default: {
    parse: (ua: string) => ({
      browser: { name: ua.includes("Chrome") ? "Chrome" : "Firefox" },
      os: { name: "macOS", versionName: "Sequoia" },
      platform: { type: ua.includes("Mobile") ? "mobile" : "desktop" },
    }),
  },
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, disabled, onClick }: React.ComponentProps<"button">) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/settings/account/section-card-header", () => ({
  SectionCardHeader: ({ title }: { title: string }) => <h2>{title}</h2>,
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
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

import { SessionsCard } from "./sessions-card";

const sessions = [
  {
    id: "s-current",
    createdAt: "2026-05-04",
    lastActiveAt: "2026-05-04",
    ipAddress: "1.1.1.1",
    userAgent: "Chrome",
    isCurrent: true,
  },
  {
    id: "s-other",
    createdAt: "2026-05-03",
    lastActiveAt: "2026-05-03",
    ipAddress: "2.2.2.2",
    userAgent: "Firefox Mobile",
    isCurrent: false,
  },
];

describe("SessionsCard", () => {
  beforeEach(() => {
    mockFetchApi.mockReset();
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
  });

  it("fetches and renders sessions with current badge", async () => {
    mockFetchApi.mockResolvedValue({ ok: true, json: async () => sessions });

    render(<SessionsCard />);

    await waitFor(() => {
      expect(screen.getByText(/Chrome/)).toBeInTheDocument();
    });
    expect(screen.getByText("current")).toBeInTheDocument();
    expect(screen.getByText(/Firefox/)).toBeInTheDocument();
  });

  it("shows 'no other sessions' when only current session exists", async () => {
    mockFetchApi.mockResolvedValue({
      ok: true,
      json: async () => [sessions[0]],
    });

    render(<SessionsCard />);

    await waitFor(() => {
      expect(screen.getByText("noOtherSessions")).toBeInTheDocument();
    });
  });

  it("shows revokeAll button when there are other sessions", async () => {
    mockFetchApi.mockResolvedValue({ ok: true, json: async () => sessions });

    render(<SessionsCard />);

    await waitFor(() => {
      expect(screen.getByText("revokeAll")).toBeInTheDocument();
    });
  });

  it("opens revoke confirm dialog and revokes single session", async () => {
    mockFetchApi
      .mockResolvedValueOnce({ ok: true, json: async () => sessions })
      .mockResolvedValueOnce({ ok: true });

    render(<SessionsCard />);

    await waitFor(() => screen.getByText(/Firefox/));

    // Click the X button on the non-current session.
    fireEvent.click(screen.getByText("revoke"));

    expect(screen.getByTestId("alert-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByText("confirm"));

    await waitFor(() => {
      expect(mockFetchApi).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ method: "DELETE" }),
      );
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("revokeSuccess");
  });

  it("shows fetchError toast on initial fetch failure", async () => {
    mockFetchApi.mockResolvedValue({ ok: false });

    render(<SessionsCard />);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("fetchError");
    });
  });

  it("revokes all when revokeAll button + confirm clicked", async () => {
    mockFetchApi
      .mockResolvedValueOnce({ ok: true, json: async () => sessions })
      .mockResolvedValueOnce({ ok: true });

    render(<SessionsCard />);

    await waitFor(() => screen.getByText("revokeAll"));

    fireEvent.click(screen.getByText("revokeAll"));

    expect(screen.getByTestId("alert-dialog")).toBeInTheDocument();

    // Click second 'confirm' (in the revokeAll dialog)
    const confirmButtons = screen.getAllByText("confirm");
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => {
      expect(mockFetchApi).toHaveBeenCalledTimes(2);
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("revokeAllSuccess");
  });
});
