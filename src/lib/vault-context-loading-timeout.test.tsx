// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";

const { mockUseSession, mockFetchApi } = vi.hoisted(() => ({
  mockUseSession: vi.fn(),
  mockFetchApi: vi.fn(),
}));

vi.mock("next-auth/react", () => ({
  useSession: mockUseSession,
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: mockFetchApi,
  isHttps: false,
}));

vi.mock("@/lib/constants", () => ({
  API_PATH: { VAULT_STATUS: "/api/vault/status" },
  apiPath: {},
  VAULT_STATUS: {
    LOADING: "LOADING",
    LOCKED: "LOCKED",
    UNLOCKED: "UNLOCKED",
    SETUP_REQUIRED: "SETUP_REQUIRED",
  },
  API_ERROR: {},
}));

vi.mock("@/lib/api-error-codes", () => ({
  API_ERROR: {},
}));

vi.mock("./crypto-client", () => ({}));
vi.mock("./crypto-emergency", () => ({}));
vi.mock("./crypto-team", () => ({}));
vi.mock("./webauthn-client", () => ({}));
vi.mock("./team/team-vault-context", () => ({
  TeamVaultProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("./vault/auto-lock-context", () => ({
  AutoLockProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("./emergency-access-context", () => ({
  EmergencyAccessProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  confirmPendingEmergencyGrants: vi.fn(),
}));

import { VaultProvider, useVault } from "./vault/vault-context";

function VaultStatusDisplay() {
  const { status } = useVault();
  return <div data-testid="vault-status">{status}</div>;
}

describe("VaultProvider LOADING timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetchApi.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("falls back to LOCKED after 15s when session stays loading", async () => {
    // Session stuck in "loading" state — simulates OIDC re-auth race condition
    const mockUpdate = vi.fn();
    mockUseSession.mockReturnValue({
      data: null,
      status: "loading",
      update: mockUpdate,
    });

    let container: HTMLElement;
    await act(async () => {
      const result = render(
        <VaultProvider>
          <VaultStatusDisplay />
        </VaultProvider>,
      );
      container = result.container;
    });

    // Initially LOADING (sessionStatus is "loading", so checkVaultStatus doesn't run)
    expect(container!.querySelector("[data-testid='vault-status']")!.textContent).toBe("LOADING");

    // Advance to 10s — should trigger session refresh retry
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(mockUpdate).toHaveBeenCalledTimes(1);

    // Still LOADING (update didn't change sessionStatus)
    expect(container!.querySelector("[data-testid='vault-status']")!.textContent).toBe("LOADING");

    // Advance to 15s — should fall back to LOCKED
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(container!.querySelector("[data-testid='vault-status']")!.textContent).toBe("LOCKED");
  });

  it("does not trigger timeout when session resolves normally", async () => {
    const mockUpdate = vi.fn();
    mockUseSession.mockReturnValue({
      data: { user: { id: "user-1" } },
      status: "authenticated",
      update: mockUpdate,
    });

    // Mock successful vault status check
    mockFetchApi.mockResolvedValue({
      ok: true,
      json: async () => ({ setupRequired: false, hasRecoveryKey: false }),
    });

    let container: HTMLElement;
    await act(async () => {
      const result = render(
        <VaultProvider>
          <VaultStatusDisplay />
        </VaultProvider>,
      );
      container = result.container;
    });

    // Should resolve to LOCKED (vault is locked, not LOADING)
    expect(container!.querySelector("[data-testid='vault-status']")!.textContent).toBe("LOCKED");

    // Advance past timeout — should NOT call update
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
