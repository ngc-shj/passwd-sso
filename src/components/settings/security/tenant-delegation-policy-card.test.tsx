// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  DELEGATION_TTL_MIN,
  DELEGATION_TTL_MAX,
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

import { TenantDelegationPolicyCard } from "./tenant-delegation-policy-card";

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

describe("TenantDelegationPolicyCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
  });

  it("disables save button when no changes (R26)", async () => {
    setupGet({ delegationDefaultTtlSec: null, delegationMaxTtlSec: null });
    render(<TenantDelegationPolicyCard />);
    const save = await screen.findByRole("button", {
      name: "delegationPolicySave",
    });
    expect(save).toBeDisabled();
  });

  it("R23 (mid-stroke): typing partial value below MIN does not clamp on change; blur clamps", async () => {
    setupGet({
      delegationDefaultTtlSec: 3600,
      delegationMaxTtlSec: null,
    });
    render(<TenantDelegationPolicyCard />);
    const input = (await screen.findByLabelText(
      "delegationDefaultTtlSec",
    )) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "5" } });
    expect(input.value).toBe("5");

    fireEvent.blur(input);
    await waitFor(() => {
      expect(input.value).toBe(String(DELEGATION_TTL_MIN));
    });
  });

  it("R23 (max): blur clamps over-max down to MAX", async () => {
    setupGet({
      delegationDefaultTtlSec: 3600,
      delegationMaxTtlSec: null,
    });
    render(<TenantDelegationPolicyCard />);
    const input = (await screen.findByLabelText(
      "delegationDefaultTtlSec",
    )) as HTMLInputElement;

    fireEvent.change(input, {
      target: { value: String(DELEGATION_TTL_MAX + 1000) },
    });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(input.value).toBe(String(DELEGATION_TTL_MAX));
    });
  });

  it("posts both default and max TTL on save", async () => {
    setupGet({
      delegationDefaultTtlSec: 3600,
      delegationMaxTtlSec: 7200,
    });
    render(<TenantDelegationPolicyCard />);
    const save = await screen.findByRole("button", {
      name: "delegationPolicySave",
    });

    const defaultInput = await screen.findByLabelText("delegationDefaultTtlSec");
    fireEvent.change(defaultInput, { target: { value: "1800" } });

    fireEvent.click(save);
    await waitFor(() => {
      const patchCalls = mockFetch.mock.calls.filter(
        (c) => (c[1] as RequestInit | undefined)?.method === "PATCH",
      );
      expect(patchCalls.length).toBe(1);
      const body = JSON.parse(String((patchCalls[0][1] as RequestInit).body));
      expect(body.delegationDefaultTtlSec).toBe(1800);
      expect(body.delegationMaxTtlSec).toBe(7200);
    });
  });

  it("shows validation error when default exceeds max", async () => {
    setupGet({
      delegationDefaultTtlSec: 3600,
      delegationMaxTtlSec: 7200,
    });
    render(<TenantDelegationPolicyCard />);
    const save = await screen.findByRole("button", {
      name: "delegationPolicySave",
    });

    const defaultInput = await screen.findByLabelText("delegationDefaultTtlSec");
    fireEvent.change(defaultInput, { target: { value: "9000" } });
    fireEvent.click(save);

    await waitFor(() => {
      expect(
        screen.getByText("delegationDefaultExceedsMax"),
      ).toBeInTheDocument();
    });
  });

  it("shows the recent-session dialog on a SESSION_STEP_UP_REQUIRED save denial, without a generic error toast", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined || init.method === "GET") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({ delegationDefaultTtlSec: null, delegationMaxTtlSec: null }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
      });
    });
    render(<TenantDelegationPolicyCard />);
    const save = await screen.findByRole("button", {
      name: "delegationPolicySave",
    });

    // No `await` between the toggle and the save click: the revealed field
    // renders synchronously off the same state update, and yielding here
    // would let the test's unstable-`t` mock retrigger fetchPolicy's
    // `useEffect` (its useCallback deps include `t`) and clobber the toggle
    // before save fires — a mock-only race (real next-intl memoizes `t`).
    fireEvent.click(screen.getByLabelText("delegationDefaultEnabled"));
    const input = screen.getByLabelText("delegationDefaultTtlSec");
    fireEvent.change(input, { target: { value: "3600" } });
    fireEvent.click(save);

    expect(await screen.findByTestId("recent-session-dialog")).toBeInTheDocument();
    expect(mockToast.error).not.toHaveBeenCalled();
  });
});
