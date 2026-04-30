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
} from "../../__tests__/webhook-card-test-factory";

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

    // TENANT_WEBHOOK group actions must NOT appear
    expect(screen.queryByText("TENANT_WEBHOOK_CREATE")).not.toBeInTheDocument();
    expect(screen.queryByText("TENANT_WEBHOOK_DELETE")).not.toBeInTheDocument();
    expect(
      screen.queryByText("TENANT_WEBHOOK_DELIVERY_FAILED"),
    ).not.toBeInTheDocument();

    // MCP_CLIENT and DELEGATION groups MUST appear (now dispatched via logAudit)
    expect(screen.getByText("MCP_CLIENT_CREATE")).toBeInTheDocument();
    expect(screen.getByText("DELEGATION_CREATE")).toBeInTheDocument();
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

  it("includes all tenant webhook event groups", async () => {
    setupFetchWebhooks(mockFetch, []);

    await act(async () => {
      render(<TenantWebhookCard />);
    });

    await waitFor(() => {
      expect(screen.getByText("noWebhooks")).toBeInTheDocument();
    });

    // Breakglass actions (REQUEST + REVOKE only)
    expect(
      screen.getByText("PERSONAL_LOG_ACCESS_REQUEST"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("PERSONAL_LOG_ACCESS_REVOKE"),
    ).toBeInTheDocument();

    // Admin actions
    expect(screen.getByText("ADMIN_VAULT_RESET_INITIATE")).toBeInTheDocument();
    expect(screen.getByText("ADMIN_VAULT_RESET_APPROVE")).toBeInTheDocument();
    expect(screen.getByText("ADMIN_VAULT_RESET_EXECUTE")).toBeInTheDocument();
    expect(screen.getByText("ADMIN_VAULT_RESET_REVOKE")).toBeInTheDocument();
    expect(screen.getByText("TENANT_ROLE_UPDATE")).toBeInTheDocument();

    // SCIM actions
    expect(screen.getByText("SCIM_TOKEN_CREATE")).toBeInTheDocument();
    expect(screen.getByText("SCIM_USER_CREATE")).toBeInTheDocument();

    // Directory sync actions
    expect(screen.getByText("DIRECTORY_SYNC_RUN")).toBeInTheDocument();

    // Service Account actions (newly subscribable — all 8)
    expect(screen.getByText("SERVICE_ACCOUNT_CREATE")).toBeInTheDocument();
    expect(screen.getByText("SERVICE_ACCOUNT_UPDATE")).toBeInTheDocument();
    expect(screen.getByText("SERVICE_ACCOUNT_DELETE")).toBeInTheDocument();
    expect(
      screen.getByText("SERVICE_ACCOUNT_TOKEN_CREATE"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("SERVICE_ACCOUNT_TOKEN_REVOKE"),
    ).toBeInTheDocument();
    expect(screen.getByText("ACCESS_REQUEST_CREATE")).toBeInTheDocument();
    expect(screen.getByText("ACCESS_REQUEST_APPROVE")).toBeInTheDocument();
    expect(screen.getByText("ACCESS_REQUEST_DENY")).toBeInTheDocument();

    // HISTORY_PURGE is now subscribable (dispatched via logAudit)
    expect(screen.getByText("HISTORY_PURGE")).toBeInTheDocument();
    // AUDIT_LOG_PURGE — separate action for audit-log retention purge
    expect(screen.getByText("AUDIT_LOG_PURGE")).toBeInTheDocument();

    // MCP Client actions
    expect(screen.getByText("MCP_CLIENT_CREATE")).toBeInTheDocument();

    // Delegation actions
    expect(screen.getByText("DELEGATION_CREATE")).toBeInTheDocument();
  });
});
