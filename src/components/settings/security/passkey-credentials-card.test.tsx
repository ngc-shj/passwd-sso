// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { generateDefaultNickname } from "@/lib/auth/webauthn/webauthn-client";

const SENTINEL_BYTE = 0xab;

const {
  mockFetch,
  mockToast,
  mockUseVault,
  mockStartReg,
  mockStartAuth,
  mockWrap,
  mockIsSupported,
  mockGenerateNickname,
  capturedSecretKey,
  capturedPrfOutput,
  mockCanUsePasskeyRecovery,
  mockReauthenticateWithPasskey,
} = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  mockUseVault: vi.fn(),
  mockStartReg: vi.fn(),
  mockStartAuth: vi.fn(),
  mockWrap: vi.fn(),
  mockIsSupported: vi.fn(() => true),
  mockGenerateNickname: vi.fn<typeof generateDefaultNickname>(() => "auto-name"),
  capturedSecretKey: { value: null as Uint8Array | null },
  capturedPrfOutput: { value: null as Uint8Array | null },
  mockCanUsePasskeyRecovery: vi.fn(),
  mockReauthenticateWithPasskey: vi.fn(),
}));

// One stable translator, as next-intl returns: a new function per render would
// re-create the card's list fetch callback and re-fetch on every re-render.
const { mockT } = vi.hoisted(() => ({
  mockT: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));
vi.mock("next-intl", () => ({
  useTranslations: () => mockT,
  useLocale: () => "en",
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

vi.mock("@/lib/format/format-datetime", () => ({
  formatDateTime: (d: string) => d,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => mockUseVault(),
}));

vi.mock("@/lib/auth/webauthn/webauthn-client", () => ({
  isWebAuthnSupported: () => mockIsSupported(),
  startPasskeyRegistration: (...args: unknown[]) => mockStartReg(...args),
  startPasskeyAuthentication: (...args: unknown[]) => mockStartAuth(...args),
  wrapSecretKeyWithPrf: (
    secretKey: Uint8Array,
    prfOutput: Uint8Array,
  ) => {
    // Capture the references so the test can later verify zeroization
    capturedSecretKey.value = secretKey;
    capturedPrfOutput.value = prfOutput;
    return mockWrap(secretKey, prfOutput);
  },
  generateDefaultNickname: (...args: Parameters<typeof generateDefaultNickname>) =>
    mockGenerateNickname(...args),
}));

import "@/__tests__/helpers/passkey-reauth-mocks";

vi.mock("@/lib/auth/webauthn/can-use-passkey-recovery", () => ({
  canUsePasskeyRecovery: mockCanUsePasskeyRecovery,
}));

vi.mock("@/lib/auth/webauthn/passkey-reauth-client", () => ({
  reauthenticateWithPasskey: mockReauthenticateWithPasskey,
}));

import { PasskeyCredentialsCard } from "./passkey-credentials-card";

function makeSentinelSecretKey(): Uint8Array {
  return new Uint8Array(32).fill(0xcd);
}

function makeSentinelPrfOutput(): Uint8Array {
  return new Uint8Array(32).fill(SENTINEL_BYTE);
}

function listCalls(): number {
  return mockFetch.mock.calls.filter(
    ([url, init]: unknown[]) =>
      String(url).includes("/api/webauthn/credentials") &&
      ((init as RequestInit | undefined)?.method ?? "GET") === "GET",
  ).length;
}

function setupCredentialsList(creds: unknown[]) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const u = String(url);
    // GET list endpoint
    if (
      u.includes("/api/webauthn/credentials") &&
      (!init || init.method === undefined || init.method === "GET")
    ) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(creds),
      });
    }
    // GET auth provider
    if (u.includes("auth-provider")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ canPasskeySignIn: true }),
      });
    }
    // POST options
    if (u.includes("/register/options") && init?.method === "POST") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ options: { foo: "bar" }, prfSalt: "salt" }),
      });
    }
    // POST verify
    if (u.includes("/register/verify") && init?.method === "POST") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            id: "new-cred",
            discoverable: true,
            deviceType: "multiDevice",
            backedUp: true,
          }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
  });
}

describe("PasskeyCredentialsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedSecretKey.value = null;
    capturedPrfOutput.value = null;
    mockUseVault.mockReturnValue({
      status: "unlocked",
      getSecretKey: () => makeSentinelSecretKey(),
    });
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
    mockReauthenticateWithPasskey.mockResolvedValue({ ok: true });
  });

  // A passkey-blocked user registers from a minimal screen with the vault
  // locked, so the button stays enabled and only the PRF wrap is skipped.
  it("registers while the vault is locked, without attempting the PRF wrap", async () => {
    setupCredentialsList([]);
    const getSecretKey = vi.fn(() => makeSentinelSecretKey());
    mockUseVault.mockReturnValue({ status: "locked", getSecretKey });
    const prfOutput = makeSentinelPrfOutput();
    mockStartReg.mockResolvedValue({
      responseJSON: { id: "cred-1", response: { transports: ["internal"] } },
      prfOutput,
    });

    render(<PasskeyCredentialsCard />);
    await waitFor(() => {
      expect(screen.getByText("noPasskeys")).toBeInTheDocument();
    });
    expect(screen.getByText("registerLockedPrfHint")).toBeInTheDocument();
    const reg = screen.getByRole("button", { name: /register/ });
    expect(reg).toBeEnabled();

    fireEvent.click(reg);
    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith("registerSuccess");
    });

    expect(getSecretKey).not.toHaveBeenCalled();
    expect(capturedSecretKey.value).toBeNull();
    const verifyCall = mockFetch.mock.calls.find((args: unknown[]) =>
      String(args[0]).includes("/register/verify"),
    );
    const verifyBody = JSON.parse(String((verifyCall?.[1] as RequestInit).body));
    expect(verifyBody).not.toHaveProperty("prfEncryptedSecretKey");
    // The PRF output the ceremony produced is still zeroized.
    expect(prfOutput.every((b) => b === 0)).toBe(true);
  });

  it("renders the no-passkeys empty state", async () => {
    setupCredentialsList([]);
    render(<PasskeyCredentialsCard />);
    await waitFor(() => {
      expect(screen.getByText("noPasskeys")).toBeInTheDocument();
    });
  });

  it("renders the webauthn-not-supported message when API is unavailable", async () => {
    setupCredentialsList([]);
    mockIsSupported.mockReturnValueOnce(false);
    render(<PasskeyCredentialsCard />);
    await waitFor(() => {
      expect(screen.getByText("webauthnNotSupported")).toBeInTheDocument();
    });
  });

  it("Sec-7(a)+(d) success path: secretKey AND prfOutput are zeroized after wrap completes", async () => {
    setupCredentialsList([]);
    mockStartReg.mockResolvedValue({
      responseJSON: { id: "cred-1", response: { transports: ["internal"] } },
      prfOutput: makeSentinelPrfOutput(),
    });
    mockWrap.mockResolvedValue({
      ciphertext: "cipher",
      iv: "iv",
      authTag: "tag",
    });

    render(<PasskeyCredentialsCard />);
    await waitFor(() => {
      expect(screen.getByText("noPasskeys")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /register/ }));

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith("registerSuccess");
    });

    // After completion, the captured arrays should be zeroized.
    expect(capturedSecretKey.value).not.toBeNull();
    expect(capturedSecretKey.value!.every((b) => b === 0)).toBe(true);
    expect(capturedPrfOutput.value).not.toBeNull();
    expect(capturedPrfOutput.value!.every((b) => b === 0)).toBe(true);
  });

  it("registers with an auto-generated nickname and shows the post-registration hint", async () => {
    setupCredentialsList([]);
    mockStartReg.mockResolvedValue({
      responseJSON: { id: "cred-1", response: { transports: ["internal"] } },
      prfOutput: null,
    });

    render(<PasskeyCredentialsCard />);
    await waitFor(() => {
      expect(screen.getByText("noPasskeys")).toBeInTheDocument();
    });

    expect(screen.getByText("registerHint")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /register/ }));

    await waitFor(() => {
      expect(mockGenerateNickname).toHaveBeenCalledWith(["internal"]);
    });

    const verifyCall = mockFetch.mock.calls.find(
      (args: unknown[]) =>
        String(args[0]).includes("/register/verify") &&
        (args[1] as RequestInit | undefined)?.method === "POST",
    );

    expect(verifyCall).toBeTruthy();
    const verifyBody = JSON.parse(String(verifyCall?.[1]?.body));
    expect(verifyBody).toMatchObject({ nickname: "auto-name" });
    // No-PRF path: PRF-wrapped fields must be absent (otherwise the server
    // would attempt to register a PRF wrapping that the client never derived).
    expect(verifyBody).not.toHaveProperty("prfEncryptedSecretKey");
    expect(verifyBody).not.toHaveProperty("prfSecretKeyIv");
    expect(verifyBody).not.toHaveProperty("prfSecretKeyAuthTag");
  });

  it("Sec-7(b) wrap-throws path: finally still zeroizes secretKey AND prfOutput", async () => {
    setupCredentialsList([]);
    mockStartReg.mockResolvedValue({
      responseJSON: { id: "cred-1", response: { transports: ["internal"] } },
      prfOutput: makeSentinelPrfOutput(),
    });
    mockWrap.mockRejectedValue(new Error("wrap failed"));

    render(<PasskeyCredentialsCard />);
    await waitFor(() => {
      expect(screen.getByText("noPasskeys")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /register/ }));

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("registerError");
    });
    // The finally MUST have zeroized both arrays
    expect(capturedSecretKey.value).not.toBeNull();
    expect(capturedSecretKey.value!.every((b) => b === 0)).toBe(true);
    expect(capturedPrfOutput.value).not.toBeNull();
    expect(capturedPrfOutput.value!.every((b) => b === 0)).toBe(true);
  });

  it("Sec-7(c) verify-rejects path: shows error and does NOT leave PRF data leaking via toast.success", async () => {
    setupCredentialsList([]);
    mockStartReg.mockResolvedValue({
      responseJSON: { id: "cred-1", response: { transports: ["internal"] } },
      prfOutput: makeSentinelPrfOutput(),
    });
    mockWrap.mockResolvedValue({
      ciphertext: "cipher",
      iv: "iv",
      authTag: "tag",
    });
    // Override fetch to fail verify
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (
        u.includes("/api/webauthn/credentials") &&
        (!init || init.method === undefined)
      ) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([]),
        });
      }
      if (u.includes("auth-provider")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ canPasskeySignIn: true }),
        });
      }
      if (u.includes("/register/options")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({ options: {}, prfSalt: "salt" }),
        });
      }
      if (u.includes("/register/verify")) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "BAD_REQUEST" }), { status: 400 }),
        );
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });
    });

    render(<PasskeyCredentialsCard />);
    await waitFor(() => {
      expect(screen.getByText("noPasskeys")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /register/ }));

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("registerError");
    });
    // success path zeroizes; the verify failure happens AFTER wrap completes
    // so secretKey + prfOutput are already zeroized by the in-line cleanup.
    expect(capturedSecretKey.value!.every((b) => b === 0)).toBe(true);
    expect(capturedPrfOutput.value!.every((b) => b === 0)).toBe(true);
  });

  it("Sec-7(d) catch CREDENTIAL_ALREADY_REGISTERED path: shows error toast", async () => {
    setupCredentialsList([]);
    mockStartReg.mockRejectedValue(new Error("CREDENTIAL_ALREADY_REGISTERED"));

    render(<PasskeyCredentialsCard />);
    await waitFor(() => {
      expect(screen.getByText("noPasskeys")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /register/ }));

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("alreadyRegistered");
    });
    // Reg threw before any key material was set; nothing leaked.
    expect(capturedSecretKey.value).toBeNull();
    expect(capturedPrfOutput.value).toBeNull();
  });

  it("Sec-7(d) catch REGISTRATION_PENDING path: shows pending warning", async () => {
    setupCredentialsList([]);
    mockStartReg.mockRejectedValue(new Error("REGISTRATION_PENDING"));

    render(<PasskeyCredentialsCard />);
    await waitFor(() => {
      expect(screen.getByText("noPasskeys")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /register/ }));

    await waitFor(() => {
      expect(mockToast.warning).toHaveBeenCalledWith("requestPending");
    });
  });

  // RT8: a stale-session credential delete must surface the reauth recovery
  // path, not the generic deleteError toast, and must NOT report success.
  it("opens the recent-session dialog on a SESSION_STEP_UP_REQUIRED delete (RT8)", async () => {
    const cred = {
      id: "cred-del",
      credentialId: "cid-del",
      nickname: "My Key",
      deviceType: "multiDevice",
      backedUp: true,
      discoverable: true,
      minPinLength: null,
      largeBlobSupported: null,
      transports: ["internal"],
      prfSupported: false,
      prfWrappingPresent: false,
      registeredDevice: null,
      lastUsedDevice: null,
      createdAt: "2026-05-04",
      lastUsedAt: null,
    };
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/webauthn/credentials") && (init?.method ?? "GET") === "GET") {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([cred]) });
      }
      if (u.includes("auth-provider")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ canPasskeySignIn: true }),
        });
      }
      if (init?.method === "DELETE") {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    });

    render(<PasskeyCredentialsCard />);
    await waitFor(() => {
      expect(screen.getByText("My Key")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "delete" }));
    const confirmBtn = await screen.findByRole("button", { name: "confirm" });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(screen.getByTestId("recent-session-dialog")).toBeInTheDocument();
    });
    expect(mockToast.success).not.toHaveBeenCalledWith("deleteSuccess");
    expect(mockToast.error).not.toHaveBeenCalled();
  });
  it("calls onRegistered instead of refreshing the list when given", async () => {
    setupCredentialsList([]);
    mockStartReg.mockResolvedValue({
      responseJSON: { id: "cred-1", response: { transports: ["internal"] } },
      prfOutput: null,
    });
    const onRegistered = vi.fn(async () => {});

    render(<PasskeyCredentialsCard onRegistered={onRegistered} />);
    await waitFor(() => {
      expect(screen.getByText("noPasskeys")).toBeInTheDocument();
    });
    const listCallsBefore = listCalls();

    fireEvent.click(screen.getByRole("button", { name: /register/ }));
    await waitFor(() => {
      expect(onRegistered).toHaveBeenCalledTimes(1);
    });
    expect(listCalls()).toBe(listCallsBefore);
  });

  it("refreshes the list and calls nothing else when onRegistered is absent", async () => {
    setupCredentialsList([]);
    mockStartReg.mockResolvedValue({
      responseJSON: { id: "cred-1", response: { transports: ["internal"] } },
      prfOutput: null,
    });

    render(<PasskeyCredentialsCard />);
    await waitFor(() => {
      expect(screen.getByText("noPasskeys")).toBeInTheDocument();
    });
    const listCallsBefore = listCalls();

    fireEvent.click(screen.getByRole("button", { name: /register/ }));
    await waitFor(() => {
      expect(listCalls()).toBe(listCallsBefore + 1);
    });
  });

  // Registration is step-up-gated while the passkey requirement blocks the
  // session (D5): a stale sign-in must open the reauth path, not registerError.
  it.each([
    ["options", "/register/options"],
    ["verify", "/register/verify"],
  ])(
    "opens the recent-session dialog on a SESSION_STEP_UP_REQUIRED %s call",
    async (_label, gatedPath) => {
      setupCredentialsList([]);
      const base = mockFetch.getMockImplementation()!;
      mockFetch.mockImplementation((url: string, init?: RequestInit) =>
        String(url).includes(gatedPath)
          ? Promise.resolve(
              new Response(JSON.stringify({ error: "SESSION_STEP_UP_REQUIRED" }), {
                status: 403,
              }),
            )
          : base(url, init),
      );
      mockStartReg.mockResolvedValue({
        responseJSON: { id: "cred-1", response: { transports: ["internal"] } },
        prfOutput: null,
      });

      render(<PasskeyCredentialsCard />);
      await waitFor(() => {
        expect(screen.getByText("noPasskeys")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole("button", { name: /register/ }));

      expect(await screen.findByTestId("recent-session-dialog")).toBeInTheDocument();
      expect(mockToast.error).not.toHaveBeenCalled();
      expect(mockToast.success).not.toHaveBeenCalled();
    },
  );

  it("replays the registration after a passkey reauth on a step-up refusal", async () => {
    setupCredentialsList([]);
    const base = mockFetch.getMockImplementation()!;
    let optionsCalls = 0;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes("/register/options")) {
        optionsCalls += 1;
        if (optionsCalls === 1) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: "SESSION_STEP_UP_REQUIRED" }), {
              status: 403,
            }),
          );
        }
      }
      return base(url, init);
    });
    mockCanUsePasskeyRecovery.mockResolvedValue(true);
    mockStartReg.mockResolvedValue({
      responseJSON: { id: "cred-1", response: { transports: ["internal"] } },
      prfOutput: null,
    });

    render(<PasskeyCredentialsCard />);
    await waitFor(() => {
      expect(screen.getByText("noPasskeys")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /register/ }));
    fireEvent.click(await screen.findByTestId("passkey-reauth-action"));

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith("registerSuccess");
    });
    expect(optionsCalls).toBe(2);
  });

  // A credential registered while the vault was locked holds no wrap; once the
  // vault is unlocked the card offers to set up auto-unlock for it (T23).
  it("offers PRF re-bootstrap for a PRF-capable credential with no wrap once unlocked", async () => {
    const cred = {
      id: "cred-nowrap",
      credentialId: "cid-nowrap",
      nickname: "Locked-time Key",
      deviceType: "multiDevice",
      backedUp: true,
      discoverable: true,
      minPinLength: null,
      largeBlobSupported: null,
      transports: ["internal"],
      prfSupported: true,
      prfWrappingPresent: false,
      registeredDevice: null,
      lastUsedDevice: null,
      createdAt: "2026-05-04",
      lastUsedAt: null,
    };
    setupCredentialsList([cred]);

    render(<PasskeyCredentialsCard />);
    const offer = await screen.findByRole("button", { name: /rebootstrapButton/ });
    expect(offer).toBeEnabled();
    expect(offer).toHaveAttribute("title", "rebootstrapHint");
  });
});
