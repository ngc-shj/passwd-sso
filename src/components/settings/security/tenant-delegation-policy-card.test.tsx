// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  DELEGATION_TTL_MIN,
  DELEGATION_TTL_MAX,
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
});
