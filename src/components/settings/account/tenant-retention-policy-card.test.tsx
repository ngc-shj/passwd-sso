// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  AUDIT_LOG_RETENTION_MIN,
  AUDIT_LOG_RETENTION_MAX,
  RETENTION_DAYS_MIN,
  RETENTION_DAYS_MAX,
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
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
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

  it("shows the recent-session dialog on a SESSION_STEP_UP_REQUIRED save denial, without a generic error toast", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ auditLogRetentionDays: 365 }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
      });
    });
    render(<TenantRetentionPolicyCard />);
    const save = await screen.findByRole("button", {
      name: "retentionPolicySave",
    });

    fireEvent.click(screen.getByLabelText("auditLogRetentionEnabled"));
    fireEvent.click(save);

    expect(await screen.findByTestId("recent-session-dialog")).toBeInTheDocument();
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  describe("generic retention fields", () => {
    const FIELDS = [
      { key: "trashRetentionDays", labelKey: "trashRetention" },
      { key: "historyRetentionDays", labelKey: "historyRetention" },
      { key: "shareAccessLogRetentionDays", labelKey: "shareAccessLogRetention" },
      { key: "directorySyncLogRetentionDays", labelKey: "directorySyncLogRetention" },
      { key: "notificationRetentionDays", labelKey: "notificationRetention" },
    ] as const;

    for (const { key, labelKey } of FIELDS) {
      it(`hydrates ${key} from GET and shows the days input when set`, async () => {
        setupGet({ auditLogRetentionDays: 365, [key]: 30 });
        render(<TenantRetentionPolicyCard />);
        const input = (await screen.findByLabelText(
          `${labelKey}Days`,
        )) as HTMLInputElement;
        expect(input.value).toBe("30");
      });

      it(`enables ${key} via toggle and PATCHes the typed value`, async () => {
        setupGet({ auditLogRetentionDays: 365 });
        render(<TenantRetentionPolicyCard />);
        const save = await screen.findByRole("button", {
          name: "retentionPolicySave",
        });

        // Field starts disabled (null from GET); toggle on, then type a value.
        fireEvent.click(screen.getByLabelText(`${labelKey}Enabled`));
        const input = screen.getByLabelText(`${labelKey}Days`) as HTMLInputElement;
        fireEvent.change(input, { target: { value: "45" } });

        expect(save).not.toBeDisabled();
        fireEvent.click(save);

        await waitFor(() => {
          const patchCalls = mockFetch.mock.calls.filter(
            (c) => (c[1] as RequestInit | undefined)?.method === "PATCH",
          );
          expect(patchCalls.length).toBe(1);
          const body = JSON.parse(String((patchCalls[0][1] as RequestInit).body));
          expect(body[key]).toBe(45);
        });
      });

      it(`PATCHes null for ${key} when its toggle is off`, async () => {
        setupGet({ auditLogRetentionDays: 365, [key]: 30 });
        render(<TenantRetentionPolicyCard />);
        const save = await screen.findByRole("button", {
          name: "retentionPolicySave",
        });

        // Toggle the (initially-on) field off, then save.
        fireEvent.click(screen.getByLabelText(`${labelKey}Enabled`));
        fireEvent.click(save);

        await waitFor(() => {
          const patchCalls = mockFetch.mock.calls.filter(
            (c) => (c[1] as RequestInit | undefined)?.method === "PATCH",
          );
          expect(patchCalls.length).toBe(1);
          const body = JSON.parse(String((patchCalls[0][1] as RequestInit).body));
          expect(body[key]).toBeNull();
        });
      });

      it(`range-validates ${key}: blur clamps over-max down to max`, async () => {
        setupGet({ auditLogRetentionDays: 365, [key]: 30 });
        render(<TenantRetentionPolicyCard />);
        const input = (await screen.findByLabelText(
          `${labelKey}Days`,
        )) as HTMLInputElement;

        fireEvent.change(input, { target: { value: String(RETENTION_DAYS_MAX + 100) } });
        expect(input.value).toBe(String(RETENTION_DAYS_MAX + 100));

        fireEvent.blur(input);
        await waitFor(() => {
          expect(input.value).toBe(String(RETENTION_DAYS_MAX));
        });
      });

      it(`range-validates ${key}: blur clamps below-min up to min`, async () => {
        setupGet({ auditLogRetentionDays: 365, [key]: 30 });
        render(<TenantRetentionPolicyCard />);
        const input = (await screen.findByLabelText(
          `${labelKey}Days`,
        )) as HTMLInputElement;

        fireEvent.change(input, { target: { value: "0" } });
        expect(input.value).toBe("0");

        fireEvent.blur(input);
        await waitFor(() => {
          expect(input.value).toBe(String(RETENTION_DAYS_MIN));
        });
      });
    }
  });
});
