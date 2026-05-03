// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import React from "react";
import { VAULT_STATUS } from "@/lib/constants";

const SENTINEL_TEAMKEY_BYTE = 0xcd;

const { mockFetch, mockToast, mockUseVault, generateTeamKeyMock, createEscrowMock, lastTeamKeySnapshot } =
  vi.hoisted(() => {
    const lastTeamKey: { ref: Uint8Array | null } = { ref: null };
    return {
      mockFetch: vi.fn(),
      mockToast: { error: vi.fn(), success: vi.fn() },
      mockUseVault: vi.fn(),
      generateTeamKeyMock: vi.fn(() => {
        const buf = new Uint8Array(32).fill(0xcd);
        lastTeamKey.ref = buf;
        return buf;
      }),
      createEscrowMock: vi.fn(async () => ({
        encryptedTeamKey: "ek",
        teamKeyIv: "iv",
        teamKeyAuthTag: "at",
        ephemeralPublicKey: "epk",
        hkdfSalt: "salt",
        keyVersion: 1,
        wrapVersion: 1,
      })),
      lastTeamKeySnapshot: lastTeamKey,
    };
  });

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => mockUseVault(),
  VaultUnlockError: class VaultUnlockError extends Error {
    code: string;
    lockedUntil?: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));

vi.mock("@/lib/crypto/crypto-team", () => ({
  generateTeamSymmetricKey: () => generateTeamKeyMock(),
  createTeamKeyEscrow: (...args: unknown[]) => createEscrowMock(...args),
}));

vi.mock("@/lib/ui/ime-guard", () => ({ preventIMESubmit: vi.fn() }));

vi.mock("@/components/vault/vault-lock-screen", () => ({
  formatLockedUntil: () => "lockedUntil",
}));

// crypto.randomUUID may not exist in older jsdom; ensure deterministic
const originalCrypto = globalThis.crypto;
if (!originalCrypto?.randomUUID) {
  Object.defineProperty(globalThis, "crypto", {
    value: { ...originalCrypto, randomUUID: () => "team-uuid-1" },
    configurable: true,
  });
} else {
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
    "team-uuid-1" as `${string}-${string}-${string}-${string}-${string}`,
  );
}

import { TeamCreateDialog } from "./team-create-dialog";

function setupVault(opts: {
  status: (typeof VAULT_STATUS)[keyof typeof VAULT_STATUS];
  userId?: string;
  ecdh?: Record<string, unknown> | null;
  unlock?: (p: string) => Promise<boolean>;
}) {
  mockUseVault.mockReturnValue({
    status: opts.status,
    userId: opts.userId ?? "user-1",
    unlock: opts.unlock ?? vi.fn(async () => true),
    getEcdhPublicKeyJwk: () => opts.ecdh ?? { kty: "EC" },
  });
}

describe("TeamCreateDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
    lastTeamKeySnapshot.ref = null;
  });

  it("shows loader when vault is loading", () => {
    setupVault({ status: VAULT_STATUS.LOADING });
    render(<TeamCreateDialog trigger={<button>Open</button>} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByText("Open"));
    // Loader2 element has animate-spin
    expect(document.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("shows setup-required message when vault is SETUP_REQUIRED", () => {
    setupVault({ status: VAULT_STATUS.SETUP_REQUIRED });
    render(<TeamCreateDialog trigger={<button>Open</button>} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByText("Open"));
    expect(screen.getByText("setupDescription")).toBeInTheDocument();
  });

  it("shows unlock form when vault locked", () => {
    setupVault({ status: VAULT_STATUS.LOCKED });
    render(<TeamCreateDialog trigger={<button>Open</button>} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByText("Open"));
    expect(screen.getByLabelText("passphrase")).toBeInTheDocument();
  });

  it("auto-generates slug from team name", async () => {
    setupVault({ status: VAULT_STATUS.UNLOCKED });
    render(<TeamCreateDialog trigger={<button>Open</button>} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByText("Open"));

    const nameInput = await screen.findByLabelText("teamName");
    fireEvent.change(nameInput, { target: { value: "My Team Name!" } });

    const slugInput = screen.getByLabelText("slug") as HTMLInputElement;
    expect(slugInput.value).toBe("my-team-name");
  });

  it("disables create button when name/slug empty", async () => {
    setupVault({ status: VAULT_STATUS.UNLOCKED });
    render(<TeamCreateDialog trigger={<button>Open</button>} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByText("Open"));
    const btn = await screen.findByText("createButton");
    expect(btn.closest("button")).toBeDisabled();
  });

  // §Sec-1: assert teamKey.fill(0) runs in finally for create-team flow
  it("zeroes teamKey bytes after escrow (sentinel 0xCD -> all zero)", async () => {
    setupVault({ status: VAULT_STATUS.UNLOCKED });
    const onCreated = vi.fn();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: "team-uuid-1" }),
    });

    render(<TeamCreateDialog trigger={<button>Open</button>} onCreated={onCreated} />);
    fireEvent.click(screen.getByText("Open"));

    const nameInput = await screen.findByLabelText("teamName");
    fireEvent.change(nameInput, { target: { value: "demo" } });

    const submit = screen.getByText("createButton").closest("button")!;
    await act(async () => {
      fireEvent.click(submit);
    });

    await waitFor(() => {
      expect(createEscrowMock).toHaveBeenCalled();
    });

    // The teamKey buffer should be zeroized after the finally block ran.
    const buf = lastTeamKeySnapshot.ref;
    expect(buf).not.toBeNull();
    expect(buf!.every((b) => b === 0)).toBe(true);
  });

  // §Sec-1: zeroization MUST occur even on createTeamKeyEscrow failure
  it("zeroes teamKey bytes when escrow fails (finally invariant)", async () => {
    setupVault({ status: VAULT_STATUS.UNLOCKED });
    createEscrowMock.mockRejectedValueOnce(new Error("escrow failed"));

    render(<TeamCreateDialog trigger={<button>Open</button>} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByText("Open"));

    const nameInput = await screen.findByLabelText("teamName");
    fireEvent.change(nameInput, { target: { value: "demo" } });
    const submit = screen.getByText("createButton").closest("button")!;
    await act(async () => {
      fireEvent.click(submit);
    });

    await waitFor(() => {
      expect(createEscrowMock).toHaveBeenCalled();
    });

    const buf = lastTeamKeySnapshot.ref;
    expect(buf).not.toBeNull();
    // Even when escrow throws, finally must zero the buffer
    expect(buf!.every((b) => b === SENTINEL_TEAMKEY_BYTE)).toBe(false);
    expect(buf!.every((b) => b === 0)).toBe(true);
    expect(mockToast.error).toHaveBeenCalled();
  });

  it("shows slug-taken error when 409 returned", async () => {
    setupVault({ status: VAULT_STATUS.UNLOCKED });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: () => Promise.resolve({}),
    });

    render(<TeamCreateDialog trigger={<button>Open</button>} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByText("Open"));
    const nameInput = await screen.findByLabelText("teamName");
    fireEvent.change(nameInput, { target: { value: "demo" } });
    const submit = screen.getByText("createButton").closest("button")!;
    await act(async () => {
      fireEvent.click(submit);
    });
    await waitFor(() => {
      expect(screen.getByText("slugTaken")).toBeInTheDocument();
    });
  });
});
