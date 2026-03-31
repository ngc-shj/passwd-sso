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

const { mockFetch, mockToast } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockToast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("sonner", () => ({
  toast: mockToast,
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

vi.mock("@/lib/format-datetime", () => ({
  formatDateTime: (date: string) => date,
}));

vi.mock("@/components/settings/section-card-header", () => ({
  SectionCardHeader: ({ title, description }: { title: string; description: string }) => (
    <div data-testid="section-card-header"><span>{title}</span><span>{description}</span></div>
  ),
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: ReactNode }) => (
    <div data-testid="card">{children}</div>
  ),
  CardContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="card-content">{children}</div>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, variant }: { children: ReactNode; variant?: string }) => (
    <span data-testid="badge" data-variant={variant}>{children}</span>
  ),
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
  AlertDialogCancel: ({ children }: { children: ReactNode }) => (
    <button>{children}</button>
  ),
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

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled, ...rest }: React.ComponentProps<"button">) => (
    <button onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}));

import { McpConnectionsCard } from "./mcp-connections-card";

const sampleConnections = [
  {
    id: "token-1",
    clientName: "My MCP Agent",
    clientId: "mcpc_abc123",
    scope: "credentials:list credentials:use",
    createdAt: "2025-01-01T00:00:00Z",
    expiresAt: "2026-01-01T00:00:00Z",
  },
  {
    id: "token-2",
    clientName: "Another Agent",
    clientId: "mcpc_def456",
    scope: "vault:unlock-data,passwords:read",
    createdAt: "2025-02-01T00:00:00Z",
    expiresAt: "2026-02-01T00:00:00Z",
  },
];

function setupFetchConnections(tokens = sampleConnections) {
  mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
    if (!init?.method || init.method === "GET") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ tokens }),
      });
    }
    if (init.method === "DELETE") {
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({ ok: false });
  });
}

describe("McpConnectionsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading spinner initially", async () => {
    mockFetch.mockReturnValue(new Promise(() => {}));

    render(<McpConnectionsCard />);

    const spinner = document.querySelector(".animate-spin");
    expect(spinner).toBeInTheDocument();
  });

  it("shows empty state when no connections", async () => {
    setupFetchConnections([]);

    await act(async () => {
      render(<McpConnectionsCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noConnections")).toBeInTheDocument();
    });

    expect(screen.getByText("noConnectionsDescription")).toBeInTheDocument();
  });

  it("shows empty state when initial fetch throws network error", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    await act(async () => {
      render(<McpConnectionsCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noConnections")).toBeInTheDocument();
    });
  });

  it("renders connection list with client name, clientId, scope badges, and dates", async () => {
    setupFetchConnections();

    await act(async () => {
      render(<McpConnectionsCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("My MCP Agent")).toBeInTheDocument();
    });

    expect(screen.getByText("mcpc_abc123")).toBeInTheDocument();
    expect(screen.getByText("Another Agent")).toBeInTheDocument();
    expect(screen.getByText("mcpc_def456")).toBeInTheDocument();

    // Scope badges
    expect(screen.getByText("credentials:list")).toBeInTheDocument();
    expect(screen.getByText("credentials:use")).toBeInTheDocument();
    expect(screen.getByText("vault:unlock-data")).toBeInTheDocument();
    expect(screen.getByText("passwords:read")).toBeInTheDocument();

    // Date fields
    expect(screen.getAllByText(/created:/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/expires:/i).length).toBeGreaterThan(0);
  });

  it("revoke connection — DELETE called with correct URL, success toast, item removed from DOM", async () => {
    setupFetchConnections();

    await act(async () => {
      render(<McpConnectionsCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("My MCP Agent")).toBeInTheDocument();
      expect(screen.getByText("Another Agent")).toBeInTheDocument();
    });

    // Click the first alert action (confirm revoke for token-1)
    const alertActions = screen.getAllByTestId("alert-action");
    await act(async () => {
      fireEvent.click(alertActions[0]);
    });

    await waitFor(() => {
      const deleteCalls = mockFetch.mock.calls.filter(
        (c: unknown[]) => (c[1] as Record<string, unknown>)?.method === "DELETE"
      );
      expect(deleteCalls.length).toBe(1);
      expect(deleteCalls[0][0]).toBe("/api/user/mcp-tokens/token-1");
    });

    // Success toast should be called
    expect(mockToast.success).toHaveBeenCalledWith("revokeSuccess");

    // Revoked item removed, other connection still present
    await waitFor(() => {
      expect(screen.queryByText("My MCP Agent")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Another Agent")).toBeInTheDocument();
  });

  it("shows error toast when revoke fails (non-ok response)", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ tokens: sampleConnections }),
        });
      }
      if (init.method === "DELETE") {
        return Promise.resolve({ ok: false, status: 404 });
      }
      return Promise.resolve({ ok: false });
    });

    await act(async () => {
      render(<McpConnectionsCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("My MCP Agent")).toBeInTheDocument();
    });

    const alertActions = screen.getAllByTestId("alert-action");
    await act(async () => {
      fireEvent.click(alertActions[0]);
    });

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("revokeError");
    });

    // Item must remain in DOM when revoke fails
    expect(screen.getByText("My MCP Agent")).toBeInTheDocument();
  });

  it("shows error toast when revoke throws network error", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ tokens: sampleConnections }),
        });
      }
      if (init.method === "DELETE") {
        return Promise.reject(new Error("Network error"));
      }
      return Promise.resolve({ ok: false });
    });

    await act(async () => {
      render(<McpConnectionsCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("My MCP Agent")).toBeInTheDocument();
    });

    const alertActions = screen.getAllByTestId("alert-action");
    await act(async () => {
      fireEvent.click(alertActions[0]);
    });

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("revokeError");
    });

    // Item must remain in DOM when revoke throws
    expect(screen.getByText("My MCP Agent")).toBeInTheDocument();
  });
});
