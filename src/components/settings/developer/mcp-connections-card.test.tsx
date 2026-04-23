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

vi.mock("@/lib/format/format-datetime", () => ({
  formatDateTime: (date: string) => date,
}));

vi.mock("@/components/settings/account/section-card-header", () => ({
  SectionCardHeader: ({ title, description, action }: { title: string; description: string; action?: ReactNode }) => (
    <div data-testid="section-card-header"><span>{title}</span><span>{description}</span>{action && <div data-testid="header-action">{action}</div>}</div>
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

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}));

vi.mock("@/components/settings/developer/scope-badges", () => ({
  ScopeBadges: ({ scopes }: { scopes: string }) => (
    <span data-testid="scope-badges">{scopes}</span>
  ),
}));

import { McpConnectionsCard } from "./mcp-connections-card";

const sampleClients = [
  {
    id: "client-db-1",
    clientId: "mcpc_abc123",
    name: "My MCP Agent",
    isDcr: false,
    allowedScopes: "credentials:list,credentials:use",
    clientCreatedAt: "2024-06-01T00:00:00Z",
    connection: {
      tokenId: "token-1",
      scope: "credentials:list credentials:use",
      createdAt: "2025-01-01T00:00:00Z",
      expiresAt: "2026-01-01T00:00:00Z",
      lastUsedAt: "2025-03-15T10:00:00Z",
    },
  },
  {
    id: "client-db-2",
    clientId: "mcpc_def456",
    name: "Another Agent",
    isDcr: false,
    allowedScopes: "vault:unlock-data,passwords:read",
    clientCreatedAt: "2024-07-01T00:00:00Z",
    connection: {
      tokenId: "token-2",
      scope: "vault:unlock-data,passwords:read",
      createdAt: "2025-02-01T00:00:00Z",
      expiresAt: "2026-02-01T00:00:00Z",
      lastUsedAt: null,
    },
  },
];

function setupFetchClients(clients = sampleClients) {
  mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
    if (!init?.method || init.method === "GET") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ clients }),
      });
    }
    if (init.method === "DELETE") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ revokedCount: 2 }),
      });
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

  it("shows empty state when no clients", async () => {
    setupFetchClients([]);

    await act(async () => {
      render(<McpConnectionsCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noClients")).toBeInTheDocument();
    });

    expect(screen.getByText("noClientsDescription")).toBeInTheDocument();
  });

  it("shows empty state when initial fetch throws network error", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    await act(async () => {
      render(<McpConnectionsCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noClients")).toBeInTheDocument();
    });
  });

  it("renders client list with name, clientId, and connected/notConnected badges", async () => {
    setupFetchClients();

    await act(async () => {
      render(<McpConnectionsCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("My MCP Agent")).toBeInTheDocument();
    });

    expect(screen.getByText("mcpc_abc123")).toBeInTheDocument();
    expect(screen.getByText("Another Agent")).toBeInTheDocument();
    expect(screen.getByText("mcpc_def456")).toBeInTheDocument();

    // Connection status badges — both clients have connections
    expect(screen.getAllByText("connected").length).toBeGreaterThan(0);

    // Scope badges rendered (mocked ScopeBadges shows raw scope string)
    const scopeBadges = screen.getAllByTestId("scope-badges");
    expect(scopeBadges.length).toBeGreaterThan(0);

    // Date fields — registeredAt, created, expires, lastUsed
    expect(screen.getAllByText(/registeredAt/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/created:/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/expires:/i).length).toBeGreaterThan(0);
  });

  it("revoke connection — DELETE called with tokenId URL, success toast, item stays as notConnected", async () => {
    setupFetchClients();

    await act(async () => {
      render(<McpConnectionsCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("My MCP Agent")).toBeInTheDocument();
      expect(screen.getByText("Another Agent")).toBeInTheDocument();
    });

    // alertActions[0] is Revoke All; alertActions[1] is first client's individual revoke
    const alertActions = screen.getAllByTestId("alert-action");
    await act(async () => {
      fireEvent.click(alertActions[1]);
    });

    await waitFor(() => {
      const deleteCalls = mockFetch.mock.calls.filter(
        (c: unknown[]) => (c[1] as Record<string, unknown>)?.method === "DELETE"
      );
      expect(deleteCalls.length).toBe(1);
      // DELETE URL uses connection.tokenId
      expect(deleteCalls[0][0]).toBe("/api/user/mcp-tokens/token-1");
    });

    // Success toast should be called
    expect(mockToast.success).toHaveBeenCalledWith("revokeSuccess");

    // Revoked item stays in list but changes to notConnected
    await waitFor(() => {
      expect(screen.getByText("My MCP Agent")).toBeInTheDocument();
    });
    expect(screen.getByText("Another Agent")).toBeInTheDocument();
    // The revoked client now shows notConnected badge
    expect(screen.getByText("notConnected")).toBeInTheDocument();
  });

  it("shows error toast when revoke fails (non-ok response)", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ clients: sampleClients }),
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

    // alertActions[0] is Revoke All; alertActions[1] is first client's individual revoke
    const alertActions = screen.getAllByTestId("alert-action");
    await act(async () => {
      fireEvent.click(alertActions[1]);
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
          json: () => Promise.resolve({ clients: sampleClients }),
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

    // alertActions[0] is Revoke All; alertActions[1] is first client's individual revoke
    const alertActions = screen.getAllByTestId("alert-action");
    await act(async () => {
      fireEvent.click(alertActions[1]);
    });

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("revokeError");
    });

    // Item must remain in DOM when revoke throws
    expect(screen.getByText("My MCP Agent")).toBeInTheDocument();
  });

  it("filters clients by name (case-insensitive)", async () => {
    setupFetchClients();
    await act(async () => { render(<McpConnectionsCard />); });
    await waitFor(() => expect(screen.getByText("My MCP Agent")).toBeInTheDocument());

    const searchInput = screen.getByPlaceholderText("searchPlaceholder");
    await act(async () => { fireEvent.change(searchInput, { target: { value: "another" } }); });

    expect(screen.queryByText("My MCP Agent")).not.toBeInTheDocument();
    expect(screen.getByText("Another Agent")).toBeInTheDocument();
  });

  it("shows noMatchingConnections when search has no results", async () => {
    setupFetchClients();
    await act(async () => { render(<McpConnectionsCard />); });
    await waitFor(() => expect(screen.getByText("My MCP Agent")).toBeInTheDocument());

    const searchInput = screen.getByPlaceholderText("searchPlaceholder");
    await act(async () => { fireEvent.change(searchInput, { target: { value: "nonexistent" } }); });

    expect(screen.getByText("noMatchingConnections")).toBeInTheDocument();
  });

  it("revoke all — calls DELETE on collection endpoint, clears all connections", async () => {
    setupFetchClients();
    await act(async () => { render(<McpConnectionsCard />); });
    await waitFor(() => expect(screen.getByText("My MCP Agent")).toBeInTheDocument());

    // alertActions[0] is the Revoke All confirm button
    const alertActions = screen.getAllByTestId("alert-action");
    await act(async () => { fireEvent.click(alertActions[0]); });

    await waitFor(() => {
      const deleteCalls = mockFetch.mock.calls.filter(
        (c: unknown[]) => (c[1] as Record<string, unknown>)?.method === "DELETE"
      );
      expect(deleteCalls.length).toBe(1);
      expect(deleteCalls[0][0]).toBe("/api/user/mcp-tokens");
    });

    expect(mockToast.success).toHaveBeenCalled();

    // Both clients should now show notConnected
    await waitFor(() => {
      expect(screen.getAllByText("notConnected").length).toBe(2);
    });
  });

  it("hides Revoke All when no connections exist", async () => {
    const noConnectionClients = [
      {
        id: "client-db-1",
        clientId: "mcpc_abc123",
        name: "My MCP Agent",
        isDcr: false,
        allowedScopes: "credentials:list",
        clientCreatedAt: "2024-06-01T00:00:00Z",
        connection: null,
      },
    ];
    setupFetchClients(noConnectionClients);
    await act(async () => { render(<McpConnectionsCard />); });
    await waitFor(() => expect(screen.getByText("My MCP Agent")).toBeInTheDocument());

    // No Revoke All button should be visible (no header-action rendered)
    expect(screen.queryByTestId("header-action")).not.toBeInTheDocument();
  });

  it("shows neverUsed when lastUsedAt is null", async () => {
    const clientWithNullLastUsed = [
      {
        id: "client-db-1",
        clientId: "mcpc_abc123",
        name: "My Agent",
        isDcr: false,
        allowedScopes: "credentials:list",
        clientCreatedAt: "2024-06-01T00:00:00Z",
        connection: {
          tokenId: "token-1",
          scope: "credentials:list",
          createdAt: "2025-01-01T00:00:00Z",
          expiresAt: "2026-01-01T00:00:00Z",
          lastUsedAt: null,
        },
      },
    ];
    setupFetchClients(clientWithNullLastUsed);
    await act(async () => { render(<McpConnectionsCard />); });
    await waitFor(() => expect(screen.getByText("My Agent")).toBeInTheDocument());

    expect(screen.getByText("neverUsed")).toBeInTheDocument();
  });
});
