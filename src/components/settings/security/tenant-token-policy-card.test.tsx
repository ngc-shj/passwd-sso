// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  JIT_TOKEN_TTL_MIN,
  JIT_TOKEN_TTL_MAX,
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

import { TenantTokenPolicyCard } from "./tenant-token-policy-card";

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

describe("TenantTokenPolicyCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disables save button when no changes (R26)", async () => {
    setupGet({
      saTokenMaxExpiryDays: null,
      jitTokenDefaultTtlSec: null,
      jitTokenMaxTtlSec: null,
    });
    render(<TenantTokenPolicyCard />);
    const save = await screen.findByRole("button", {
      name: "tokenPolicySave",
    });
    expect(save).toBeDisabled();
  });

  it("R23: blur clamps JIT default TTL above MAX down to MAX", async () => {
    setupGet({
      saTokenMaxExpiryDays: null,
      jitTokenDefaultTtlSec: 3600,
      jitTokenMaxTtlSec: null,
    });
    render(<TenantTokenPolicyCard />);
    await screen.findByRole("button", { name: "tokenPolicySave" });
    const input = document.getElementById(
      "jit-token-default-ttl",
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: String(JIT_TOKEN_TTL_MAX + 100) },
    });
    expect(input.value).toBe(String(JIT_TOKEN_TTL_MAX + 100));
    fireEvent.blur(input);
    await waitFor(() => {
      expect(input.value).toBe(String(JIT_TOKEN_TTL_MAX));
    });
  });

  it("R23: blur clamps JIT default TTL below MIN up to MIN", async () => {
    setupGet({
      saTokenMaxExpiryDays: null,
      jitTokenDefaultTtlSec: 3600,
      jitTokenMaxTtlSec: null,
    });
    render(<TenantTokenPolicyCard />);
    await screen.findByRole("button", { name: "tokenPolicySave" });
    const input = document.getElementById(
      "jit-token-default-ttl",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(input.value).toBe(String(JIT_TOKEN_TTL_MIN));
    });
  });

  it("rejects when JIT default exceeds JIT max with cross-field validation error", async () => {
    setupGet({
      saTokenMaxExpiryDays: null,
      jitTokenDefaultTtlSec: 3600,
      jitTokenMaxTtlSec: 7200,
    });
    render(<TenantTokenPolicyCard />);
    const save = await screen.findByRole("button", {
      name: "tokenPolicySave",
    });
    const def = document.getElementById(
      "jit-token-default-ttl",
    ) as HTMLInputElement;
    fireEvent.change(def, { target: { value: "9000" } });
    fireEvent.click(save);
    await waitFor(() => {
      expect(
        screen.getByText("jitTokenDefaultExceedsMax"),
      ).toBeInTheDocument();
    });
  });
});
