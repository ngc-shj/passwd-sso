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
  Label: ({ children }: { children: ReactNode }) => <label>{children}</label>,
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

vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CollapsibleContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  CollapsibleTrigger: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => <button className={className}>{children}</button>,
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

import { TenantWebhookCard } from "./tenant-webhook-card";

const sampleWebhooks = [
  {
    id: "twh-1",
    url: "https://example.com/tenant-hook1",
    events: ["SCIM_TOKEN_CREATE", "SCIM_USER_CREATE"],
    isActive: true,
    failCount: 0,
    lastDeliveredAt: "2025-01-01T00:00:00Z",
    lastFailedAt: null,
    lastError: null,
    createdAt: "2025-01-01T00:00:00Z",
  },
  {
    id: "twh-2",
    url: "https://example.com/tenant-hook2",
    events: ["TENANT_ROLE_UPDATE"],
    isActive: false,
    failCount: 3,
    lastDeliveredAt: null,
    lastFailedAt: "2025-01-02T00:00:00Z",
    lastError: "Connection refused",
    createdAt: "2025-01-02T00:00:00Z",
  },
];

function setupFetchWebhooks(webhooks = sampleWebhooks) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (!init?.method || init.method === "GET") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ webhooks }),
      });
    }
    if (init.method === "POST") {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            webhook: { id: "twh-new", url: "https://new.example.com/hook" },
            secret: "abc123secret",
          }),
      });
    }
    if (init.method === "DELETE") {
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({ ok: false });
  });
}

describe("TenantWebhookCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders webhooks with URL and badge", async () => {
    setupFetchWebhooks();

    await act(async () => {
      render(<TenantWebhookCard />);
    });

    await waitFor(() => {
      expect(screen.getAllByText("https://example.com/tenant-hook1").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("https://example.com/tenant-hook2").length).toBeGreaterThanOrEqual(1);
    });

    const badges = screen.getAllByTestId("badge");
    expect(badges.some((b) => b.textContent === "active")).toBe(true);
    expect(badges.some((b) => b.textContent === "inactive")).toBe(true);
  });

  it("shows failCount for webhooks with failures", async () => {
    setupFetchWebhooks();

    await act(async () => {
      render(<TenantWebhookCard />);
    });

    await waitFor(() => {
      expect(screen.getAllByText("https://example.com/tenant-hook2").length).toBeGreaterThanOrEqual(1);
    });

    const failElements = screen.getAllByText(/failCount/);
    expect(failElements.length).toBeGreaterThan(0);
  });

  it("shows empty state when no webhooks", async () => {
    setupFetchWebhooks([]);

    await act(async () => {
      render(<TenantWebhookCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noWebhooks")).toBeInTheDocument();
    });
  });

  it("disables create button when limit is reached", async () => {
    const fiveWebhooks = Array.from({ length: 5 }, (_, i) => ({
      id: `twh-${i}`,
      url: `https://example.com/tenant-hook${i}`,
      events: ["SCIM_TOKEN_CREATE"],
      isActive: true,
      failCount: 0,
      lastDeliveredAt: null,
      lastFailedAt: null,
      lastError: null,
      createdAt: "2025-01-01T00:00:00Z",
    }));
    setupFetchWebhooks(fiveWebhooks);

    await act(async () => {
      render(<TenantWebhookCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("limitReached")).toBeInTheDocument();
    });
  });

  it("shows secret after successful creation, hides on OK click", async () => {
    setupFetchWebhooks([]);

    await act(async () => {
      render(<TenantWebhookCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noWebhooks")).toBeInTheDocument();
    });

    // Fill URL
    const urlInput = screen.getByPlaceholderText("urlPlaceholder");
    fireEvent.change(urlInput, {
      target: { value: "https://new.example.com/hook" },
    });

    // Select an event (click first checkbox in event selector)
    const checkboxes = screen.getAllByTestId("checkbox");
    expect(checkboxes.length).toBeGreaterThan(0);
    fireEvent.click(checkboxes[0]);

    // Click create button
    const createButtons = screen
      .getAllByRole("button")
      .filter((b) => b.textContent?.includes("addWebhook"));
    expect(createButtons.length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(createButtons[0]);
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue("abc123secret")).toBeInTheDocument();
    });

    // Click OK to dismiss secret
    const okButton = screen.getByRole("button", { name: "OK" });
    await act(async () => {
      fireEvent.click(okButton);
    });

    expect(screen.queryByDisplayValue("abc123secret")).not.toBeInTheDocument();
  });

  it("calls delete handler via confirmation dialog", async () => {
    setupFetchWebhooks();

    await act(async () => {
      render(<TenantWebhookCard />);
    });

    await waitFor(() => {
      expect(screen.getAllByText("https://example.com/tenant-hook1").length).toBeGreaterThanOrEqual(1);
    });

    // Click the alert action button (delete confirm)
    const alertActions = screen.getAllByTestId("alert-action");
    await act(async () => {
      fireEvent.click(alertActions[0]);
    });

    await waitFor(() => {
      const deleteCalls = mockFetch.mock.calls.filter(
        (c: unknown[]) =>
          (c[1] as Record<string, unknown>)?.method === "DELETE",
      );
      expect(deleteCalls.length).toBe(1);
    });
  });

  it("shows toast error on create failure", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ webhooks: [] }),
        });
      }
      if (init.method === "POST") {
        return Promise.resolve({ ok: false, status: 500 });
      }
      return Promise.resolve({ ok: false, status: 500 });
    });

    await act(async () => {
      render(<TenantWebhookCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noWebhooks")).toBeInTheDocument();
    });

    // Fill URL
    const urlInput = screen.getByPlaceholderText("urlPlaceholder");
    fireEvent.change(urlInput, {
      target: { value: "https://fail.example.com/hook" },
    });

    // Select an event
    const checkboxes = screen.getAllByTestId("checkbox");
    expect(checkboxes.length).toBeGreaterThan(0);
    fireEvent.click(checkboxes[0]);

    // Click create
    const createButtons = screen
      .getAllByRole("button")
      .filter((b) => b.textContent?.includes("addWebhook"));
    expect(createButtons.length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(createButtons[0]);
    });

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("createFailed");
    });
  });

  it("shows inline error for http:// URL", async () => {
    setupFetchWebhooks([]);

    await act(async () => {
      render(<TenantWebhookCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noWebhooks")).toBeInTheDocument();
    });

    const urlInput = screen.getByPlaceholderText("urlPlaceholder");
    fireEvent.change(urlInput, { target: { value: "http://example.com/hook" } });

    const checkboxes = screen.getAllByTestId("checkbox");
    fireEvent.click(checkboxes[0]);

    const createButtons = screen
      .getAllByRole("button")
      .filter((b) => b.textContent?.includes("addWebhook"));
    await act(async () => {
      fireEvent.click(createButtons[0]);
    });

    expect(screen.getByText("urlHttpsRequired")).toBeInTheDocument();
    // Should NOT call the API
    const postCalls = mockFetch.mock.calls.filter(
      (c: unknown[]) => (c[1] as Record<string, unknown>)?.method === "POST",
    );
    expect(postCalls).toHaveLength(0);
  });

  it("shows inline error for malformed URL", async () => {
    setupFetchWebhooks([]);

    await act(async () => {
      render(<TenantWebhookCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noWebhooks")).toBeInTheDocument();
    });

    const urlInput = screen.getByPlaceholderText("urlPlaceholder");
    fireEvent.change(urlInput, { target: { value: "not-a-url" } });

    const checkboxes = screen.getAllByTestId("checkbox");
    fireEvent.click(checkboxes[0]);

    const createButtons = screen
      .getAllByRole("button")
      .filter((b) => b.textContent?.includes("addWebhook"));
    await act(async () => {
      fireEvent.click(createButtons[0]);
    });

    expect(screen.getByText("urlInvalid")).toBeInTheDocument();
  });

  it("shows validation error toast on 400 response", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ webhooks: [] }),
        });
      }
      if (init.method === "POST") {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({ details: { fieldErrors: { url: ["invalid"] } } }),
        });
      }
      return Promise.resolve({ ok: false, status: 500 });
    });

    await act(async () => {
      render(<TenantWebhookCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noWebhooks")).toBeInTheDocument();
    });

    const urlInput = screen.getByPlaceholderText("urlPlaceholder");
    fireEvent.change(urlInput, { target: { value: "https://valid.example.com/hook" } });

    const checkboxes = screen.getAllByTestId("checkbox");
    fireEvent.click(checkboxes[0]);

    const createButtons = screen
      .getAllByRole("button")
      .filter((b) => b.textContent?.includes("addWebhook"));
    await act(async () => {
      fireEvent.click(createButtons[0]);
    });

    await waitFor(() => {
      expect(screen.getByText("urlInvalid")).toBeInTheDocument();
    });
  });

  it("clears URL error when user types", async () => {
    setupFetchWebhooks([]);

    await act(async () => {
      render(<TenantWebhookCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noWebhooks")).toBeInTheDocument();
    });

    const urlInput = screen.getByPlaceholderText("urlPlaceholder");
    fireEvent.change(urlInput, { target: { value: "not-a-url" } });

    const checkboxes = screen.getAllByTestId("checkbox");
    fireEvent.click(checkboxes[0]);

    const createButtons = screen
      .getAllByRole("button")
      .filter((b) => b.textContent?.includes("addWebhook"));
    await act(async () => {
      fireEvent.click(createButtons[0]);
    });

    expect(screen.getByText("urlInvalid")).toBeInTheDocument();

    // Now type a new value — error should clear
    fireEvent.change(urlInput, { target: { value: "https://example.com" } });
    expect(screen.queryByText("urlInvalid")).not.toBeInTheDocument();
  });

  it("excludes group:tenantWebhook actions from event selector", async () => {
    setupFetchWebhooks([]);

    await act(async () => {
      render(<TenantWebhookCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noWebhooks")).toBeInTheDocument();
    });

    // TENANT_WEBHOOK group actions must NOT appear in the event selector.
    // The translation mock returns the key directly.
    expect(screen.queryByText("TENANT_WEBHOOK_CREATE")).not.toBeInTheDocument();
    expect(screen.queryByText("TENANT_WEBHOOK_DELETE")).not.toBeInTheDocument();
    expect(screen.queryByText("TENANT_WEBHOOK_DELIVERY_FAILED")).not.toBeInTheDocument();
  });

  it("excludes PERSONAL_LOG_ACCESS_VIEW and PERSONAL_LOG_ACCESS_EXPIRE from event selector", async () => {
    setupFetchWebhooks([]);

    await act(async () => {
      render(<TenantWebhookCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noWebhooks")).toBeInTheDocument();
    });

    // Privacy-sensitive timing actions must NOT be subscribable.
    expect(screen.queryByText("PERSONAL_LOG_ACCESS_VIEW")).not.toBeInTheDocument();
    expect(screen.queryByText("PERSONAL_LOG_ACCESS_EXPIRE")).not.toBeInTheDocument();
  });

  it("includes only ADMIN/SCIM/DIRECTORY_SYNC/BREAKGLASS(REQUEST+REVOKE) events", async () => {
    setupFetchWebhooks([]);

    await act(async () => {
      render(<TenantWebhookCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noWebhooks")).toBeInTheDocument();
    });

    // Subscribable breakglass actions must be present
    expect(screen.getByText("PERSONAL_LOG_ACCESS_REQUEST")).toBeInTheDocument();
    expect(screen.getByText("PERSONAL_LOG_ACCESS_REVOKE")).toBeInTheDocument();

    // Admin actions must be present
    expect(screen.getByText("TENANT_ROLE_UPDATE")).toBeInTheDocument();

    // SCIM actions must be present
    expect(screen.getByText("SCIM_TOKEN_CREATE")).toBeInTheDocument();
    expect(screen.getByText("SCIM_USER_CREATE")).toBeInTheDocument();

    // Directory sync actions must be present
    expect(screen.getByText("DIRECTORY_SYNC_RUN")).toBeInTheDocument();
  });

  it("disables create button when no events selected", async () => {
    setupFetchWebhooks([]);

    await act(async () => {
      render(<TenantWebhookCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noWebhooks")).toBeInTheDocument();
    });

    // Fill URL but don't select events
    const urlInput = screen.getByPlaceholderText("urlPlaceholder");
    fireEvent.change(urlInput, {
      target: { value: "https://example.com/hook" },
    });

    // The create button should be disabled (no events selected)
    const createButtons = screen
      .getAllByRole("button")
      .filter((b) => b.textContent?.includes("addWebhook"));
    expect(createButtons[0]).toBeDisabled();
  });

  it("shows toast error on delete failure", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ webhooks: sampleWebhooks }),
        });
      }
      if (init.method === "DELETE") {
        return Promise.resolve({ ok: false });
      }
      return Promise.resolve({ ok: false });
    });

    await act(async () => {
      render(<TenantWebhookCard />);
    });

    await waitFor(() => {
      expect(screen.getAllByText("https://example.com/tenant-hook1").length).toBeGreaterThanOrEqual(1);
    });

    const alertActions = screen.getAllByTestId("alert-action");
    await act(async () => {
      fireEvent.click(alertActions[0]);
    });

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("deleteFailed");
    });
  });

  it("handles fetch exception on initial load gracefully", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    await act(async () => {
      render(<TenantWebhookCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noWebhooks")).toBeInTheDocument();
    });
  });
});
