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

// Tenant requires useLocale in addition to useTranslations
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
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

import { TenantWebhookCard } from "./tenant-webhook-card";

const sampleWebhooks = createSampleWebhooks(
  "https://example.com/tenant-hook1",
  "https://example.com/tenant-hook2",
);

// ---------------------------------------------------------------------------
// Shared tests (18 cases)
// ---------------------------------------------------------------------------

createWebhookCardTests(mockFetch, mockToast, {
  variantName: "TenantWebhookCard",
  renderComponent: () => <TenantWebhookCard />,
  sampleWebhooks,
  activeUrl: "https://example.com/tenant-hook1",
  inactiveUrl: "https://example.com/tenant-hook2",
});

// ---------------------------------------------------------------------------
// Tenant-specific tests
// ---------------------------------------------------------------------------

describe("TenantWebhookCard (tenant-specific)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("excludes group:tenantWebhook actions from event selector", async () => {
    setupFetchWebhooks(mockFetch, []);

    await act(async () => {
      render(<TenantWebhookCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noWebhooks")).toBeInTheDocument();
    });

    // TENANT_WEBHOOK group actions must NOT appear in the event selector
    expect(screen.queryByText("TENANT_WEBHOOK_CREATE")).not.toBeInTheDocument();
    expect(screen.queryByText("TENANT_WEBHOOK_DELETE")).not.toBeInTheDocument();
    expect(
      screen.queryByText("TENANT_WEBHOOK_DELIVERY_FAILED"),
    ).not.toBeInTheDocument();
  });

  it("excludes PERSONAL_LOG_ACCESS_VIEW and PERSONAL_LOG_ACCESS_EXPIRE from event selector", async () => {
    setupFetchWebhooks(mockFetch, []);

    await act(async () => {
      render(<TenantWebhookCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noWebhooks")).toBeInTheDocument();
    });

    // Privacy-sensitive timing actions must NOT be subscribable
    expect(
      screen.queryByText("PERSONAL_LOG_ACCESS_VIEW"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("PERSONAL_LOG_ACCESS_EXPIRE"),
    ).not.toBeInTheDocument();
  });

  it("includes only ADMIN/SCIM/DIRECTORY_SYNC/BREAKGLASS(REQUEST+REVOKE) events", async () => {
    setupFetchWebhooks(mockFetch, []);

    await act(async () => {
      render(<TenantWebhookCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noWebhooks")).toBeInTheDocument();
    });

    // Subscribable breakglass actions must be present
    expect(
      screen.getByText("PERSONAL_LOG_ACCESS_REQUEST"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("PERSONAL_LOG_ACCESS_REVOKE"),
    ).toBeInTheDocument();

    // Admin actions must be present
    expect(screen.getByText("TENANT_ROLE_UPDATE")).toBeInTheDocument();

    // SCIM actions must be present
    expect(screen.getByText("SCIM_TOKEN_CREATE")).toBeInTheDocument();
    expect(screen.getByText("SCIM_USER_CREATE")).toBeInTheDocument();

    // Directory sync actions must be present
    expect(screen.getByText("DIRECTORY_SYNC_RUN")).toBeInTheDocument();
  });
});
