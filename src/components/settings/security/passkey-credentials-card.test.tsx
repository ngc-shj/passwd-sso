// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

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
} = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  mockUseVault: vi.fn(),
  mockStartReg: vi.fn(),
  mockStartAuth: vi.fn(),
  mockWrap: vi.fn(),
  mockIsSupported: vi.fn(() => true),
  mockGenerateNickname: vi.fn(() => "auto-name"),
  capturedSecretKey: { value: null as Uint8Array | null },
  capturedPrfOutput: { value: null as Uint8Array | null },
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
  generateDefaultNickname: (...args: unknown[]) =>
    mockGenerateNickname(...args),
}));

import { PasskeyCredentialsCard } from "./passkey-credentials-card";

function makeSentinelSecretKey(): Uint8Array {
  return new Uint8Array(32).fill(0xcd);
}

function makeSentinelPrfOutput(): Uint8Array {
  return new Uint8Array(32).fill(SENTINEL_BYTE);
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
  });

  it("disables register button when vault is locked (R26 disabled cue)", async () => {
    setupCredentialsList([]);
    mockUseVault.mockReturnValue({
      status: "locked",
      getSecretKey: () => null,
    });
    render(<PasskeyCredentialsCard />);
    await waitFor(() => {
      expect(screen.getByText("noPasskeys")).toBeInTheDocument();
    });
    const reg = screen.getByRole("button", { name: /register/ });
    expect(reg).toBeDisabled();
    expect(screen.getByText("vaultMustBeUnlocked")).toBeInTheDocument();
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
        return Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({ error: "BAD_REQUEST" }),
        });
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
});
