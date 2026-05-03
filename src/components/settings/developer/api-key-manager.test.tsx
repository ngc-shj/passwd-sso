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

const { mockFetch, mockToast } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
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
