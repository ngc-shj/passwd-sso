// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
  useLocale: () => "en",
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

vi.mock("@/lib/format/format-datetime", () => ({
  formatDate: (d: string) => d,
}));

vi.mock("@/components/passwords/shared/copy-button", () => ({
  CopyButton: ({ getValue }: { getValue: () => string }) => (
    <button type="button" data-testid="copy-button" data-value={getValue()}>
      copy
    </button>
  ),
}));

import { setupPasskeyReauthDialogMocks } from "@/__tests__/helpers/passkey-reauth-mocks";
setupPasskeyReauthDialogMocks();

vi.mock("@/lib/auth/webauthn/can-use-passkey-recovery", () => ({
  canUsePasskeyRecovery: mockCanUsePasskeyRecovery,
}));

vi.mock("@/lib/auth/webauthn/passkey-reauth-client", () => ({
  reauthenticateWithPasskey: mockReauthenticateWithPasskey,
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

import { ApiKeyManager } from "./api-key-manager";

interface ApiKeyEntry {
  id: string;
  prefix: string;
  name: string;
  scopes: string[];
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

function setupKeysList(keys: ApiKeyEntry[]) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (
      String(url).includes("/api/api-keys") &&
      (!init || init.method === undefined || init.method === "GET")
    ) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(keys),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ token: "api-token-xyz" }),
    });
  });
}

describe("ApiKeyManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: user has no passkey, so the recent-session dialog opens (the
    // pre-passkey-rebalance UX). Tests that exercise the inline passkey reauth
    // flow override this.
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
    mockReauthenticateWithPasskey.mockResolvedValue({ ok: true, verifiedAt: "2026-05-10T00:00:00Z" });
  });

  it("renders the empty state when no keys exist", async () => {
    setupKeysList([]);
    render(<ApiKeyManager />);
    await waitFor(() => {
      expect(screen.getByText("noKeys")).toBeInTheDocument();
    });
  });

  it("disables create button when name is empty (R26)", async () => {
    setupKeysList([]);
    render(<ApiKeyManager />);
    await waitFor(() =>
      expect(screen.getByText("noKeys")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /createKey/ }));
    const buttons = screen.getAllByRole("button", { name: /createKey/ });
    const createBtn = buttons[buttons.length - 1];
    expect(createBtn).toBeDisabled();
  });

  it("shows the new token panel after successful create", async () => {
    setupKeysList([]);
    render(<ApiKeyManager />);
    await waitFor(() =>
      expect(screen.getByText("noKeys")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /createKey/ }));

    const nameInput = screen.getByPlaceholderText("namePlaceholder");
    fireEvent.change(nameInput, { target: { value: "my-key" } });

    const buttons = screen.getAllByRole("button", { name: /createKey/ });
    const createBtn = buttons[buttons.length - 1];
    fireEvent.click(createBtn);

    await waitFor(() => {
      expect(screen.getByText("tokenReady")).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue("api-token-xyz")).toBeInTheDocument();
  });

  it("opens RecentSessionRequiredDialog when SESSION_STEP_UP_REQUIRED is returned", async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (
        String(url).includes("/api/api-keys") &&
        (!init || init.method === undefined || init.method === "GET")
      ) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([]),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
      });
    });

    render(<ApiKeyManager />);
    await waitFor(() => {
      expect(screen.getByText("noKeys")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /createKey/ }));

    fireEvent.change(screen.getByPlaceholderText("namePlaceholder"), {
      target: { value: "my-key" },
    });

    const buttons = screen.getAllByRole("button", { name: /createKey/ });
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => {
      expect(screen.getByTestId("recent-session-dialog")).toBeInTheDocument();
    });
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("falls back to local createError for an unrecognized API error code", async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (
        String(url).includes("/api/api-keys") &&
        (!init || init.method === undefined || init.method === "GET")
      ) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([]),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "BOGUS_NOT_IN_ALLOWLIST" }),
      });
    });

    render(<ApiKeyManager />);
    await waitFor(() => {
      expect(screen.getByText("noKeys")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /createKey/ }));
    fireEvent.change(screen.getByPlaceholderText("namePlaceholder"), {
      target: { value: "my-key" },
    });

    const buttons = screen.getAllByRole("button", { name: /createKey/ });
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("createError");
    });
  });

  it("renders the list of active keys when present", async () => {
    setupKeysList([
      {
        id: "k1",
        prefix: "abc1",
        name: "ProdKey",
        scopes: ["passwords:read"],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        createdAt: new Date().toISOString(),
        revokedAt: null,
        lastUsedAt: null,
      },
    ]);
    render(<ApiKeyManager />);
    await waitFor(() => {
      expect(screen.getByText("ProdKey")).toBeInTheDocument();
    });
    expect(screen.getByText(/abc1\.\.\./)).toBeInTheDocument();
  });
});
