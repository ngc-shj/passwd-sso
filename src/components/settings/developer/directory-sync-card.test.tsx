// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const { mockFetch, mockToast, mockCanUsePasskeyRecovery, mockReauthenticateWithPasskey } =
  vi.hoisted(() => ({
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
  formatDateTime: (d: string) => d,
  formatRelativeTime: (d: string) => d,
}));

import { setupPasskeyReauthDialogMocks } from "@/__tests__/helpers/passkey-reauth-mocks";
setupPasskeyReauthDialogMocks();

vi.mock("@/lib/auth/webauthn/can-use-passkey-recovery", () => ({
  canUsePasskeyRecovery: mockCanUsePasskeyRecovery,
}));

vi.mock("@/lib/auth/webauthn/passkey-reauth-client", () => ({
  reauthenticateWithPasskey: mockReauthenticateWithPasskey,
}));

import { DirectorySyncCard } from "./directory-sync-card";

function setupConfigs(configs: Array<Record<string, unknown>>) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (
      String(url).includes("directory-sync") &&
      (!init || init.method === undefined || init.method === "GET")
    ) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(configs),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
  });
}

const SAMPLE_CONFIG = {
  id: "cfg-del",
  provider: "AZURE_AD",
  displayName: "DeleteMe",
  enabled: true,
  syncIntervalMinutes: 60,
  status: "IDLE",
  lastSyncAt: null,
  lastSyncError: null,
  lastSyncStats: null,
  nextSyncAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("DirectorySyncCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
    mockReauthenticateWithPasskey.mockResolvedValue({ ok: true });
  });

  it("renders empty state when no configs", async () => {
    setupConfigs([]);
    render(<DirectorySyncCard />);
    await waitFor(() => {
      expect(screen.getByText("noConfigs")).toBeInTheDocument();
    });
  });

  it("renders a config row with provider/status badges", async () => {
    setupConfigs([
      {
        id: "cfg1",
        provider: "AZURE_AD",
        displayName: "MyAzure",
        enabled: true,
        syncIntervalMinutes: 60,
        status: "IDLE",
        lastSyncAt: null,
        lastSyncError: null,
        lastSyncStats: null,
        nextSyncAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    render(<DirectorySyncCard />);
    await waitFor(() => {
      expect(screen.getByText("MyAzure")).toBeInTheDocument();
    });
    expect(screen.getByText("providerAzureAd")).toBeInTheDocument();
    expect(screen.getByText("statusIdle")).toBeInTheDocument();
    expect(screen.getByText(/neverSynced/)).toBeInTheDocument();
  });

  it("renders disabled badge when config is disabled", async () => {
    setupConfigs([
      {
        id: "cfg2",
        provider: "OKTA",
        displayName: "Okta-Disabled",
        enabled: false,
        syncIntervalMinutes: 60,
        status: "IDLE",
        lastSyncAt: null,
        lastSyncError: null,
        lastSyncStats: null,
        nextSyncAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    render(<DirectorySyncCard />);
    await waitFor(() => {
      expect(screen.getByText("Okta-Disabled")).toBeInTheDocument();
    });
    expect(screen.getByText("disabled")).toBeInTheDocument();
  });

  it("renders the lastSyncError when present", async () => {
    setupConfigs([
      {
        id: "cfg3",
        provider: "GOOGLE_WORKSPACE",
        displayName: "GW-Failed",
        enabled: true,
        syncIntervalMinutes: 60,
        status: "ERROR",
        lastSyncAt: new Date().toISOString(),
        lastSyncError: "auth failure xyz",
        lastSyncStats: null,
        nextSyncAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    render(<DirectorySyncCard />);
    await waitFor(() => {
      expect(screen.getByText("GW-Failed")).toBeInTheDocument();
    });
    expect(screen.getByText("auth failure xyz")).toBeInTheDocument();
  });

  // RT8: a stale-session DELETE must surface the reauth recovery path, not the
  // generic syncFailed toast, and must NOT commit the deletion.
  it("opens the recent-session dialog on a SESSION_STEP_UP_REQUIRED delete (RT8)", async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (String(url).includes("directory-sync") && method === "GET") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([SAMPLE_CONFIG]),
        });
      }
      if (method === "DELETE") {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    });

    render(<DirectorySyncCard />);
    await waitFor(() => {
      expect(screen.getByText("DeleteMe")).toBeInTheDocument();
    });

    // The trash trigger is the last button in the config row; clicking it opens
    // the delete-confirm dialog whose action button is labelled deleteConfig.
    const rowButtons = screen.getAllByRole("button");
    fireEvent.click(rowButtons[rowButtons.length - 1]);

    const confirmBtn = await screen.findByRole("button", { name: "deleteConfig" });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(screen.getByTestId("recent-session-dialog")).toBeInTheDocument();
    });
    expect(mockToast.success).not.toHaveBeenCalledWith("configDeleted");
    expect(mockToast.error).not.toHaveBeenCalled();
  });
});
