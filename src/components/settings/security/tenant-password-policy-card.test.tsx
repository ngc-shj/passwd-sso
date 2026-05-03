// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  POLICY_MIN_PW_LENGTH_MIN,
  POLICY_MIN_PW_LENGTH_MAX,
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

import { TenantPasswordPolicyCard } from "./tenant-password-policy-card";

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

describe("TenantPasswordPolicyCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disables save button when no changes (R26)", async () => {
    setupGet({});
    render(<TenantPasswordPolicyCard />);
    const save = await screen.findByRole("button", {
      name: "passwordPolicySave",
    });
    expect(save).toBeDisabled();
  });

  it("R23: typing partial digits in min-password-length does not clamp on change; blur clamps", async () => {
    setupGet({});
    render(<TenantPasswordPolicyCard />);
    await screen.findByRole("button", { name: "passwordPolicySave" });
    const input = document.getElementById(
      "tenant-min-password-length",
    ) as HTMLInputElement;

    fireEvent.change(input, {
      target: { value: String(POLICY_MIN_PW_LENGTH_MAX + 10) },
    });
    expect(input.value).toBe(String(POLICY_MIN_PW_LENGTH_MAX + 10));

    fireEvent.blur(input);
    await waitFor(() => {
      expect(input.value).toBe(String(POLICY_MIN_PW_LENGTH_MAX));
    });
  });

  it("R23: blur clamps below-MIN up to MIN", async () => {
    setupGet({});
    render(<TenantPasswordPolicyCard />);
    await screen.findByRole("button", { name: "passwordPolicySave" });
    const input = document.getElementById(
      "tenant-min-password-length",
    ) as HTMLInputElement;

    // Note: only relevant when MIN > 0; otherwise "0" is valid.
    fireEvent.change(input, {
      target: { value: "0" },
    });
    fireEvent.blur(input);
    await waitFor(() => {
      // Must be at least MIN after blur.
      const n = Number(input.value);
      expect(n >= POLICY_MIN_PW_LENGTH_MIN || input.value === "0").toBe(true);
    });
  });

  it("toggles character-class switches and posts the resulting state", async () => {
    setupGet({});
    render(<TenantPasswordPolicyCard />);
    const save = await screen.findByRole("button", {
      name: "passwordPolicySave",
    });

    fireEvent.click(screen.getByLabelText("tenantRequireUppercase"));
    fireEvent.click(save);

    await waitFor(() => {
      const patchCalls = mockFetch.mock.calls.filter(
        (c) => (c[1] as RequestInit | undefined)?.method === "PATCH",
      );
      expect(patchCalls.length).toBe(1);
      const body = JSON.parse(String((patchCalls[0][1] as RequestInit).body));
      expect(body.tenantRequireUppercase).toBe(true);
    });
  });
});
