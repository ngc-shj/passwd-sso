// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MAX_CIDRS } from "@/lib/validations/common";

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

import { TenantAccessRestrictionCard } from "./tenant-access-restriction-card";

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

describe("TenantAccessRestrictionCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disables save when no changes (R26)", async () => {
    setupGet({ allowedCidrs: [], tailscaleEnabled: false });
    render(<TenantAccessRestrictionCard />);
    const save = await screen.findByRole("button", {
      name: "accessRestrictionSave",
    });
    expect(save).toBeDisabled();
  });

  it("R27: rejects when more than MAX_CIDRS lines are entered (constant referenced via interpolation)", async () => {
    setupGet({ allowedCidrs: [], tailscaleEnabled: false });
    render(<TenantAccessRestrictionCard />);
    const save = await screen.findByRole("button", {
      name: "accessRestrictionSave",
    });

    // Generate MAX_CIDRS + 1 valid CIDRs
    const tooMany = Array.from(
      { length: MAX_CIDRS + 1 },
      (_, i) => `10.0.${i}.0/24`,
    ).join("\n");
    const cidrs = screen.getByLabelText("allowedCidrsLabel");
    fireEvent.change(cidrs, { target: { value: tooMany } });
    fireEvent.click(save);

    await waitFor(() => {
      const expected = `allowedCidrsValidationMax:${JSON.stringify({
        max: MAX_CIDRS,
      })}`;
      expect(screen.getByText(expected)).toBeInTheDocument();
    });
  });

  it("rejects an invalid CIDR format with the invalid-cidr error", async () => {
    setupGet({ allowedCidrs: [], tailscaleEnabled: false });
    render(<TenantAccessRestrictionCard />);
    const save = await screen.findByRole("button", {
      name: "accessRestrictionSave",
    });

    const cidrs = screen.getByLabelText("allowedCidrsLabel");
    fireEvent.change(cidrs, { target: { value: "not-a-cidr" } });
    fireEvent.click(save);

    await waitFor(() => {
      expect(
        screen.getByText(/^allowedCidrsValidationInvalid/),
      ).toBeInTheDocument();
    });
  });

  it("opens self-lockout dialog on 409 SELF_LOCKOUT response", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({ allowedCidrs: [], tailscaleEnabled: false }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ error: "SELF_LOCKOUT" }),
      });
    });
    render(<TenantAccessRestrictionCard />);
    const save = await screen.findByRole("button", {
      name: "accessRestrictionSave",
    });

    const cidrs = screen.getByLabelText("allowedCidrsLabel");
    fireEvent.change(cidrs, { target: { value: "10.0.0.0/24" } });
    fireEvent.click(save);

    await waitFor(() => {
      expect(screen.getByText("selfLockoutWarning")).toBeInTheDocument();
    });
  });
});
