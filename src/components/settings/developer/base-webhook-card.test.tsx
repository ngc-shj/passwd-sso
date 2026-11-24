// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const { mockFetch, mockToast, mockCanUsePasskeyRecovery, mockReauthenticateWithPasskey } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
  mockCanUsePasskeyRecovery: vi.fn(),
  mockReauthenticateWithPasskey: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () =>
    (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  // RecentSessionRequiredDialog (step-up reauth flow) calls useLocale.
  useLocale: () => "en",
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

import "@/__tests__/helpers/passkey-reauth-mocks";

vi.mock("@/lib/auth/webauthn/can-use-passkey-recovery", () => ({
  canUsePasskeyRecovery: mockCanUsePasskeyRecovery,
}));

vi.mock("@/lib/auth/webauthn/passkey-reauth-client", () => ({
  reauthenticateWithPasskey: mockReauthenticateWithPasskey,
}));

vi.mock("@/lib/format/format-datetime", () => ({
  formatDateTime: (d: string) => d,
}));

vi.mock("@/components/passwords/shared/copy-button", () => ({
  CopyButton: ({ getValue }: { getValue: () => string }) => (
    <button type="button" data-testid="copy-button" data-value={getValue()}>
      copy
    </button>
  ),
}));

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => (
    <div data-testid="alert-trigger">{children}</div>
  ),
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="alert-content">{children}</div>
  ),
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  AlertDialogAction: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button data-testid="alert-action" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) => (
    open ? <>{children}</> : null
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { BaseWebhookCard } from "./base-webhook-card";

const config = {
  listEndpoint: "/api/test/webhooks",
  createEndpoint: "/api/test/webhooks",
  deleteEndpoint: (id: string) => `/api/test/webhooks/${id}`,
  eventGroups: [{ key: "groupA", actions: ["a.action.1", "a.action.2"] }],
  groupLabelMap: { groupA: "labelA" },
  i18nNamespace: "MyHook",
  locale: "en",
};

function setupList(webhooks: Array<Record<string, unknown>>) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (!init || init.method === undefined || init.method === "GET") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ webhooks }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ secret: "secret-xyz" }),
    });
  });
}

describe("BaseWebhookCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: user has no passkey → the recent-session dialog opens.
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
    mockReauthenticateWithPasskey.mockResolvedValue({ ok: true, verifiedAt: "2026-05-10T00:00:00Z" });
  });

  it("renders the empty state when no webhooks", async () => {
    setupList([]);
    render(<BaseWebhookCard config={config} />);
    await waitFor(() => {
      expect(screen.getByText("noWebhooks")).toBeInTheDocument();
    });
  });

  it("R26: disables create button when URL/events are empty", async () => {
    setupList([]);
    render(<BaseWebhookCard config={config} />);
    await waitFor(() =>
      expect(screen.getByText("noWebhooks")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /addWebhook/ }));
    const buttons = screen.getAllByRole("button", { name: /addWebhook/ });
    const submitBtn = buttons[buttons.length - 1];
    expect(submitBtn).toBeDisabled();
  });

  it("rejects non-https URL with urlHttpsRequired error", async () => {
    setupList([]);
    render(<BaseWebhookCard config={config} />);
    await waitFor(() =>
      expect(screen.getByText("noWebhooks")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /addWebhook/ }));
    const url = screen.getByPlaceholderText("urlPlaceholder");
    fireEvent.change(url, { target: { value: "http://example.com/hook" } });

    // Select an event so the button enables
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);

    const buttons = screen.getAllByRole("button", { name: /addWebhook/ });
    const submitBtn = buttons[buttons.length - 1];
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText("urlHttpsRequired")).toBeInTheDocument();
    });
  });

  it("renders an active webhook row", async () => {
    setupList([
      {
        id: "w1",
        url: "https://example.com/hook",
        events: ["a.action.1"],
        isActive: true,
        failCount: 0,
        lastDeliveredAt: null,
        lastFailedAt: null,
        lastError: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    render(<BaseWebhookCard config={config} />);
    await waitFor(() => {
      expect(
        screen.getAllByText("https://example.com/hook").length,
      ).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  describe("when the created webhook's response body cannot be read", () => {
    function setupUnreadableCreate() {
      mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
        if (!init || init.method === undefined || init.method === "GET") {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ webhooks: [] }) });
        }
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")),
        });
      });
    }

    async function submitCreate() {
      render(<BaseWebhookCard config={config} />);
      await screen.findByText("noWebhooks");
      fireEvent.click(screen.getByRole("button", { name: /addWebhook/ }));
      fireEvent.change(screen.getByPlaceholderText("urlPlaceholder"), {
        target: { value: "https://example.com/hook" },
      });
      fireEvent.click(screen.getAllByRole("checkbox")[0]);
      const buttons = screen.getAllByRole("button", { name: /addWebhook/ });
      await act(async () => {
        fireEvent.click(buttons[buttons.length - 1]);
      });
    }

    const listCalls = () => mockFetch.mock.calls.filter(([, init]) => !init || init.method === undefined);

    it("says the webhook was created but its secret cannot be shown", async () => {
      setupUnreadableCreate();
      await submitCreate();
      expect(await screen.findByText("createdSecretUnavailable")).toBeInTheDocument();
      expect(mockToast.error).not.toHaveBeenCalled();
    });

    it("still completes the creation (success toast and list refresh)", async () => {
      setupUnreadableCreate();
      await submitCreate();
      await screen.findByText("createdSecretUnavailable");
      expect(mockToast.success).toHaveBeenCalledWith("created");
      expect(listCalls()).toHaveLength(2);
    });

    it("shows no secret and offers nothing to copy", async () => {
      setupUnreadableCreate();
      await submitCreate();
      await screen.findByText("createdSecretUnavailable");
      expect(screen.queryByText("secret")).not.toBeInTheDocument();
      expect(screen.queryByTestId("copy-button")).not.toBeInTheDocument();
    });

    it("shows the secret with its copy button when the body is readable", async () => {
      setupList([]);
      await submitCreate();
      expect(await screen.findByDisplayValue("secret-xyz")).toBeInTheDocument();
      expect(screen.getByTestId("copy-button")).toHaveAttribute("data-value", "secret-xyz");
      expect(screen.queryByText("createdSecretUnavailable")).not.toBeInTheDocument();
    });
  });

  it("create — opens RecentSessionRequiredDialog when SESSION_STEP_UP_REQUIRED is returned", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined || init.method === "GET") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ webhooks: [] }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
      });
    });

    render(<BaseWebhookCard config={config} />);
    await waitFor(() =>
      expect(screen.getByText("noWebhooks")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /addWebhook/ }));
    fireEvent.change(screen.getByPlaceholderText("urlPlaceholder"), {
      target: { value: "https://example.com/hook" },
    });
    fireEvent.click(screen.getAllByRole("checkbox")[0]);

    const buttons = screen.getAllByRole("button", { name: /addWebhook/ });
    const submitBtn = buttons[buttons.length - 1];
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => {
      expect(screen.getByTestId("recent-session-dialog")).toBeInTheDocument();
    });
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("delete — opens RecentSessionRequiredDialog when SESSION_STEP_UP_REQUIRED is returned", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined || init.method === "GET") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            webhooks: [
              {
                id: "w1",
                url: "https://example.com/hook",
                events: ["a.action.1"],
                isActive: true,
                failCount: 0,
                lastDeliveredAt: null,
                lastFailedAt: null,
                lastError: null,
                createdAt: new Date().toISOString(),
              },
            ],
          }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
      });
    });

    render(<BaseWebhookCard config={config} />);
    await waitFor(() => {
      expect(
        screen.getAllByText("https://example.com/hook").length,
      ).toBeGreaterThanOrEqual(1);
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
});
