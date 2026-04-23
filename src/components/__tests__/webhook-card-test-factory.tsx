// Shared test factory for webhook card variants (TenantWebhookCard, TeamWebhookCard).
// Each test file imports this module and calls the exported helpers at the top level
// so that vi.mock() hoisting works correctly.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { ReactNode } from "react";
import React from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebhookItem {
  id: string;
  url: string;
  events: string[];
  isActive: boolean;
  failCount: number;
  lastDeliveredAt: string | null;
  lastFailedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface WebhookTestOpts {
  variantName: string;
  renderComponent: () => React.ReactElement;
  sampleWebhooks: WebhookItem[];
  activeUrl: string;
  inactiveUrl: string;
}

// ---------------------------------------------------------------------------
// Sample data factory
// ---------------------------------------------------------------------------

export function createSampleWebhooks(
  activeUrl: string,
  inactiveUrl: string,
): WebhookItem[] {
  return [
    {
      id: "wh-sample-1",
      url: activeUrl,
      events: ["ENTRY_CREATE", "ENTRY_UPDATE"],
      isActive: true,
      failCount: 0,
      lastDeliveredAt: "2025-01-01T00:00:00Z",
      lastFailedAt: null,
      lastError: null,
      createdAt: "2025-01-01T00:00:00Z",
    },
    {
      id: "wh-sample-2",
      url: inactiveUrl,
      events: ["ENTRY_DELETE"],
      isActive: false,
      failCount: 3,
      lastDeliveredAt: null,
      lastFailedAt: "2025-01-02T00:00:00Z",
      lastError: "Connection refused",
      createdAt: "2025-01-02T00:00:00Z",
    },
  ];
}

// ---------------------------------------------------------------------------
// Shared fetch mock helper
// ---------------------------------------------------------------------------

export function setupFetchWebhooks(
  mockFetch: ReturnType<typeof vi.fn>,
  webhooks: WebhookItem[] = [],
) {
  mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
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
            webhook: { id: "wh-new", url: "https://new.example.com/hook" },
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

// ---------------------------------------------------------------------------
// Shared vi.mock() registrations
// NOTE: next-intl is intentionally excluded — each test file mocks it
//       differently (tenant needs useLocale, team does not).
// NOTE: @/components/settings/section-card-header is intentionally excluded —
//       the base component does not use it.
// ---------------------------------------------------------------------------

export function setupWebhookCardMocks() {
  // NOTE: sonner and @/lib/url-helpers are intentionally NOT mocked here.
  // Each test file mocks them with vi.hoisted() values so assertions on
  // mockFetch / mockToast work correctly. Registering them here would
  // replace the hoisted fn references and break those assertions.

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

  vi.mock("@/components/ui/card", () => ({
    Card: ({
      children,
      className,
    }: {
      children: ReactNode;
      className?: string;
    }) => (
      <div data-testid="card" className={className}>
        {children}
      </div>
    ),
    CardContent: ({
      children,
      className,
    }: {
      children: ReactNode;
      className?: string;
    }) => (
      <div data-testid="card-content" className={className}>
        {children}
      </div>
    ),
  }));

  vi.mock("@/components/settings/account/section-card-header", () => ({
    SectionCardHeader: ({ title, description, action }: { title: string; description: string; action?: ReactNode }) => (
      <div data-testid="section-card-header"><span>{title}</span><span>{description}</span>{action}</div>
    ),
  }));

  vi.mock("@/components/ui/separator", () => ({
    Separator: () => <hr />,
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
    Collapsible: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
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
    AlertDialog: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
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
}

// ---------------------------------------------------------------------------
// Shared test suite factory
// ---------------------------------------------------------------------------

export function createWebhookCardTests(
  mockFetch: ReturnType<typeof vi.fn>,
  mockToast: { error: ReturnType<typeof vi.fn>; success: ReturnType<typeof vi.fn> },
  opts: WebhookTestOpts,
) {
  const { variantName, renderComponent, sampleWebhooks, activeUrl, inactiveUrl } = opts;

  describe(variantName, () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    // ------------------------------------------------------------------
    // Helper: set up fetch to return the given webhook list
    // ------------------------------------------------------------------
    function setup(webhooks: WebhookItem[] = sampleWebhooks) {
      setupFetchWebhooks(mockFetch, webhooks);
    }

    // 1. renders webhooks with URL and badge
    it("renders webhooks with URL and badge", async () => {
      setup();

      await act(async () => {
        render(renderComponent());
      });

      await waitFor(() => {
        expect(
          screen.getAllByText(activeUrl).length,
        ).toBeGreaterThanOrEqual(1);
      });

      // Inactive webhook is hidden by default behind the toggle
      expect(screen.queryByText(inactiveUrl)).not.toBeInTheDocument();

      const badges = screen.getAllByTestId("badge");
      expect(badges.some((b) => b.textContent === "active")).toBe(true);
    });

    // 2. shows failCount for webhooks with failures after expanding inactive
    it("shows failCount for webhooks with failures after expanding inactive", async () => {
      setup();

      await act(async () => {
        render(renderComponent());
      });

      await waitFor(() => {
        expect(
          screen.getAllByText(activeUrl).length,
        ).toBeGreaterThanOrEqual(1);
      });

      // Expand inactive section
      const toggleButton = screen.getByText(/inactiveWebhooks/);
      await act(async () => {
        fireEvent.click(toggleButton);
      });

      await waitFor(() => {
        expect(
          screen.getAllByText(inactiveUrl).length,
        ).toBeGreaterThanOrEqual(1);
      });

      const failElements = screen.getAllByText(/failCount/);
      expect(failElements.length).toBeGreaterThan(0);
    });

    // 3. shows empty state when no webhooks
    it("shows empty state when no webhooks", async () => {
      setup([]);

      await act(async () => {
        render(renderComponent());
      });

      await waitFor(() => {
        expect(screen.getByText("noWebhooks")).toBeInTheDocument();
      });
    });

    // 4. disables create button when limit is reached
    it("disables create button when limit is reached", async () => {
      const fiveWebhooks = Array.from({ length: 5 }, (_, i) => ({
        id: `wh-limit-${i}`,
        url: `https://example.com/limit-hook${i}`,
        events: ["ENTRY_CREATE"],
        isActive: true,
        failCount: 0,
        lastDeliveredAt: null,
        lastFailedAt: null,
        lastError: null,
        createdAt: "2025-01-01T00:00:00Z",
      }));
      setup(fiveWebhooks);

      await act(async () => {
        render(renderComponent());
      });

      await waitFor(() => {
        expect(screen.getByText("limitReached")).toBeInTheDocument();
      });
    });

    // 5. shows secret after successful creation, hides on OK click
    it("shows secret after successful creation, hides on OK click", async () => {
      setup([]);

      await act(async () => {
        render(renderComponent());
      });

      await waitFor(() => {
        expect(screen.getByText("noWebhooks")).toBeInTheDocument();
      });

      const urlInput = screen.getByPlaceholderText("urlPlaceholder");
      fireEvent.change(urlInput, {
        target: { value: "https://new.example.com/hook" },
      });

      const checkboxes = screen.getAllByTestId("checkbox");
      expect(checkboxes.length).toBeGreaterThan(0);
      fireEvent.click(checkboxes[0]);

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

      const okButton = screen.getByRole("button", { name: "OK" });
      await act(async () => {
        fireEvent.click(okButton);
      });

      expect(screen.queryByDisplayValue("abc123secret")).not.toBeInTheDocument();
    });

    // 6. calls delete handler via confirmation dialog
    it("calls delete handler via confirmation dialog", async () => {
      setup();

      await act(async () => {
        render(renderComponent());
      });

      await waitFor(() => {
        expect(
          screen.getAllByText(activeUrl).length,
        ).toBeGreaterThanOrEqual(1);
      });

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

    // 7. shows toast error on create failure
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
        render(renderComponent());
      });

      await waitFor(() => {
        expect(screen.getByText("noWebhooks")).toBeInTheDocument();
      });

      const urlInput = screen.getByPlaceholderText("urlPlaceholder");
      fireEvent.change(urlInput, {
        target: { value: "https://fail.example.com/hook" },
      });

      const checkboxes = screen.getAllByTestId("checkbox");
      expect(checkboxes.length).toBeGreaterThan(0);
      fireEvent.click(checkboxes[0]);

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

    // 8. shows inline error for http:// URL
    it("shows inline error for http:// URL", async () => {
      setup([]);

      await act(async () => {
        render(renderComponent());
      });

      await waitFor(() => {
        expect(screen.getByText("noWebhooks")).toBeInTheDocument();
      });

      const urlInput = screen.getByPlaceholderText("urlPlaceholder");
      fireEvent.change(urlInput, {
        target: { value: "http://example.com/hook" },
      });

      const checkboxes = screen.getAllByTestId("checkbox");
      fireEvent.click(checkboxes[0]);

      const createButtons = screen
        .getAllByRole("button")
        .filter((b) => b.textContent?.includes("addWebhook"));
      await act(async () => {
        fireEvent.click(createButtons[0]);
      });

      expect(screen.getByText("urlHttpsRequired")).toBeInTheDocument();
      const postCalls = mockFetch.mock.calls.filter(
        (c: unknown[]) =>
          (c[1] as Record<string, unknown>)?.method === "POST",
      );
      expect(postCalls).toHaveLength(0);
    });

    // 9. shows inline error for malformed URL
    it("shows inline error for malformed URL", async () => {
      setup([]);

      await act(async () => {
        render(renderComponent());
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

    // 10. shows validation error toast on 400 response
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
            json: () =>
              Promise.resolve({
                details: { properties: { url: { errors: ["invalid"] } } },
              }),
          });
        }
        return Promise.resolve({ ok: false, status: 500 });
      });

      await act(async () => {
        render(renderComponent());
      });

      await waitFor(() => {
        expect(screen.getByText("noWebhooks")).toBeInTheDocument();
      });

      const urlInput = screen.getByPlaceholderText("urlPlaceholder");
      fireEvent.change(urlInput, {
        target: { value: "https://valid.example.com/hook" },
      });

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

    // 11. clears URL error when user types
    it("clears URL error when user types", async () => {
      setup([]);

      await act(async () => {
        render(renderComponent());
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

    // 12. disables create button when no events selected
    it("disables create button when no events selected", async () => {
      setup([]);

      await act(async () => {
        render(renderComponent());
      });

      await waitFor(() => {
        expect(screen.getByText("noWebhooks")).toBeInTheDocument();
      });

      const urlInput = screen.getByPlaceholderText("urlPlaceholder");
      fireEvent.change(urlInput, {
        target: { value: "https://example.com/hook" },
      });

      const createButtons = screen
        .getAllByRole("button")
        .filter((b) => b.textContent?.includes("addWebhook"));
      expect(createButtons[0]).toBeDisabled();
    });

    // 13. shows toast error on delete failure
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
        render(renderComponent());
      });

      await waitFor(() => {
        expect(
          screen.getAllByText(activeUrl).length,
        ).toBeGreaterThanOrEqual(1);
      });

      const alertActions = screen.getAllByTestId("alert-action");
      await act(async () => {
        fireEvent.click(alertActions[0]);
      });

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith("deleteFailed");
      });
    });

    // 14. handles fetch exception on initial load gracefully
    it("handles fetch exception on initial load gracefully", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      await act(async () => {
        render(renderComponent());
      });

      await waitFor(() => {
        expect(screen.getByText("noWebhooks")).toBeInTheDocument();
      });
    });

    // 15. shows active webhooks and hides inactive by default
    it("shows active webhooks and hides inactive by default", async () => {
      setup(sampleWebhooks);

      await act(async () => {
        render(renderComponent());
      });

      await waitFor(() => {
        expect(
          screen.getAllByText(activeUrl).length,
        ).toBeGreaterThanOrEqual(1);
      });

      expect(screen.queryByText(inactiveUrl)).not.toBeInTheDocument();
    });

    // 16. shows inactive webhooks after clicking toggle
    it("shows inactive webhooks after clicking toggle", async () => {
      setup(sampleWebhooks);

      await act(async () => {
        render(renderComponent());
      });

      await waitFor(() => {
        expect(
          screen.getAllByText(activeUrl).length,
        ).toBeGreaterThanOrEqual(1);
      });

      const toggleButton = screen.getByText(/inactiveWebhooks/);
      await act(async () => {
        fireEvent.click(toggleButton);
      });

      await waitFor(() => {
        expect(
          screen.getAllByText(inactiveUrl).length,
        ).toBeGreaterThanOrEqual(1);
      });
    });

    // 17. auto-expands inactive section when webhook limit is reached
    it("auto-expands inactive section when webhook limit is reached", async () => {
      // 5 webhooks total (MAX_WEBHOOKS=5): 4 active + 1 inactive
      const limitWebhooks = [
        ...Array.from({ length: 4 }, (_, i) => ({
          id: `wh-a${i}`,
          url: `https://example.com/active-${i}`,
          events: ["ENTRY_CREATE"],
          isActive: true,
          failCount: 0,
          lastDeliveredAt: null,
          lastFailedAt: null,
          lastError: null,
          createdAt: "2025-01-01T00:00:00Z",
        })),
        {
          id: "wh-inactive",
          url: "https://example.com/inactive",
          events: ["ENTRY_CREATE"],
          isActive: false,
          failCount: 0,
          lastDeliveredAt: null,
          lastFailedAt: null,
          lastError: null,
          createdAt: "2025-01-01T00:00:00Z",
        },
      ];
      setup(limitWebhooks);

      await act(async () => {
        render(renderComponent());
      });

      await waitFor(() => {
        expect(
          screen.getAllByText("https://example.com/active-0").length,
        ).toBeGreaterThanOrEqual(1);
      });

      // Inactive webhook should be auto-expanded because limit is reached
      expect(
        screen.getAllByText("https://example.com/inactive").length,
      ).toBeGreaterThanOrEqual(1);
    });

    // 18. does not show inactive toggle when all webhooks are active
    it("does not show inactive toggle when all webhooks are active", async () => {
      const allActiveWebhooks = sampleWebhooks.map((w) => ({
        ...w,
        isActive: true,
      }));
      setup(allActiveWebhooks);

      await act(async () => {
        render(renderComponent());
      });

      await waitFor(() => {
        expect(
          screen.getAllByText(activeUrl).length,
        ).toBeGreaterThanOrEqual(1);
      });

      expect(screen.queryByText(/inactiveWebhooks/)).not.toBeInTheDocument();
    });

    // 19. shows validationError toast on 400 without field errors
    it("shows validationError toast on 400 without field errors", async () => {
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
            json: () => Promise.resolve({ message: "Bad request" }),
          });
        }
        return Promise.resolve({ ok: false, status: 500 });
      });

      await act(async () => {
        render(renderComponent());
      });

      await waitFor(() => {
        expect(screen.getByText("noWebhooks")).toBeInTheDocument();
      });

      const urlInput = screen.getByPlaceholderText("urlPlaceholder");
      fireEvent.change(urlInput, {
        target: { value: "https://valid.example.com/hook" },
      });

      const checkboxes = screen.getAllByTestId("checkbox");
      fireEvent.click(checkboxes[0]);

      const createButtons = screen
        .getAllByRole("button")
        .filter((b) => b.textContent?.includes("addWebhook"));
      await act(async () => {
        fireEvent.click(createButtons[0]);
      });

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith("validationError");
      });
    });

    // 20. shows toast error on create network exception
    it("shows toast error on create network exception", async () => {
      mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
        if (!init?.method || init.method === "GET") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ webhooks: [] }),
          });
        }
        if (init.method === "POST") {
          return Promise.reject(new Error("Network error"));
        }
        return Promise.resolve({ ok: false, status: 500 });
      });

      await act(async () => {
        render(renderComponent());
      });

      await waitFor(() => {
        expect(screen.getByText("noWebhooks")).toBeInTheDocument();
      });

      const urlInput = screen.getByPlaceholderText("urlPlaceholder");
      fireEvent.change(urlInput, {
        target: { value: "https://valid.example.com/hook" },
      });

      const checkboxes = screen.getAllByTestId("checkbox");
      fireEvent.click(checkboxes[0]);

      const createButtons = screen
        .getAllByRole("button")
        .filter((b) => b.textContent?.includes("addWebhook"));
      await act(async () => {
        fireEvent.click(createButtons[0]);
      });

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith("createFailed");
      });
    });

    // 21. shows toast error on delete network exception
    it("shows toast error on delete network exception", async () => {
      mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
        if (!init?.method || init.method === "GET") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ webhooks: sampleWebhooks }),
          });
        }
        if (init.method === "DELETE") {
          return Promise.reject(new Error("Network error"));
        }
        return Promise.resolve({ ok: false, status: 500 });
      });

      await act(async () => {
        render(renderComponent());
      });

      await waitFor(() => {
        expect(
          screen.getAllByText(activeUrl).length,
        ).toBeGreaterThanOrEqual(1);
      });

      const alertActions = screen.getAllByTestId("alert-action");
      await act(async () => {
        fireEvent.click(alertActions[0]);
      });

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith("deleteFailed");
      });
    });

    // 22. shows noActiveWebhooks when only inactive webhooks exist
    it("shows noActiveWebhooks when only inactive webhooks exist", async () => {
      const allInactiveWebhooks = sampleWebhooks.map((w) => ({
        ...w,
        isActive: false,
      }));
      setup(allInactiveWebhooks);

      await act(async () => {
        render(renderComponent());
      });

      await waitFor(() => {
        expect(screen.getByText("noActiveWebhooks")).toBeInTheDocument();
      });
    });

    // 23. toggles group checkbox to select all events in a group
    it("toggles group checkbox to select all events in a group", async () => {
      setup([]);

      await act(async () => {
        render(renderComponent());
      });

      await waitFor(() => {
        expect(screen.getByText("noWebhooks")).toBeInTheDocument();
      });

      const urlInput = screen.getByPlaceholderText("urlPlaceholder");
      fireEvent.change(urlInput, {
        target: { value: "https://valid.example.com/hook" },
      });

      // Click the first group checkbox (index 0) to select all events in the first group
      const checkboxes = screen.getAllByTestId("checkbox");
      await act(async () => {
        fireEvent.click(checkboxes[0]);
      });

      // Create button should now be enabled (URL + events selected)
      const createButtons = screen
        .getAllByRole("button")
        .filter((b) => b.textContent?.includes("addWebhook"));
      expect(createButtons[0]).not.toBeDisabled();

      await act(async () => {
        fireEvent.click(createButtons[0]);
      });

      await waitFor(() => {
        const postCalls = mockFetch.mock.calls.filter(
          (c: unknown[]) =>
            (c[1] as Record<string, unknown>)?.method === "POST",
        );
        expect(postCalls.length).toBe(1);
        const body = JSON.parse(postCalls[0][1].body as string);
        expect(Array.isArray(body.events)).toBe(true);
        expect(body.events.length).toBeGreaterThan(0);
      });
    });
  });
}
