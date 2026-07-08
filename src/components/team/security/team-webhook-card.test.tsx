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

import { render, screen, act, waitFor, fireEvent, within } from "@testing-library/react";

const { mockFetch, mockToast, mockCanUsePasskeyRecovery, mockReauthenticateWithPasskey } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockToast: { error: vi.fn(), success: vi.fn() },
  mockCanUsePasskeyRecovery: vi.fn(),
  mockReauthenticateWithPasskey: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  // RecentSessionRequiredDialog (step-up reauth flow) calls useLocale.
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

import { setupPasskeyReauthDialogMocks } from "@/__tests__/helpers/passkey-reauth-mocks";
setupPasskeyReauthDialogMocks();

vi.mock("@/lib/auth/webauthn/can-use-passkey-recovery", () => ({
  canUsePasskeyRecovery: mockCanUsePasskeyRecovery,
}));

vi.mock("@/lib/auth/webauthn/passkey-reauth-client", () => ({
  reauthenticateWithPasskey: mockReauthenticateWithPasskey,
}));

import {
  setupWebhookCardMocks,
  createWebhookCardTests,
  setupFetchWebhooks,
  createSampleWebhooks,
} from "../../__tests__/webhook-card-test-factory";

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
    // Default: user has no passkey → the recent-session dialog opens.
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
    mockReauthenticateWithPasskey.mockResolvedValue({ ok: true, verifiedAt: "2026-05-10T00:00:00Z" });
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

    // Admin group (team-scoped subset only)
    expect(screen.getByText("POLICY_UPDATE")).toBeInTheDocument();
    expect(screen.getByText("TEAM_KEY_ROTATION")).toBeInTheDocument();

    // Tenant-scoped actions must NOT appear
    expect(screen.queryByText("SCIM_USER_CREATE")).not.toBeInTheDocument();
    expect(screen.queryByText("MASTER_KEY_ROTATION")).not.toBeInTheDocument();
    expect(screen.queryByText("ADMIN_VAULT_RESET_INITIATE")).not.toBeInTheDocument();
    expect(screen.queryByText("ADMIN_VAULT_RESET_APPROVE")).not.toBeInTheDocument();
  });

  it("create — opens RecentSessionRequiredDialog when SESSION_STEP_UP_REQUIRED is returned", async () => {
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
          status: 403,
          json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
        });
      }
      return Promise.resolve({ ok: false, status: 500 });
    });

    await act(async () => {
      render(<TeamWebhookCard teamId="team-1" locale="en" />);
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

    const submitBtn = within(screen.getByTestId("dialog-content"))
      .getAllByRole("button")
      .find((b) => b.textContent?.includes("addWebhook"))!;
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
      if (!init?.method || init.method === "GET") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ webhooks: sampleWebhooks }),
        });
      }
      if (init.method === "DELETE") {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
        });
      }
      return Promise.resolve({ ok: false, status: 500 });
    });

    await act(async () => {
      render(<TeamWebhookCard teamId="team-1" locale="en" />);
    });

    await waitFor(() => {
      expect(
        screen.getAllByText("https://example.com/hook1").length,
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
