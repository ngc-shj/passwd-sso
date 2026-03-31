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

import { render, screen, act, waitFor } from "@testing-library/react";

const { mockFetch, mockToast } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockToast: { error: vi.fn(), success: vi.fn() },
}));

// Team only needs useTranslations (no useLocale)
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

// Override the generic mocks registered by setupWebhookCardMocks with the
// hoisted mockFetch / mockToast so all test assertions reference the same fn.
vi.mock("sonner", () => ({
  toast: mockToast,
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

import {
  setupWebhookCardMocks,
  createWebhookCardTests,
  setupFetchWebhooks,
  createSampleWebhooks,
} from "../__tests__/webhook-card-test-factory";

// Register shared UI component mocks
setupWebhookCardMocks();

import { TeamWebhookCard } from "./team-webhook-card";

const sampleWebhooks = createSampleWebhooks(
  "https://example.com/hook1",
  "https://example.com/hook2",
);

// ---------------------------------------------------------------------------
// Shared tests (18 cases)
// ---------------------------------------------------------------------------

createWebhookCardTests(mockFetch, mockToast, {
  variantName: "TeamWebhookCard",
  renderComponent: () => <TeamWebhookCard teamId="team-1" locale="en" />,
  sampleWebhooks,
  activeUrl: "https://example.com/hook1",
  inactiveUrl: "https://example.com/hook2",
});

// ---------------------------------------------------------------------------
// Team-specific tests
// ---------------------------------------------------------------------------

describe("TeamWebhookCard (team-specific)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("excludes group:webhook from event groups", async () => {
    setupFetchWebhooks(mockFetch, []);

    await act(async () => {
      render(<TeamWebhookCard teamId="team-1" locale="en" />);
    });

    await waitFor(() => {
      expect(screen.getByText("noWebhooks")).toBeInTheDocument();
    });

    // The group:webhook label and its actions must NOT appear
    expect(screen.queryByText("WEBHOOK_CREATE")).not.toBeInTheDocument();
    expect(screen.queryByText("WEBHOOK_DELETE")).not.toBeInTheDocument();
    expect(
      screen.queryByText("WEBHOOK_DELIVERY_FAILED"),
    ).not.toBeInTheDocument();
  });

  it("includes expected team entry events in event selector", async () => {
    setupFetchWebhooks(mockFetch, []);

    await act(async () => {
      render(<TeamWebhookCard teamId="team-1" locale="en" />);
    });

    await waitFor(() => {
      expect(screen.getByText("noWebhooks")).toBeInTheDocument();
    });

    // Core entry lifecycle events must be subscribable
    // Note: team webhook uses ENTRY_TRASH + ENTRY_PERMANENT_DELETE instead of ENTRY_DELETE
    expect(screen.getByText("ENTRY_CREATE")).toBeInTheDocument();
    expect(screen.getByText("ENTRY_UPDATE")).toBeInTheDocument();
    expect(screen.getByText("ENTRY_TRASH")).toBeInTheDocument();
    expect(screen.getByText("ENTRY_PERMANENT_DELETE")).toBeInTheDocument();
    expect(screen.getByText("ENTRY_RESTORE")).toBeInTheDocument();
  });
});
