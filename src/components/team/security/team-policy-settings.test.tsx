// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const { mockFetch, mockToast, mockCanUsePasskeyRecovery, mockReauthenticateWithPasskey } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
  mockCanUsePasskeyRecovery: vi.fn(),
  mockReauthenticateWithPasskey: vi.fn(),
}));

// One translator instance, as next-intl returns a stable `t`: the policy
// fetch effect depends on it, so a fresh function per render would refetch.
const { translate } = vi.hoisted(() => ({
  translate: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));

vi.mock("next-intl", () => ({
  useTranslations: () => translate,
  useLocale: () => "en",
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

import "@/__tests__/helpers/passkey-reauth-mocks";

vi.mock("@/lib/auth/webauthn/can-use-passkey-recovery", () => ({
  canUsePasskeyRecovery: mockCanUsePasskeyRecovery,
}));

vi.mock("@/lib/auth/webauthn/passkey-reauth-client", () => ({
  reauthenticateWithPasskey: mockReauthenticateWithPasskey,
}));

import { TeamPolicySettings } from "./team-policy-settings";
import { POLICY_MIN_PW_LENGTH_MAX } from "@/lib/validations";

const DEFAULT_DATA = {
  minPasswordLength: 8,
  requireUppercase: false,
  requireLowercase: false,
  requireNumbers: false,
  requireSymbols: false,
  sessionIdleTimeoutMinutes: null,
  sessionAbsoluteTimeoutMinutes: null,
  requireRepromptForAll: false,
  allowExport: true,
  allowSharing: true,
  requireSharePassword: false,
  passwordHistoryCount: 0,
  inheritTenantCidrs: true,
  teamAllowedCidrs: [],
};

describe("TeamPolicySettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
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

    render(<TeamPolicySettings teamId="team-1" />);
    const save = await screen.findByRole("button", { name: "save" });

    // No htmlFor/id pairing on this field, so query by role order:
    // minPasswordLength is the first spinbutton rendered (password section).
    const minLength = screen.getAllByRole("spinbutton")[0];
    fireEvent.change(minLength, { target: { value: "12" } });
    fireEvent.click(save);

    expect(await screen.findByTestId("recent-session-dialog")).toBeInTheDocument();
    expect(mockToast.error).not.toHaveBeenCalled();
  });
});

describe("TeamPolicySettings load and save", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
  });

  // GET returns `loaded`; PUT resolves to `putResponse` and echoes the body
  // back when it is ok.
  function mockApi(
    loaded: Record<string, unknown> = DEFAULT_DATA,
    putResponse: { ok: boolean; status: number; json?: () => Promise<unknown> } = { ok: true, status: 200 },
  ) {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined || init.method === "GET") {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(loaded) });
      }
      const echoed = JSON.parse(String(init.body)) as unknown;
      return Promise.resolve({
        json: () => Promise.resolve(echoed),
        ...putResponse,
      });
    });
  }

  function putCalls() {
    return mockFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
  }

  async function editMinLength(value: string) {
    const save = await screen.findByRole("button", { name: "save" });
    fireEvent.change(screen.getAllByRole("spinbutton")[0], { target: { value } });
    return save;
  }

  it("toasts fetchError when the policy cannot be loaded", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
    render(<TeamPolicySettings teamId="team-1" />);
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("fetchError"));
  });

  it("toasts fetchError when the policy request throws", async () => {
    mockFetch.mockRejectedValue(new Error("offline"));
    render(<TeamPolicySettings teamId="team-1" />);
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("fetchError"));
  });

  it("keeps save disabled until something changes", async () => {
    mockApi();
    render(<TeamPolicySettings teamId="team-1" />);
    const save = await screen.findByRole("button", { name: "save" });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getAllByRole("spinbutton")[0], { target: { value: "12" } });

    expect(save).toBeEnabled();
  });

  it("blocks saving an out-of-range minimum length and shows the range error", async () => {
    mockApi();
    render(<TeamPolicySettings teamId="team-1" />);
    const save = await editMinLength(String(POLICY_MIN_PW_LENGTH_MAX + 1));

    fireEvent.click(save);

    expect(await screen.findByText(/^minPasswordLengthRange:/)).toBeInTheDocument();
    expect(putCalls()).toHaveLength(0);
  });

  it("clears the minimum-length error once the value is edited", async () => {
    mockApi();
    render(<TeamPolicySettings teamId="team-1" />);
    const save = await editMinLength(String(POLICY_MIN_PW_LENGTH_MAX + 1));
    fireEvent.click(save);
    expect(await screen.findByText(/^minPasswordLengthRange:/)).toBeInTheDocument();

    fireEvent.change(screen.getAllByRole("spinbutton")[0], { target: { value: "12" } });

    expect(screen.queryByText(/^minPasswordLengthRange:/)).not.toBeInTheDocument();
  });

  it("saves the full policy with blank and padded CIDR lines trimmed", async () => {
    mockApi();
    render(<TeamPolicySettings teamId="team-1" />);
    await editMinLength("12");
    fireEvent.change(screen.getByPlaceholderText("teamAllowedCidrsPlaceholder"), {
      target: { value: " 10.0.0.0/8 \n\n192.168.0.0/16\n" },
    });

    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("saveSuccess"));
    const [url, init] = putCalls()[0] as [string, RequestInit];
    expect(url).toBe("/api/teams/team-1/policy");
    expect(JSON.parse(String(init.body))).toEqual({
      ...DEFAULT_DATA,
      minPasswordLength: 12,
      teamAllowedCidrs: ["10.0.0.0/8", "192.168.0.0/16"],
    });
    expect(screen.getByPlaceholderText("teamAllowedCidrsPlaceholder")).toHaveValue(
      "10.0.0.0/8\n192.168.0.0/16",
    );
  });

  it("toasts validationError on a 400 save response", async () => {
    mockApi(DEFAULT_DATA, { ok: false, status: 400 });
    render(<TeamPolicySettings teamId="team-1" />);
    fireEvent.click(await editMinLength("12"));
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("validationError"));
  });

  it("toasts saveError on any other failed save response", async () => {
    mockApi(DEFAULT_DATA, { ok: false, status: 500, json: () => Promise.resolve({ error: "INTERNAL_ERROR" }) });
    render(<TeamPolicySettings teamId="team-1" />);
    fireEvent.click(await editMinLength("12"));
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("saveError"));
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it("turns off the share-password requirement when sharing is disabled", async () => {
    mockApi({ ...DEFAULT_DATA, requireSharePassword: true });
    render(<TeamPolicySettings teamId="team-1" section="sharing" />);
    await screen.findByRole("button", { name: "save" });
    expect(screen.getByText("requireSharePassword")).toBeInTheDocument();
    // allowExport, allowSharing, requireSharePassword — in render order.
    fireEvent.click(screen.getAllByRole("switch")[1]);
    expect(screen.queryByText("requireSharePassword")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() => expect(putCalls()).toHaveLength(1));
    const [, init] = putCalls()[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      allowSharing: false,
      requireSharePassword: false,
    });
  });

  it("renders only the session section with its own header", async () => {
    mockApi();
    render(<TeamPolicySettings teamId="team-1" section="session" />);
    await screen.findByRole("button", { name: "save" });

    expect(screen.getByText("sectionSessionTitle")).toBeInTheDocument();
    expect(screen.getByText("advanced")).toBeInTheDocument();
    expect(screen.queryByText("passwordRequirements")).not.toBeInTheDocument();
    expect(screen.queryByText("teamIpRestriction")).not.toBeInTheDocument();
  });

  it("renders every section under the default header when no section is given", async () => {
    mockApi();
    render(<TeamPolicySettings teamId="team-1" />);
    await screen.findByRole("button", { name: "save" });

    expect(screen.getByText("title")).toBeInTheDocument();
    for (const heading of ["passwordRequirements", "accessControl", "advanced", "passwordReusePrevention", "teamIpRestriction"]) {
      expect(screen.getByText(heading)).toBeInTheDocument();
    }
  });
});

