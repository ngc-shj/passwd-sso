// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  LOCKOUT_THRESHOLD_MIN,
  LOCKOUT_THRESHOLD_MAX,
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

import { TenantLockoutPolicyCard } from "./tenant-lockout-policy-card";

function setupGet(data: Record<string, unknown>) {
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

describe("TenantLockoutPolicyCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
  });

  it("disables save button when no changes (R26)", async () => {
    setupGet({});
    render(<TenantLockoutPolicyCard />);
    const save = await screen.findByRole("button", {
      name: "lockoutPolicySave",
    });
    expect(save).toBeDisabled();
  });

  it("renders 3 tiers (threshold + duration each)", async () => {
    setupGet({});
    render(<TenantLockoutPolicyCard />);
    await screen.findByRole("button", { name: "lockoutPolicySave" });
    expect(document.getElementById("lockout-threshold-1")).not.toBeNull();
    expect(document.getElementById("lockout-threshold-2")).not.toBeNull();
    expect(document.getElementById("lockout-threshold-3")).not.toBeNull();
    expect(document.getElementById("lockout-duration-1")).not.toBeNull();
    expect(document.getElementById("lockout-duration-2")).not.toBeNull();
    expect(document.getElementById("lockout-duration-3")).not.toBeNull();
  });

  it("R23: blur clamps an over-MAX threshold to MAX (no clamp on change)", async () => {
    setupGet({});
    render(<TenantLockoutPolicyCard />);
    await screen.findByRole("button", { name: "lockoutPolicySave" });

    const t1 = document.getElementById(
      "lockout-threshold-1",
    ) as HTMLInputElement;
    fireEvent.change(t1, {
      target: { value: String(LOCKOUT_THRESHOLD_MAX + 50) },
    });
    expect(t1.value).toBe(String(LOCKOUT_THRESHOLD_MAX + 50));

    fireEvent.blur(t1);
    await waitFor(() => {
      expect(t1.value).toBe(String(LOCKOUT_THRESHOLD_MAX));
    });
  });

  it("validates ascending thresholds and surfaces error", async () => {
    setupGet({});
    render(<TenantLockoutPolicyCard />);
    const save = await screen.findByRole("button", {
      name: "lockoutPolicySave",
    });

    const t1 = document.getElementById(
      "lockout-threshold-1",
    ) as HTMLInputElement;
    const t2 = document.getElementById(
      "lockout-threshold-2",
    ) as HTMLInputElement;
    fireEvent.change(t1, {
      target: { value: String(LOCKOUT_THRESHOLD_MIN + 5) },
    });
    fireEvent.change(t2, { target: { value: String(LOCKOUT_THRESHOLD_MIN) } });
    fireEvent.click(save);
    await waitFor(() => {
      expect(
        screen.getByText("lockoutThresholdAscending"),
      ).toBeInTheDocument();
    });
  });

  it("shows the recent-session dialog on a SESSION_STEP_UP_REQUIRED save denial, without a generic error toast", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined || init.method === "GET") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({}),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
      });
    });
    render(<TenantLockoutPolicyCard />);
    const save = await screen.findByRole("button", {
      name: "lockoutPolicySave",
    });

    const t1 = document.getElementById("lockout-threshold-1") as HTMLInputElement;
    fireEvent.change(t1, { target: { value: String(LOCKOUT_THRESHOLD_MIN) } });
    fireEvent.click(save);

    expect(await screen.findByTestId("recent-session-dialog")).toBeInTheDocument();
    expect(mockToast.error).not.toHaveBeenCalled();
  });
});
