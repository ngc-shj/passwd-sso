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
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
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
        screen.getByText("https://example.com/hook"),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("active")).toBeInTheDocument();
  });
});
