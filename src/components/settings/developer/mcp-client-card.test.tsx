// @vitest-environment jsdom
import { REDIRECT_URI_ACCEPT_SET_MESSAGE } from "@/lib/constants/auth/mcp";
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

const { mockFetch, mockToast, mockCanUsePasskeyRecovery, mockReauthenticateWithPasskey } = vi.hoisted(() => ({
  mockCanUsePasskeyRecovery: vi.fn(),
  mockReauthenticateWithPasskey: vi.fn(),
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

vi.mock("@/components/passwords/shared/copy-button", () => ({
  CopyButton: ({ getValue }: { getValue: () => string }) => (
    <button data-testid="copy-button" data-value={getValue()}>
      Copy
    </button>
  ),
}));

import "@/__tests__/helpers/passkey-reauth-mocks";

vi.mock("@/lib/auth/webauthn/can-use-passkey-recovery", () => ({
  canUsePasskeyRecovery: mockCanUsePasskeyRecovery,
}));

vi.mock("@/lib/auth/webauthn/passkey-reauth-client", () => ({
  reauthenticateWithPasskey: mockReauthenticateWithPasskey,
}));

vi.mock("@/components/settings/account/section-card-header", () => ({
  SectionCardHeader: ({ title, description, action }: { title: string; description: string; action?: ReactNode }) => (
    <div data-testid="section-card-header"><span>{title}</span><span>{description}</span>{action}</div>
  ),
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div data-testid="card" className={className}>
      {children}
    </div>
  ),
  CardHeader: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div data-testid="card-header" className={className}>{children}</div>
  ),
  CardContent: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div data-testid="card-content" className={className}>{children}</div>
  ),
  CardTitle: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div data-testid="card-title" className={className}>{children}</div>
  ),
  CardDescription: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div data-testid="card-description" className={className}>{children}</div>
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
  {
    id: "client-3",
    name: "DCR Agent",
    clientId: "mcpc_dcr789",
    redirectUris: ["https://dcr.example.com/callback"],
    allowedScopes: "credentials:read",
    isActive: true,
    isDcr: true,
    createdAt: "2025-01-03T00:00:00Z",
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
    // Default: user has no passkey → recent-session dialog opens. Tests
    // exercising the inline passkey reauth path override this.
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
    mockReauthenticateWithPasskey.mockResolvedValue({ ok: true, verifiedAt: "2026-05-10T00:00:00Z" });
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
    expect(screen.getAllByText("credentials:read").length).toBeGreaterThan(0);
    expect(screen.getByText("credentials:list")).toBeInTheDocument();
    expect(screen.getByText("vault:status")).toBeInTheDocument();

    // Active/inactive badges
    const badges = screen.getAllByTestId("badge");
    expect(badges.some((b) => b.textContent === "mcpActive")).toBe(true);
    expect(badges.some((b) => b.textContent === "mcpInactive")).toBe(true);
  });

  it("notes a client whose creator lost access only for false: not for true, null (DCR or legacy) or an absent flag", async () => {
    const client = (id: string, name: string, extra: Record<string, unknown>) => ({
      ...sampleClients[0],
      id,
      name,
      clientId: `mcpc_${id}`,
      ...extra,
    });
    setupFetchClients([
      client("c-false", "Orphaned", { creatorAuthorized: false }),
      client("c-true", "Healthy", { creatorAuthorized: true }),
      client("c-null", "Claimed DCR", { isDcr: true, creatorAuthorized: null }),
      client("c-absent", "Older server", {}),
    ]);

    await act(async () => {
      render(<McpClientCard />);
    });
    await waitFor(() => expect(screen.getByText("Orphaned")).toBeInTheDocument());

    const rowOf = (name: string) => screen.getByText(name).closest(".border") as HTMLElement;
    expect(within(rowOf("Orphaned")).getByText("creatorUnauthorized")).toBeInTheDocument();
    for (const name of ["Healthy", "Claimed DCR", "Older server"]) {
      expect(within(rowOf(name)).queryByText("creatorUnauthorized")).not.toBeInTheDocument();
    }
    expect(screen.getAllByText("creatorUnauthorized")).toHaveLength(1);
  });

  it("renders DCR badge for clients with isDcr: true", async () => {
    setupFetchClients();

    await act(async () => {
      render(<McpClientCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("DCR Agent")).toBeInTheDocument();
    });

    // DCR badge should be visible for the active DCR client
    const badges = screen.getAllByTestId("badge");
    expect(badges.some((b) => b.textContent === "DCR")).toBe(true);
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

    const createBtn = screen.getAllByRole("button").find(
      (b) => b.textContent?.includes("create")
    );
    expect(createBtn).toBeDefined();
    expect(createBtn).toBeDisabled();

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

    expect(createBtn).not.toBeDisabled();

    // Submit
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

  it("create — surfaces redirect URI validation errors inline instead of generic failure", async () => {
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
          status: 400,
          json: () => Promise.resolve({
            error: "VALIDATION_ERROR",
            details: {
              errors: [],
              properties: {
                redirectUris: {
                  errors: [],
                  // Mirror the message the route actually emits — a mock that
                  // pins a string no route can produce stops being a fixture
                  // and becomes a second, stale copy of the contract.
                  items: [{ errors: [`redirect_uri ${REDIRECT_URI_ACCEPT_SET_MESSAGE}`] }],
                },
              },
            },
          }),
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

    const registerBtn = screen.getAllByRole("button").find(
      (b) => b.textContent?.includes("registerMcpClient")
    );
    await act(async () => {
      fireEvent.click(registerBtn!);
    });

    fireEvent.change(screen.getByPlaceholderText("mcpNamePlaceholder"), {
      target: { value: "Loopback Client" },
    });
    fireEvent.change(screen.getByPlaceholderText("mcpRedirectUrisPlaceholder"), {
      target: { value: "http://localhost/callback" },
    });
    fireEvent.click(screen.getAllByTestId("checkbox")[0]);

    const createBtn = screen.getAllByRole("button").find(
      (b) => b.textContent?.includes("create")
    );
    await act(async () => {
      fireEvent.click(createBtn!);
    });

    await waitFor(() => {
      expect(screen.getByText("mcpRedirectUriInvalid")).toBeInTheDocument();
    });
    expect(mockToast.error).not.toHaveBeenCalledWith("mcpCreateFailed");
  });

  it("create — opens RecentSessionRequiredDialog when SESSION_STEP_UP_REQUIRED is returned", async () => {
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
          status: 403,
          json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
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

    const registerBtn = screen.getAllByRole("button").find(
      (b) => b.textContent?.includes("registerMcpClient")
    );
    await act(async () => {
      fireEvent.click(registerBtn!);
    });

    fireEvent.change(screen.getByPlaceholderText("mcpNamePlaceholder"), {
      target: { value: "Loopback Client" },
    });
    fireEvent.change(screen.getByPlaceholderText("mcpRedirectUrisPlaceholder"), {
      target: { value: "http://localhost:3000/callback" },
    });
    fireEvent.click(screen.getAllByTestId("checkbox")[0]);

    const createBtn = screen.getAllByRole("button").find(
      (b) => b.textContent?.includes("create")
    );
    await act(async () => {
      fireEvent.click(createBtn!);
    });

    await waitFor(() => {
      expect(screen.getByTestId("recent-session-dialog")).toBeInTheDocument();
    });
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("create — falls back to local mcpCreateFailed for an unrecognized API error code", async () => {
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
          status: 500,
          json: () => Promise.resolve({ error: "BOGUS_NOT_IN_ALLOWLIST" }),
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

    const registerBtn = screen.getAllByRole("button").find(
      (b) => b.textContent?.includes("registerMcpClient")
    );
    await act(async () => {
      fireEvent.click(registerBtn!);
    });

    fireEvent.change(screen.getByPlaceholderText("mcpNamePlaceholder"), {
      target: { value: "Loopback Client" },
    });
    fireEvent.change(screen.getByPlaceholderText("mcpRedirectUrisPlaceholder"), {
      target: { value: "http://localhost:3000/callback" },
    });
    fireEvent.click(screen.getAllByTestId("checkbox")[0]);

    const createBtn = screen.getAllByRole("button").find(
      (b) => b.textContent?.includes("create")
    );
    await act(async () => {
      fireEvent.click(createBtn!);
    });

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("mcpCreateFailed");
    });
  });

  it("delete client — opens RecentSessionRequiredDialog when SESSION_STEP_UP_REQUIRED is returned", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ clients: sampleClients }),
        });
      }
      if (init.method === "DELETE") {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
        });
      }
      return Promise.resolve({ ok: false });
    });

    await act(async () => {
      render(<McpClientCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("My MCP Agent")).toBeInTheDocument();
    });

    const alertActions = screen.getAllByTestId("alert-action");
    await act(async () => {
      fireEvent.click(alertActions[0]);
    });

    await waitFor(() => {
      expect(screen.getByTestId("recent-session-dialog")).toBeInTheDocument();
    });
    expect(mockToast.error).not.toHaveBeenCalled();
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

  it("edit client — opens RecentSessionRequiredDialog when SESSION_STEP_UP_REQUIRED is returned", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ clients: sampleClients }),
        });
      }
      if (init.method === "PUT") {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
        });
      }
      return Promise.resolve({ ok: false });
    });

    await act(async () => {
      render(<McpClientCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("My MCP Agent")).toBeInTheDocument();
    });

    const allButtons = screen.getAllByRole("button");
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

    await waitFor(() => {
      expect(screen.getByText("editMcpClient")).toBeInTheDocument();
    });

    const nameInput = screen.getByDisplayValue("My MCP Agent");
    fireEvent.change(nameInput, { target: { value: "Renamed Agent" } });

    const saveBtn = screen.getAllByRole("button").find(
      (b) => b.textContent?.includes("save")
    );
    expect(saveBtn).toBeDefined();
    await act(async () => {
      fireEvent.click(saveBtn!);
    });

    await waitFor(() => {
      expect(screen.getByTestId("recent-session-dialog")).toBeInTheDocument();
    });
    expect(mockToast.error).not.toHaveBeenCalled();
  });
});

describe("McpClientCard edit, delete and list details", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
  });

  type MutationResponse = { ok: boolean; status?: number; body?: unknown };

  // GET returns `clients`; every mutating method answers with `response`.
  function setupMutation(response: MutationResponse, clients: unknown[] = sampleClients) {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ clients }) });
      }
      return Promise.resolve({
        ok: response.ok,
        status: response.status ?? 200,
        json: () => Promise.resolve(response.body ?? {}),
      });
    });
  }

  function callsWith(method: string) {
    return mockFetch.mock.calls.filter(
      (c: unknown[]) => (c[1] as RequestInit | undefined)?.method === method,
    );
  }

  function rowOf(name: string): HTMLElement {
    return screen.getByText(name).closest(".border") as HTMLElement;
  }

  async function renderLoaded(firstName: string) {
    await act(async () => {
      render(<McpClientCard />);
    });
    await waitFor(() => expect(screen.getByText(firstName)).toBeInTheDocument());
  }

  async function openEdit(name: string) {
    const editButton = within(rowOf(name))
      .getAllByRole("button")
      .find((b) => b.closest("[data-testid='alert-trigger']") === null && b.textContent?.trim() === "");
    if (!editButton) throw new Error(`no edit button for ${name}`);
    await act(async () => {
      fireEvent.click(editButton);
    });
    await waitFor(() => expect(screen.getByText("editMcpClient")).toBeInTheDocument());
  }

  async function saveEdit() {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "save" }));
    });
  }

  it("sends the redirect URIs when editing a manually registered client", async () => {
    setupMutation({ ok: true });
    await renderLoaded("My MCP Agent");
    await openEdit("My MCP Agent");
    fireEvent.change(screen.getByDisplayValue("My MCP Agent"), { target: { value: "  Renamed  " } });

    await saveEdit();

    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("mcpUpdated"));
    const [url, init] = callsWith("PUT")[0] as [string, RequestInit];
    expect(url).toContain("client-1");
    expect(JSON.parse(String(init.body))).toEqual({
      name: "Renamed",
      allowedScopes: ["credentials:read", "credentials:list"],
      isActive: true,
      redirectUris: ["https://agent.example.com/callback"],
    });
    expect(screen.queryByText("editMcpClient")).not.toBeInTheDocument();
  });

  it("omits the immutable redirect URIs when editing a DCR client", async () => {
    setupMutation({ ok: true });
    await renderLoaded("DCR Agent");
    await openEdit("DCR Agent");
    expect(screen.getByText("mcpDcrFieldsReadOnly")).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue("DCR Agent"), { target: { value: "DCR Renamed" } });

    await saveEdit();

    await waitFor(() => expect(callsWith("PUT")).toHaveLength(1));
    const [, init] = callsWith("PUT")[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).not.toHaveProperty("redirectUris");
  });

  it("rejects an unacceptable redirect URI on edit without sending it", async () => {
    setupMutation({ ok: true });
    await renderLoaded("My MCP Agent");
    await openEdit("My MCP Agent");
    fireEvent.change(screen.getByDisplayValue("https://agent.example.com/callback"), {
      target: { value: "ftp://agent.example.com/callback" },
    });

    await saveEdit();

    expect(screen.getByText("mcpRedirectUriInvalid")).toBeInTheDocument();
    expect(callsWith("PUT")).toHaveLength(0);
  });

  it("requires a name and at least one scope on edit", async () => {
    setupMutation({ ok: true });
    await renderLoaded("My MCP Agent");
    fireEvent.click(screen.getByText(/mcpInactive \(/));
    await waitFor(() => expect(screen.getByText("Another Agent")).toBeInTheDocument());
    await openEdit("Another Agent");
    fireEvent.change(screen.getByDisplayValue("Another Agent"), { target: { value: " " } });
    // The only granted scope of this client is vault:status; untick it.
    const vaultStatus = screen
      .getAllByTestId("checkbox")
      .find((c) => c.closest("label")?.textContent === "vault:status") as HTMLElement;
    fireEvent.click(vaultStatus);

    await saveEdit();

    expect(screen.getByText("mcpNameRequired")).toBeInTheDocument();
    expect(screen.getByText("mcpScopeRequired")).toBeInTheDocument();
    expect(callsWith("PUT")).toHaveLength(0);
  });

  it("shows a name conflict inline on a 409 edit response", async () => {
    setupMutation({ ok: false, status: 409, body: { error: "MCP_CLIENT_NAME_CONFLICT" } });
    await renderLoaded("My MCP Agent");
    await openEdit("My MCP Agent");
    fireEvent.change(screen.getByDisplayValue("My MCP Agent"), { target: { value: "Taken" } });

    await saveEdit();

    await waitFor(() => expect(screen.getByText("mcpNameConflict")).toBeInTheDocument());
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("maps a 400 scope validation error on edit to the inline scope message", async () => {
    setupMutation({
      ok: false,
      status: 400,
      body: { error: "VALIDATION_ERROR", details: { properties: { allowedScopes: { errors: ["bad"] } } } },
    });
    await renderLoaded("My MCP Agent");
    await openEdit("My MCP Agent");
    fireEvent.change(screen.getByDisplayValue("My MCP Agent"), { target: { value: "Renamed" } });

    await saveEdit();

    await waitFor(() => expect(screen.getByText("mcpScopeRequired")).toBeInTheDocument());
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("toasts mcpUpdateFailed for an unrecognized edit failure", async () => {
    setupMutation({ ok: false, status: 500, body: { error: "BOGUS_NOT_IN_ALLOWLIST" } });
    await renderLoaded("My MCP Agent");
    await openEdit("My MCP Agent");
    fireEvent.change(screen.getByDisplayValue("My MCP Agent"), { target: { value: "Renamed" } });

    await saveEdit();

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("mcpUpdateFailed"));
    expect(screen.getByText("editMcpClient")).toBeInTheDocument();
  });

  it("discards unsaved edits when the edit dialog is dismissed", async () => {
    setupMutation({ ok: true });
    await renderLoaded("My MCP Agent");
    await openEdit("My MCP Agent");
    fireEvent.change(screen.getByDisplayValue("My MCP Agent"), { target: { value: "Draft" } });

    const editDialog = screen
      .getAllByTestId("dialog")
      .find((d) => d.getAttribute("data-open") === "true") as HTMLElement;
    fireEvent.click(editDialog);
    await openEdit("My MCP Agent");

    expect(screen.getByDisplayValue("My MCP Agent")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Draft")).not.toBeInTheDocument();
  });

  it("toasts mcpDeleted after a successful delete", async () => {
    setupMutation({ ok: true });
    await renderLoaded("My MCP Agent");

    await act(async () => {
      fireEvent.click(within(rowOf("My MCP Agent")).getByTestId("alert-action"));
    });

    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("mcpDeleted"));
    expect(callsWith("DELETE")[0][0]).toContain("client-1");
  });

  it("toasts mcpDeleteFailed when the delete is rejected", async () => {
    setupMutation({ ok: false, status: 500, body: { error: "INTERNAL_ERROR" } });
    await renderLoaded("My MCP Agent");

    await act(async () => {
      fireEvent.click(within(rowOf("My MCP Agent")).getByTestId("alert-action"));
    });

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("mcpDeleteFailed"));
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it("filters clients by name or client ID and reports when nothing matches", async () => {
    setupMutation({ ok: true });
    await renderLoaded("My MCP Agent");
    const search = screen.getByPlaceholderText("mcpSearchPlaceholder");

    fireEvent.change(search, { target: { value: "DCR789" } });
    expect(screen.getByText("DCR Agent")).toBeInTheDocument();
    expect(screen.queryByText("My MCP Agent")).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "nothing-like-this" } });
    expect(screen.getByText("mcpNoMatchingClients")).toBeInTheDocument();
  });

  it("says there are no active clients when only inactive ones exist", async () => {
    setupMutation({ ok: true }, [sampleClients[1]]);
    await act(async () => {
      render(<McpClientCard />);
    });
    expect(await screen.findByText("noActiveMcpClients")).toBeInTheDocument();
  });

  it("lists connected users by name, then email, then a fallback", async () => {
    setupMutation({ ok: true }, [
      {
        ...sampleClients[0],
        connectedUsers: [
          { name: "Alice", email: "alice@example.com" },
          { name: null, email: "bob@example.com" },
          { name: null, email: null },
        ],
      },
    ]);
    await renderLoaded("My MCP Agent");
    expect(screen.getByText("Alice, bob@example.com, mcpUnknownUser")).toBeInTheDocument();
  });

  it("truncates a long client ID and keeps the full value in the title", async () => {
    const clientId = "mcpc_0123456789abcdefghij";
    setupMutation({ ok: true }, [{ ...sampleClients[0], clientId, lastUsedAt: "2025-02-01T00:00:00Z" }]);
    await renderLoaded("My MCP Agent");

    const shown = screen.getByTitle(clientId);
    expect(shown).toHaveTextContent(`${clientId.slice(0, 16)}…`);
    expect(screen.getByText("mcpLastUsed")).toBeInTheDocument();
  });

  it("toasts mcpLimitReached when the create hits the client limit", async () => {
    setupMutation({ ok: false, status: 422, body: { error: "MCP_CLIENT_LIMIT_EXCEEDED" } }, []);
    await act(async () => {
      render(<McpClientCard />);
    });
    await waitFor(() => expect(screen.getByText("noMcpClients")).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /registerMcpClient/ }));
    });
    fireEvent.change(screen.getByPlaceholderText("mcpNamePlaceholder"), { target: { value: "One more" } });
    fireEvent.change(screen.getByPlaceholderText("mcpRedirectUrisPlaceholder"), {
      target: { value: "https://agent.example.com/cb" },
    });
    fireEvent.click(screen.getAllByTestId("checkbox")[0]);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "create" }));
    });

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("mcpLimitReached"));
  });
});
