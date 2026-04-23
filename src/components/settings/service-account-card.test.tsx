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

vi.mock("@/components/passwords/shared/copy-button", () => ({
  CopyButton: ({ getValue }: { getValue: () => string }) => (
    <button data-testid="copy-button" data-value={getValue()}>
      Copy
    </button>
  ),
}));

vi.mock("@/components/settings/section-card-header", () => ({
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
    checked,
    onCheckedChange,
    id,
  }: {
    checked?: boolean;
    onCheckedChange?: (v: boolean) => void;
    id?: string;
  }) => (
    <input
      type="checkbox"
      role="switch"
      id={id}
      checked={checked}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
      data-testid="switch"
    />
  ),
}));

vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({
    children,
    open,
    onOpenChange,
  }: {
    children: ReactNode;
    open?: boolean;
    onOpenChange?: () => void;
  }) => (
    <div data-open={open} onClick={onOpenChange}>
      {children}
    </div>
  ),
  CollapsibleContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  CollapsibleTrigger: ({
    children,
    className,
    asChild,
  }: {
    children: ReactNode;
    className?: string;
    asChild?: boolean;
  }) => {
    if (asChild) return <>{children}</>;
    return <button className={className}>{children}</button>;
  },
}));

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTrigger: ({
    children,
    asChild: _asChild,
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
  }: {
    children: ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="dialog-content">{children}</div>
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

import { ServiceAccountCard } from "./service-account-card";

const sampleAccounts = [
  {
    id: "sa-1",
    name: "deploy-bot",
    description: "CI deploy bot",
    isActive: true,
    createdAt: "2025-01-01T00:00:00Z",
  },
  {
    id: "sa-2",
    name: "read-only-agent",
    description: null,
    isActive: false,
    createdAt: "2025-01-02T00:00:00Z",
  },
];

const sampleTokens = [
  {
    id: "tok-1",
    name: "prod-token",
    prefix: "sa_abc",
    scope: ["passwords:read", "passwords:list"],
    expiresAt: "2026-01-01T00:00:00Z",
    lastUsedAt: null,
    revokedAt: null,
  },
];

function setupFetchAccounts(accounts = sampleAccounts) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (!init?.method || init.method === "GET") {
      if (url.includes("/tokens")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ tokens: sampleTokens }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ serviceAccounts: accounts }),
      });
    }
    if (init.method === "POST") {
      if (url.includes("/tokens")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ token: "sa_plaintext_token_value" }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: "sa-new", name: "new-account" }),
      });
    }
    if (init.method === "PUT") {
      return Promise.resolve({ ok: true });
    }
    if (init.method === "DELETE") {
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({ ok: false });
  });
}

describe("ServiceAccountCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows spinner while loading", async () => {
    // Never resolves so loading stays true
    mockFetch.mockImplementation(() => new Promise(() => {}));

    render(<ServiceAccountCard />);

    // Loader2 renders as SVG; check via animate-spin class
    const spinner = document.querySelector(".animate-spin");
    expect(spinner).toBeInTheDocument();
  });

  it("shows empty state when no service accounts", async () => {
    setupFetchAccounts([]);

    await act(async () => {
      render(<ServiceAccountCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noServiceAccounts")).toBeInTheDocument();
    });
  });

  it("renders service account list with names and active/inactive badges", async () => {
    setupFetchAccounts();

    await act(async () => {
      render(<ServiceAccountCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("deploy-bot")).toBeInTheDocument();
    });

    expect(screen.getByText("read-only-agent")).toBeInTheDocument();

    const badges = screen.getAllByTestId("badge");
    expect(badges.some((b) => b.textContent === "saActive")).toBe(true);
    expect(badges.some((b) => b.textContent === "saInactive")).toBe(true);
  });

  it("creates SA — calls fetchApi POST with correct body", async () => {
    setupFetchAccounts([]);

    await act(async () => {
      render(<ServiceAccountCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noServiceAccounts")).toBeInTheDocument();
    });

    // Open create dialog
    const createBtn = screen.getByText("createServiceAccount");
    await act(async () => {
      fireEvent.click(createBtn);
    });

    // Fill in name
    const nameInput = screen.getByPlaceholderText("saNamePlaceholder");
    fireEvent.change(nameInput, { target: { value: "my-new-sa" } });

    // Submit
    const submitBtn = screen.getByText("create");
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => {
      const postCalls = mockFetch.mock.calls.filter(
        (c: unknown[]) => (c[1] as Record<string, unknown>)?.method === "POST"
      );
      expect(postCalls.length).toBe(1);
      const body = JSON.parse(
        (postCalls[0][1] as Record<string, unknown>).body as string
      );
      expect(body.name).toBe("my-new-sa");
    });
  });

  it("shows name conflict error on 409 SA_NAME_CONFLICT", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ serviceAccounts: [] }),
        });
      }
      if (init.method === "POST") {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: () => Promise.resolve({ error: "SA_NAME_CONFLICT" }),
        });
      }
      return Promise.resolve({ ok: false });
    });

    await act(async () => {
      render(<ServiceAccountCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noServiceAccounts")).toBeInTheDocument();
    });

    const createBtn = screen.getByText("createServiceAccount");
    await act(async () => {
      fireEvent.click(createBtn);
    });

    const nameInput = screen.getByPlaceholderText("saNamePlaceholder");
    fireEvent.change(nameInput, { target: { value: "duplicate-sa" } });

    const submitBtn = screen.getByText("create");
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => {
      expect(screen.getByText("saNameConflict")).toBeInTheDocument();
    });
  });

  it("token create button is disabled for inactive service account", async () => {
    setupFetchAccounts([
      {
        id: "sa-inactive",
        name: "inactive-sa",
        description: null,
        isActive: false,
        createdAt: "2025-01-01T00:00:00Z",
      },
    ]);

    await act(async () => {
      render(<ServiceAccountCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("inactive-sa")).toBeInTheDocument();
    });

    // createToken button should be disabled for inactive SA
    const tokenBtns = screen
      .getAllByRole("button")
      .filter((b) => b.textContent?.includes("createToken"));
    expect(tokenBtns.length).toBeGreaterThan(0);
    expect(tokenBtns[0]).toBeDisabled();
  });

  it("shows plaintext token once after creation, token gone after dialog close", async () => {
    setupFetchAccounts([
      {
        id: "sa-active",
        name: "active-sa",
        description: null,
        isActive: true,
        createdAt: "2025-01-01T00:00:00Z",
      },
    ]);

    await act(async () => {
      render(<ServiceAccountCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("active-sa")).toBeInTheDocument();
    });

    // Open token create dialog
    const tokenBtns = screen
      .getAllByRole("button")
      .filter((b) => b.textContent?.includes("createToken"));
    expect(tokenBtns.length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(tokenBtns[0]);
    });

    // Fill token name
    const tokenNameInput = screen.getByPlaceholderText("tokenNamePlaceholder");
    fireEvent.change(tokenNameInput, { target: { value: "my-token" } });

    // Select first scope checkbox
    const scopeCheckboxes = screen.getAllByTestId("checkbox");
    expect(scopeCheckboxes.length).toBeGreaterThan(0);
    fireEvent.click(scopeCheckboxes[0]);

    // Set expiry date
    const dateInput = screen.getByDisplayValue("");
    fireEvent.change(dateInput, { target: { value: "2026-12-31" } });

    // Submit token creation
    const createTokenBtn = screen
      .getAllByRole("button")
      .find((b) => b.textContent === "create" && !b.hasAttribute("disabled"));
    expect(createTokenBtn).toBeDefined();
    await act(async () => {
      fireEvent.click(createTokenBtn!);
    });

    // Token plaintext should now be visible
    await waitFor(() => {
      expect(
        screen.getByDisplayValue("sa_plaintext_token_value")
      ).toBeInTheDocument();
    });

    // Click OK to close the dialog
    const okBtn = screen.getByRole("button", { name: "OK" });
    await act(async () => {
      fireEvent.click(okBtn);
    });

    // Token should no longer be visible
    expect(
      screen.queryByDisplayValue("sa_plaintext_token_value")
    ).not.toBeInTheDocument();
  });

  it("deletes SA — click delete, confirm in AlertDialog, verifies DELETE call", async () => {
    setupFetchAccounts();

    await act(async () => {
      render(<ServiceAccountCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("deploy-bot")).toBeInTheDocument();
    });

    // AlertDialogAction buttons trigger delete
    const alertActions = screen.getAllByTestId("alert-action");
    expect(alertActions.length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(alertActions[0]);
    });

    await waitFor(() => {
      const deleteCalls = mockFetch.mock.calls.filter(
        (c: unknown[]) =>
          (c[1] as Record<string, unknown>)?.method === "DELETE"
      );
      expect(deleteCalls.length).toBe(1);
    });
  });
});
