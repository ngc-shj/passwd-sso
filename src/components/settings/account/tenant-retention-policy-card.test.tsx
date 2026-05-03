// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  AUDIT_LOG_RETENTION_MIN,
  AUDIT_LOG_RETENTION_MAX,
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

import { TenantRetentionPolicyCard } from "./tenant-retention-policy-card";

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

describe("TenantRetentionPolicyCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disables save button when no changes (R26)", async () => {
    setupGet({ auditLogRetentionDays: 365 });
    render(<TenantRetentionPolicyCard />);
    const save = await screen.findByRole("button", {
      name: "retentionPolicySave",
    });
    expect(save).toBeDisabled();
  });

  it("enables save button after toggling, and posts the new state on save", async () => {
    setupGet({ auditLogRetentionDays: 365 });
    render(<TenantRetentionPolicyCard />);
    const save = await screen.findByRole("button", {
      name: "retentionPolicySave",
    });

    // Toggle the switch off
    const toggle = screen.getByLabelText("auditLogRetentionEnabled");
    fireEvent.click(toggle);

    expect(save).not.toBeDisabled();

    fireEvent.click(save);
    await waitFor(() => {
      const patchCalls = mockFetch.mock.calls.filter(
        (c) => (c[1] as RequestInit | undefined)?.method === "PATCH",
      );
      expect(patchCalls.length).toBe(1);
      const init = patchCalls[0][1] as RequestInit;
      const body = JSON.parse(String(init.body));
      expect(body.auditLogRetentionDays).toBeNull();
    });
  });

  it("R23 (mid-stroke): typing partial digits does NOT clamp, blur clamps to min", async () => {
    setupGet({ auditLogRetentionDays: 365 });
    render(<TenantRetentionPolicyCard />);
    const input = (await screen.findByLabelText(
      "auditLogRetentionDays",
    )) as HTMLInputElement;

    // Mid-stroke: a value that violates the lower bound. No clamp on change.
    fireEvent.change(input, { target: { value: "5" } });
    expect(input.value).toBe("5");

    // Blur clamps up to MIN. fireEvent.blur uses the element's current value
    // as the event target, which (after the change above) reflects React state.
    fireEvent.blur(input);
    await waitFor(() => {
      expect(input.value).toBe(String(AUDIT_LOG_RETENTION_MIN));
    });
  });

  it("R23 (mid-stroke max): blur clamps an over-max value down to max", async () => {
    setupGet({ auditLogRetentionDays: 365 });
    render(<TenantRetentionPolicyCard />);
    const input = (await screen.findByLabelText(
      "auditLogRetentionDays",
    )) as HTMLInputElement;

    fireEvent.change(input, {
      target: { value: String(AUDIT_LOG_RETENTION_MAX + 100) },
    });
    expect(input.value).toBe(String(AUDIT_LOG_RETENTION_MAX + 100));

    fireEvent.blur(input);
    await waitFor(() => {
      expect(input.value).toBe(String(AUDIT_LOG_RETENTION_MAX));
    });
  });

  it("shows save-failed toast on PATCH failure", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({ auditLogRetentionDays: 365 }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      });
    });
    render(<TenantRetentionPolicyCard />);
    const save = await screen.findByRole("button", {
      name: "retentionPolicySave",
    });

    fireEvent.click(screen.getByLabelText("auditLogRetentionEnabled"));
    fireEvent.click(save);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("retentionPolicySaveFailed");
    });
  });
});
