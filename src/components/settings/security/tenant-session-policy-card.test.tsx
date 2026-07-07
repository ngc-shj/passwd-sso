// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  SESSION_IDLE_TIMEOUT_MIN,
  SESSION_IDLE_TIMEOUT_MAX,
} from "@/lib/validations/common";

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

import { setupPasskeyReauthDialogMocks } from "@/__tests__/helpers/passkey-reauth-mocks";
setupPasskeyReauthDialogMocks();

vi.mock("@/lib/auth/webauthn/can-use-passkey-recovery", () => ({
  canUsePasskeyRecovery: mockCanUsePasskeyRecovery,
}));

vi.mock("@/lib/auth/webauthn/passkey-reauth-client", () => ({
  reauthenticateWithPasskey: mockReauthenticateWithPasskey,
}));

import { TenantSessionPolicyCard } from "./tenant-session-policy-card";

const DEFAULT_DATA = {
  maxConcurrentSessions: null,
  sessionIdleTimeoutMinutes: 480,
  sessionAbsoluteTimeoutMinutes: 43200,
  extensionTokenIdleTimeoutMinutes: 10080,
  extensionTokenAbsoluteTimeoutMinutes: 43200,
  vaultAutoLockMinutes: null,
};

function setupGet(data: Record<string, unknown> = DEFAULT_DATA) {
  mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
    if (!init || init.method === undefined || init.method === "GET") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(data),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
  });
}

describe("TenantSessionPolicyCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
  });

  it("disables save button when no changes (R26)", async () => {
    setupGet();
    render(<TenantSessionPolicyCard />);
    const save = await screen.findByRole("button", {
      name: "sessionPolicySave",
    });
    expect(save).toBeDisabled();
  });

  it("R23: typing an out-of-range idle timeout does not clamp on change; blur clamps to MAX", async () => {
    setupGet();
    render(<TenantSessionPolicyCard />);
    await screen.findByRole("button", { name: "sessionPolicySave" });

    const idle = document.getElementById("idle-timeout") as HTMLInputElement;
    fireEvent.change(idle, {
      target: { value: String(SESSION_IDLE_TIMEOUT_MAX + 10) },
    });
    expect(idle.value).toBe(String(SESSION_IDLE_TIMEOUT_MAX + 10));

    fireEvent.blur(idle);
    await waitFor(() => {
      expect(idle.value).toBe(String(SESSION_IDLE_TIMEOUT_MAX));
    });
  });

  it("R27: help text references the constant min/max via interpolation", async () => {
    setupGet();
    render(<TenantSessionPolicyCard />);
    await screen.findByRole("button", { name: "sessionPolicySave" });

    // Help text key is interpolated; the params object includes min/max.
    const expected = `idleTimeoutHelp:${JSON.stringify({
      min: SESSION_IDLE_TIMEOUT_MIN,
      max: SESSION_IDLE_TIMEOUT_MAX,
    })}`;
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it("posts session timeouts on save", async () => {
    setupGet();
    render(<TenantSessionPolicyCard />);
    const save = await screen.findByRole("button", {
      name: "sessionPolicySave",
    });

    const idle = document.getElementById("idle-timeout") as HTMLInputElement;
    fireEvent.change(idle, { target: { value: "120" } });

    fireEvent.click(save);

    await waitFor(() => {
      const patchCalls = mockFetch.mock.calls.filter(
        (c) => (c[1] as RequestInit | undefined)?.method === "PATCH",
      );
      expect(patchCalls.length).toBe(1);
      const body = JSON.parse(String((patchCalls[0][1] as RequestInit).body));
      expect(body.sessionIdleTimeoutMinutes).toBe(120);
    });
  });

  it("shows the recent-session dialog on a SESSION_STEP_UP_REQUIRED save denial, without a generic error toast", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined || init.method === "GET") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(DEFAULT_DATA),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
      });
    });
    render(<TenantSessionPolicyCard />);
    const save = await screen.findByRole("button", {
      name: "sessionPolicySave",
    });

    const idle = document.getElementById("idle-timeout") as HTMLInputElement;
    fireEvent.change(idle, { target: { value: "120" } });
    fireEvent.click(save);

    expect(await screen.findByTestId("recent-session-dialog")).toBeInTheDocument();
    expect(mockToast.error).not.toHaveBeenCalled();
  });
});
