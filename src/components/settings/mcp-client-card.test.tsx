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

vi.mock("@/components/passwords/copy-button", () => ({
  CopyButton: ({ getValue }: { getValue: () => string }) => (
    <button data-testid="copy-button" data-value={getValue()}>
      Copy
    </button>
  ),
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div data-testid="card" className={className}>
      {children}
    </div>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} />
  ),
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({
    children,
    variant,
  }: {
    children: ReactNode;
    variant?: string;
  }) => (
    <span data-testid="badge" data-variant={variant}>
      {children}
    </span>
  ),
}));

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
  }: {
    checked?: boolean;
    onCheckedChange?: (v: boolean) => void;
  }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
      data-testid="checkbox"
    />
  ),
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    id,
    checked,
    onCheckedChange,
  }: {
    id?: string;
    checked?: boolean;
    onCheckedChange?: (v: boolean) => void;
  }) => (
    <input
      type="checkbox"
      id={id}
      checked={checked}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
      data-testid="switch"
    />
  ),
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <textarea {...props} />
  ),
}));

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTrigger: ({
    children,
  }: {
    children: ReactNode;
    asChild?: boolean;
  }) => <div data-testid="alert-trigger">{children}</div>,
  AlertDialogContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="alert-content">{children}</div>
  ),
  AlertDialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogTitle: ({ children }: { children: ReactNode }) => (
    <h2>{children}</h2>
  ),
  AlertDialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  AlertDialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
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

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
    onOpenChange,
  }: {
    children: ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => (
    <div data-testid="dialog" data-open={open} onClick={() => onOpenChange?.(false)}>
      {open ? children : null}
    </div>
  ),
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="dialog-content" onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => (
    <h2>{children}</h2>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...rest
  }: React.ComponentProps<"button">) => (
    <button onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}));

import { McpClientCard } from "./mcp-client-card";

const sampleClients = [
  {
    id: "client-1",
    name: "My MCP Agent",
    clientId: "mcpc_abc123",
    redirectUris: ["https://agent.example.com/callback"],
    allowedScopes: "credentials:read,credentials:list",
    isActive: true,
    isDcr: false,
    createdAt: "2025-01-01T00:00:00Z",
  },
  {
    id: "client-2",
    name: "Another Agent",
    clientId: "mcpc_def456",
    redirectUris: ["https://other.example.com/callback"],
    allowedScopes: "vault:status",
    isActive: false,
    isDcr: false,
    createdAt: "2025-01-02T00:00:00Z",
  },
];

function setupFetchClients(clients = sampleClients) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (!init?.method || init.method === "GET") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ clients }),
      });
    }
    if (init.method === "POST") {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            client: {
              id: "client-new",
              clientId: "mcpc_newclientid",
              clientSecret: "super_secret_value",
              name: "New Client",
              redirectUris: ["https://new.example.com/callback"],
              allowedScopes: "credentials:read",
              isActive: true,
              createdAt: "2025-01-03T00:00:00Z",
            },
          }),
      });
    }
    if (init.method === "PUT") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ client: {} }),
      });
    }
    if (init.method === "DELETE") {
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({ ok: false });
  });
}

describe("McpClientCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading spinner initially", async () => {
    // Never resolve to keep loading state
    mockFetch.mockReturnValue(new Promise(() => {}));

    render(<McpClientCard />);

    // Loader2 renders as SVG; check for animate-spin class
    const spinner = document.querySelector(".animate-spin");
    expect(spinner).toBeInTheDocument();
  });

  it("shows empty state when no clients", async () => {
    setupFetchClients([]);

    await act(async () => {
      render(<McpClientCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noMcpClients")).toBeInTheDocument();
    });
  });

  it("renders client list with name, clientId, scope badges, and active badge", async () => {
    setupFetchClients();

    await act(async () => {
      render(<McpClientCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("My MCP Agent")).toBeInTheDocument();
    });

    // Active client is visible immediately
    expect(screen.getByText("mcpc_abc123")).toBeInTheDocument();

    // Inactive client is hidden behind the collapsible trigger; expand it first
    const inactiveTrigger = screen.getByText(/mcpInactive/);
    fireEvent.click(inactiveTrigger);

    await waitFor(() => {
      expect(screen.getByText("Another Agent")).toBeInTheDocument();
    });
    expect(screen.getByText("mcpc_def456")).toBeInTheDocument();

    // Scope badges
    expect(screen.getByText("credentials:read")).toBeInTheDocument();
    expect(screen.getByText("credentials:list")).toBeInTheDocument();
    expect(screen.getByText("vault:status")).toBeInTheDocument();

    // Active/inactive badges
    const badges = screen.getAllByTestId("badge");
    expect(badges.some((b) => b.textContent === "mcpActive")).toBe(true);
    expect(badges.some((b) => b.textContent === "mcpInactive")).toBe(true);
  });

  it("create client — fills form, submits, verifies fetchApi called", async () => {
    setupFetchClients([]);

    await act(async () => {
      render(<McpClientCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noMcpClients")).toBeInTheDocument();
    });

    // Open create dialog
    const registerBtn = screen.getAllByRole("button").find(
      (b) => b.textContent?.includes("registerMcpClient")
    );
    expect(registerBtn).toBeDefined();
    await act(async () => {
      fireEvent.click(registerBtn!);
    });

    // Fill name
    const nameInput = screen.getByPlaceholderText("mcpNamePlaceholder");
    fireEvent.change(nameInput, { target: { value: "Test Client" } });

    // Fill redirect URI
    const textarea = screen.getByPlaceholderText("mcpRedirectUrisPlaceholder");
    fireEvent.change(textarea, { target: { value: "https://test.example.com/callback" } });

    // Select a scope checkbox
    const checkboxes = screen.getAllByTestId("checkbox");
    expect(checkboxes.length).toBeGreaterThan(0);
    fireEvent.click(checkboxes[0]);

    // Submit
    const createBtn = screen.getAllByRole("button").find(
      (b) => b.textContent?.includes("create")
    );
    expect(createBtn).toBeDefined();
    await act(async () => {
      fireEvent.click(createBtn!);
    });

    await waitFor(() => {
      const postCalls = mockFetch.mock.calls.filter(
        (c: unknown[]) => (c[1] as Record<string, unknown>)?.method === "POST"
      );
      expect(postCalls.length).toBe(1);
    });
  });

  it("create — shows clientId and clientSecret once, close → gone", async () => {
    setupFetchClients([]);

    await act(async () => {
      render(<McpClientCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noMcpClients")).toBeInTheDocument();
    });

    // Open create dialog
    const registerBtn = screen.getAllByRole("button").find(
      (b) => b.textContent?.includes("registerMcpClient")
    );
    await act(async () => {
      fireEvent.click(registerBtn!);
    });

    // Fill required fields
    const nameInput = screen.getByPlaceholderText("mcpNamePlaceholder");
    fireEvent.change(nameInput, { target: { value: "New Client" } });

    const textarea = screen.getByPlaceholderText("mcpRedirectUrisPlaceholder");
    fireEvent.change(textarea, { target: { value: "https://new.example.com/callback" } });

    const checkboxes = screen.getAllByTestId("checkbox");
    fireEvent.click(checkboxes[0]);

    // Submit
    const createBtn = screen.getAllByRole("button").find(
      (b) => b.textContent?.includes("create")
    );
    await act(async () => {
      fireEvent.click(createBtn!);
    });

    // Credentials should now be visible
    await waitFor(() => {
      expect(screen.getByDisplayValue("mcpc_newclientid")).toBeInTheDocument();
      expect(screen.getByDisplayValue("super_secret_value")).toBeInTheDocument();
    });

    // Click OK to dismiss
    const okButton = screen.getByRole("button", { name: "OK" });
    await act(async () => {
      fireEvent.click(okButton);
    });

    // Credentials should be gone
    expect(screen.queryByDisplayValue("mcpc_newclientid")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("super_secret_value")).not.toBeInTheDocument();
  });

  it("create — shows name error on 409 MCP_CLIENT_NAME_CONFLICT", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ clients: [] }),
        });
      }
      if (init.method === "POST") {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: () => Promise.resolve({ error: "MCP_CLIENT_NAME_CONFLICT" }),
        });
      }
      return Promise.resolve({ ok: false });
    });

    await act(async () => {
      render(<McpClientCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noMcpClients")).toBeInTheDocument();
    });

    // Open dialog and fill form
    const registerBtn = screen.getAllByRole("button").find(
      (b) => b.textContent?.includes("registerMcpClient")
    );
    await act(async () => {
      fireEvent.click(registerBtn!);
    });

    const nameInput = screen.getByPlaceholderText("mcpNamePlaceholder");
    fireEvent.change(nameInput, { target: { value: "Duplicate Name" } });

    const textarea = screen.getByPlaceholderText("mcpRedirectUrisPlaceholder");
    fireEvent.change(textarea, { target: { value: "https://example.com/callback" } });

    const checkboxes = screen.getAllByTestId("checkbox");
    fireEvent.click(checkboxes[0]);

    const createBtn = screen.getAllByRole("button").find(
      (b) => b.textContent?.includes("create")
    );
    await act(async () => {
      fireEvent.click(createBtn!);
    });

    await waitFor(() => {
      expect(screen.getByText("mcpNameConflict")).toBeInTheDocument();
    });
  });

  it("delete client — confirm dialog, verify DELETE called", async () => {
    setupFetchClients();

    await act(async () => {
      render(<McpClientCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("My MCP Agent")).toBeInTheDocument();
    });

    // Click the alert action button (delete confirm)
    const alertActions = screen.getAllByTestId("alert-action");
    await act(async () => {
      fireEvent.click(alertActions[0]);
    });

    await waitFor(() => {
      const deleteCalls = mockFetch.mock.calls.filter(
        (c: unknown[]) => (c[1] as Record<string, unknown>)?.method === "DELETE"
      );
      expect(deleteCalls.length).toBe(1);
    });
  });

  it("edit client — open edit, change name, submit PUT", async () => {
    setupFetchClients();

    await act(async () => {
      render(<McpClientCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("My MCP Agent")).toBeInTheDocument();
    });

    // Find and click the edit (pencil) button — it's a ghost/icon button
    // The edit buttons are rendered between the client name and the delete button
    // Use getAllByRole to find buttons with Pencil icon (no text content)
    const allButtons = screen.getAllByRole("button");
    // Edit buttons have no text content (only icon SVG); find them among non-alert-action buttons
    const editButtons = allButtons.filter((b) => {
      const testId = b.getAttribute("data-testid");
      return !testId && b.closest("[data-testid='alert-trigger']") === null &&
        !b.textContent?.includes("registerMcpClient") &&
        !b.textContent?.includes("cancel") &&
        !b.textContent?.includes("delete") &&
        b.textContent?.trim() === "";
    });
    expect(editButtons.length).toBeGreaterThan(0);

    await act(async () => {
      fireEvent.click(editButtons[0]);
    });

    // Edit dialog should be open with current name pre-filled
    await waitFor(() => {
      expect(screen.getByText("editMcpClient")).toBeInTheDocument();
    });

    // Change the name
    const nameInput = screen.getByDisplayValue("My MCP Agent");
    fireEvent.change(nameInput, { target: { value: "Renamed Agent" } });

    // Submit
    const saveBtn = screen.getAllByRole("button").find(
      (b) => b.textContent?.includes("save")
    );
    expect(saveBtn).toBeDefined();
    await act(async () => {
      fireEvent.click(saveBtn!);
    });

    await waitFor(() => {
      const putCalls = mockFetch.mock.calls.filter(
        (c: unknown[]) => (c[1] as Record<string, unknown>)?.method === "PUT"
      );
      expect(putCalls.length).toBe(1);
    });
  });
});
