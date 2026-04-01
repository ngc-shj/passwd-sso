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

  it("does not include group:webhook actions", async () => {
    setupFetchWebhooks(mockFetch, []);

    await act(async () => {
      render(<TeamWebhookCard teamId="team-1" locale="en" />);
    });

    await waitFor(() => {
      expect(screen.getByText("noWebhooks")).toBeInTheDocument();
    });

    expect(screen.queryByText("WEBHOOK_CREATE")).not.toBeInTheDocument();
    expect(screen.queryByText("WEBHOOK_DELETE")).not.toBeInTheDocument();
    expect(
      screen.queryByText("WEBHOOK_DELIVERY_FAILED"),
    ).not.toBeInTheDocument();
  });

  it("includes team-scoped event groups", async () => {
    setupFetchWebhooks(mockFetch, []);

    await act(async () => {
      render(<TeamWebhookCard teamId="team-1" locale="en" />);
    });

    await waitFor(() => {
      expect(screen.getByText("noWebhooks")).toBeInTheDocument();
    });

    // Entry group
    expect(screen.getByText("ENTRY_CREATE")).toBeInTheDocument();
    expect(screen.getByText("ENTRY_UPDATE")).toBeInTheDocument();
    expect(screen.getByText("ENTRY_TRASH")).toBeInTheDocument();

    // Bulk group
    expect(screen.getByText("ENTRY_BULK_TRASH")).toBeInTheDocument();

    // Folder group
    expect(screen.getByText("FOLDER_CREATE")).toBeInTheDocument();

    // Team group
    expect(screen.getByText("TEAM_MEMBER_ADD")).toBeInTheDocument();

    // Share group
    expect(screen.getByText("SHARE_CREATE")).toBeInTheDocument();

    // Tenant-scoped groups must NOT appear
    expect(screen.queryByText("SCIM_USER_CREATE")).not.toBeInTheDocument();
    expect(screen.queryByText("MASTER_KEY_ROTATION")).not.toBeInTheDocument();
    expect(screen.queryByText("ADMIN_VAULT_RESET_INITIATE")).not.toBeInTheDocument();
  });
});
