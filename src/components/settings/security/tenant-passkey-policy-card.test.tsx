// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  PIN_LENGTH_MIN,
  PIN_LENGTH_MAX,
} from "@/lib/validations/common";

const { mockFetch, mockToast } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("next-intl", () => ({
  useTranslations: () =>
    (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

import { TenantPasskeyPolicyCard } from "./tenant-passkey-policy-card";

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

describe("TenantPasskeyPolicyCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disables save button when no changes (R26)", async () => {
    setupGet({ requirePasskey: false, requireMinPinLength: null });
    render(<TenantPasskeyPolicyCard />);
    const save = await screen.findByRole("button", {
      name: "passkeyPolicySave",
    });
    expect(save).toBeDisabled();
  });

  it("R23: blur clamps PIN length below MIN up to MIN", async () => {
    setupGet({ requirePasskey: false, requireMinPinLength: null });
    render(<TenantPasskeyPolicyCard />);
    await screen.findByRole("button", { name: "passkeyPolicySave" });

    const pin = document.getElementById("min-pin-length") as HTMLInputElement;
    fireEvent.change(pin, { target: { value: "1" } });
    expect(pin.value).toBe("1");
    fireEvent.blur(pin);
    await waitFor(() => {
      expect(pin.value).toBe(String(PIN_LENGTH_MIN));
    });
  });

  it("R23: blur clamps PIN length above MAX down to MAX", async () => {
    setupGet({ requirePasskey: false, requireMinPinLength: null });
    render(<TenantPasskeyPolicyCard />);
    await screen.findByRole("button", { name: "passkeyPolicySave" });

    const pin = document.getElementById("min-pin-length") as HTMLInputElement;
    fireEvent.change(pin, { target: { value: String(PIN_LENGTH_MAX + 50) } });
    fireEvent.blur(pin);
    await waitFor(() => {
      expect(pin.value).toBe(String(PIN_LENGTH_MAX));
    });
  });

  it("posts requirePasskey + null requireMinPinLength when toggled on without grace", async () => {
    setupGet({ requirePasskey: false, requireMinPinLength: null });
    render(<TenantPasskeyPolicyCard />);
    const save = await screen.findByRole("button", {
      name: "passkeyPolicySave",
    });

    fireEvent.click(screen.getByLabelText("requirePasskey"));
    fireEvent.click(save);

    await waitFor(() => {
      const patchCalls = mockFetch.mock.calls.filter(
        (c) => (c[1] as RequestInit | undefined)?.method === "PATCH",
      );
      expect(patchCalls.length).toBe(1);
      const body = JSON.parse(String((patchCalls[0][1] as RequestInit).body));
      expect(body.requirePasskey).toBe(true);
      expect(body.passkeyGracePeriodDays).toBeNull();
    });
  });
});
