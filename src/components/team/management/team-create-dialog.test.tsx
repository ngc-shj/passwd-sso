// @vitest-environment jsdom
import { createHash } from "node:crypto";
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
import type { createTeamKeyEscrow } from "@/lib/crypto/crypto-team";

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
      createEscrowMock: vi.fn<typeof createTeamKeyEscrow>(async (_teamKey, memberJwk) => ({
        encryptedTeamKey: "ek",
        teamKeyIv: "iv",
        teamKeyAuthTag: "at",
        ephemeralPublicKey: "epk",
        hkdfSalt: "salt",
        keyVersion: 1,
        wrapVersion: 1,
        recipientKeyFingerprint: createHash("sha256").update(memberJwk, "utf8").digest("hex"),
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
  createTeamKeyEscrow: (...args: Parameters<typeof createTeamKeyEscrow>) =>
    createEscrowMock(...args),
}));

vi.mock("@/lib/ui/ime-guard", () => ({ preventIMESubmit: vi.fn() }));

// The real vault-lock-screen supplies resolveUnlockError and formatLockedUntil;
// only its navigation dependency is stubbed.
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  Link: "a",
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
import { VaultUnlockError } from "@/lib/vault/vault-context";
import { API_ERROR } from "@/lib/http/api-error-codes";

const ECDH_PUBLIC_KEY_JWK = '{"kty":"EC","crv":"P-256","x":"x-coord","y":"y-coord"}';

function setupVault(opts: {
  status: (typeof VAULT_STATUS)[keyof typeof VAULT_STATUS];
  userId?: string;
  ecdh?: string | null;
  unlock?: (p: string) => Promise<boolean>;
}) {
  mockUseVault.mockReturnValue({
    status: opts.status,
    userId: opts.userId ?? "user-1",
    unlock: opts.unlock ?? vi.fn(async () => true),
    getEcdhPublicKeyJwk: () => opts.ecdh ?? ECDH_PUBLIC_KEY_JWK,
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

  it("sends the fingerprint of the exact public key string it wrapped to", async () => {
    setupVault({ status: VAULT_STATUS.UNLOCKED });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: "team-uuid-1" }),
    });

    render(<TeamCreateDialog trigger={<button>Open</button>} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByText("Open"));
    fireEvent.change(await screen.findByLabelText("teamName"), { target: { value: "demo" } });
    await act(async () => {
      fireEvent.click(screen.getByText("createButton").closest("button")!);
    });

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.teamMemberKey.recipientKeyFingerprint).toBe(
      createHash("sha256").update(ECDH_PUBLIC_KEY_JWK, "utf8").digest("hex"),
    );
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
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "SLUG_ALREADY_TAKEN" }), { status: 409 }),
    );

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

  it.each([
    ["CONFLICT", "conflict"],
    ["TEAM_KEY_RECIPIENT_CHANGED", "createVaultChanged"],
    [undefined, "unknownError"],
  ])("shows a toast and leaves the slug field alone on a 409 with code %s", async (code, message) => {
    setupVault({ status: VAULT_STATUS.UNLOCKED });
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(code === undefined ? {} : { error: code }), { status: 409 }),
    );

    render(<TeamCreateDialog trigger={<button>Open</button>} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByText("Open"));
    const nameInput = await screen.findByLabelText("teamName");
    fireEvent.change(nameInput, { target: { value: "demo" } });
    const submit = screen.getByText("createButton").closest("button")!;
    await act(async () => {
      fireEvent.click(submit);
    });
    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith(message);
    });
    expect(screen.queryByText("slugTaken")).not.toBeInTheDocument();
  });

  function openDialog(onCreated: () => void = vi.fn()) {
    const utils = render(<TeamCreateDialog trigger={<button>Open</button>} onCreated={onCreated} />);
    fireEvent.click(screen.getByText("Open"));
    return utils;
  }

  async function fillName(value: string) {
    fireEvent.change(await screen.findByLabelText("teamName"), { target: { value } });
  }

  async function clickCreate() {
    const button = screen.getByText("createButton").closest("button");
    if (!button) throw new Error("create button not rendered");
    await act(async () => {
      fireEvent.click(button);
    });
  }

  function submitUnlock(passphrase: string) {
    fireEvent.change(screen.getByLabelText("passphrase"), { target: { value: passphrase } });
    const button = screen.getByText("unlock").closest("button");
    if (!button) throw new Error("unlock button not rendered");
    fireEvent.click(button);
  }

  function postedBody(): Record<string, unknown> {
    const init = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    if (typeof init?.body !== "string") throw new Error("no POST body sent");
    return JSON.parse(init.body) as Record<string, unknown>;
  }

  describe("inline unlock", () => {
    it("unlocks with the typed passphrase", async () => {
      const unlock = vi.fn(async () => true);
      setupVault({ status: VAULT_STATUS.LOCKED, unlock });
      openDialog();

      submitUnlock("correct horse");

      await waitFor(() => expect(unlock).toHaveBeenCalledWith("correct horse"));
      expect(screen.queryByText("wrongPassphrase")).not.toBeInTheDocument();
    });

    it("shows the wrong-passphrase error inline and clears the input when unlock returns false", async () => {
      setupVault({ status: VAULT_STATUS.LOCKED, unlock: vi.fn(async () => false) });
      openDialog();

      submitUnlock("wrong");

      expect(await screen.findByText("wrongPassphrase")).toBeInTheDocument();
      expect(screen.getByLabelText("passphrase")).toHaveValue("");
    });

    it("clears the inline error when the passphrase is edited", async () => {
      setupVault({ status: VAULT_STATUS.LOCKED, unlock: vi.fn(async () => false) });
      openDialog();
      submitUnlock("wrong");
      await screen.findByText("wrongPassphrase");

      fireEvent.change(screen.getByLabelText("passphrase"), { target: { value: "x" } });

      expect(screen.queryByText("wrongPassphrase")).not.toBeInTheDocument();
    });

    it.each([
      [API_ERROR.ACCOUNT_LOCKED, "accountLocked"],
      [API_ERROR.RATE_LIMIT_EXCEEDED, "rateLimited"],
      [API_ERROR.SERVICE_UNAVAILABLE, "retryLater"],
      ["SOMETHING_ELSE", "unlockError"],
    ])("renders a %s unlock error inline as %s and clears the passphrase", async (code, message) => {
      setupVault({
        status: VAULT_STATUS.LOCKED,
        unlock: vi.fn(async () => {
          throw new VaultUnlockError(code);
        }),
      });
      openDialog();

      submitUnlock("pass");

      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(screen.getByLabelText("passphrase")).toHaveValue("");
      expect(mockToast.error).not.toHaveBeenCalled();
    });

    it("renders the generic unlock error inline for a non-VaultUnlockError failure", async () => {
      setupVault({
        status: VAULT_STATUS.LOCKED,
        unlock: vi.fn(async () => {
          throw new Error("network");
        }),
      });
      openDialog();

      submitUnlock("pass");

      expect(await screen.findByText("unlockError")).toBeInTheDocument();
    });

    it("closes the dialog with a session-expired toast on UNAUTHORIZED", async () => {
      setupVault({
        status: VAULT_STATUS.LOCKED,
        unlock: vi.fn(async () => {
          throw new VaultUnlockError(API_ERROR.UNAUTHORIZED);
        }),
      });
      openDialog();

      submitUnlock("pass");

      await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("sessionExpired"));
      expect(screen.queryByLabelText("passphrase")).not.toBeInTheDocument();
    });

    it("reopens with an empty form after an UNAUTHORIZED unlock closed it", async () => {
      setupVault({ status: VAULT_STATUS.UNLOCKED });
      // A fresh element per render: an identical one would let React skip the re-read of useVault.
      const element = () => <TeamCreateDialog trigger={<button>Open</button>} onCreated={vi.fn()} />;
      const { rerender } = render(element());
      fireEvent.click(screen.getByText("Open"));
      await fillName("Draft Team");

      setupVault({
        status: VAULT_STATUS.LOCKED,
        unlock: vi.fn(async () => {
          throw new VaultUnlockError(API_ERROR.UNAUTHORIZED);
        }),
      });
      rerender(element());
      submitUnlock("pass");
      await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("sessionExpired"));

      setupVault({ status: VAULT_STATUS.UNLOCKED });
      rerender(element());
      fireEvent.click(screen.getByText("Open"));

      expect(await screen.findByLabelText("teamName")).toHaveValue("");
      expect(screen.getByLabelText("slug")).toHaveValue("");
    });

    it("reopens with an empty passphrase after an UNAUTHORIZED unlock closed it", async () => {
      setupVault({
        status: VAULT_STATUS.LOCKED,
        unlock: vi.fn(async () => {
          throw new VaultUnlockError(API_ERROR.UNAUTHORIZED);
        }),
      });
      openDialog();
      submitUnlock("pass");
      await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("sessionExpired"));

      fireEvent.click(screen.getByText("Open"));

      expect(await screen.findByLabelText("passphrase")).toHaveValue("");
    });
  });

  describe("create", () => {
    it("posts the trimmed fields, toasts, closes and calls onCreated on success", async () => {
      setupVault({ status: VAULT_STATUS.UNLOCKED });
      const onCreated = vi.fn();
      openDialog(onCreated);
      await fillName("  Demo Team ");
      fireEvent.change(screen.getByLabelText("description"), { target: { value: "  about us " } });

      await clickCreate();

      await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
      expect(mockFetch).toHaveBeenCalledWith("/api/teams", expect.objectContaining({ method: "POST" }));
      expect(postedBody()).toMatchObject({
        id: "team-uuid-1",
        name: "Demo Team",
        slug: "demo-team",
        description: "about us",
      });
      expect(mockToast.success).toHaveBeenCalledWith("created");
      expect(screen.queryByLabelText("teamName")).not.toBeInTheDocument();
    });

    it("omits an empty description from the request", async () => {
      setupVault({ status: VAULT_STATUS.UNLOCKED });
      openDialog();
      await fillName("demo");

      await clickCreate();

      await waitFor(() => expect(mockFetch).toHaveBeenCalled());
      expect(postedBody()).not.toHaveProperty("description");
      expect(postedBody()).toHaveProperty("slug", "demo");
    });

    it("normalizes a typed slug to lowercase letters, digits and hyphens", async () => {
      setupVault({ status: VAULT_STATUS.UNLOCKED });
      openDialog();
      await fillName("demo");

      fireEvent.change(screen.getByLabelText("slug"), { target: { value: "My_Slug-9!" } });

      expect(screen.getByLabelText("slug")).toHaveValue("myslug-9");
    });

    it("refuses a one-character slug without sending a request", async () => {
      setupVault({ status: VAULT_STATUS.UNLOCKED });
      openDialog();
      await fillName("a");

      await clickCreate();

      expect(screen.getByText("slugTooShort")).toBeInTheDocument();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("refuses a slug that ends with a hyphen without sending a request", async () => {
      setupVault({ status: VAULT_STATUS.UNLOCKED });
      openDialog();
      await fillName("demo");
      fireEvent.change(screen.getByLabelText("slug"), { target: { value: "demo-" } });

      await clickCreate();

      expect(screen.getByText("slugInvalidFormat")).toBeInTheDocument();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("refuses a slug longer than the maximum without sending a request", async () => {
      setupVault({ status: VAULT_STATUS.UNLOCKED });
      openDialog();
      await fillName("demo");
      fireEvent.change(screen.getByLabelText("slug"), { target: { value: "a".repeat(51) } });

      await clickCreate();

      expect(screen.getByText("slugTooLong")).toBeInTheDocument();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("clears the slug error when the slug is edited", async () => {
      setupVault({ status: VAULT_STATUS.UNLOCKED });
      openDialog();
      await fillName("a");
      await clickCreate();
      expect(screen.getByText("slugTooShort")).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText("slug"), { target: { value: "ab" } });

      expect(screen.queryByText("slugTooShort")).not.toBeInTheDocument();
    });

    it("marks the slug field on a 400 that names the slug", async () => {
      setupVault({ status: VAULT_STATUS.UNLOCKED });
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "VALIDATION_ERROR", details: { properties: { slug: { errors: ["bad"] } } } }),
          { status: 400 },
        ),
      );
      openDialog();
      await fillName("demo");

      await clickCreate();

      expect(await screen.findByText("slugInvalidFormat")).toBeInTheDocument();
      expect(mockToast.error).not.toHaveBeenCalled();
    });

    it("toasts a validation error on a 400 that does not name the slug", async () => {
      setupVault({ status: VAULT_STATUS.UNLOCKED });
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "VALIDATION_ERROR" }), { status: 400 }),
      );
      openDialog();
      await fillName("demo");

      await clickCreate();

      await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("validationError"));
      expect(screen.queryByText("slugInvalidFormat")).not.toBeInTheDocument();
    });

    it("toasts createFailed and keeps the form on a 500", async () => {
      setupVault({ status: VAULT_STATUS.UNLOCKED });
      const onCreated = vi.fn();
      mockFetch.mockResolvedValueOnce(new Response("{}", { status: 500 }));
      openDialog(onCreated);
      await fillName("demo");

      await clickCreate();

      await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("createFailed"));
      expect(onCreated).not.toHaveBeenCalled();
      expect(screen.getByLabelText("teamName")).toHaveValue("demo");
      expect(screen.getByText("createButton").closest("button")).not.toBeDisabled();
    });

    it("toasts createFailed without a request when the ECDH public key is unavailable", async () => {
      mockUseVault.mockReturnValue({
        status: VAULT_STATUS.UNLOCKED,
        userId: "user-1",
        unlock: vi.fn(async () => true),
        getEcdhPublicKeyJwk: () => null,
      });
      openDialog();
      await fillName("demo");

      await clickCreate();

      await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("createFailed"));
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("clears the form when the dialog is closed and reopened", async () => {
      setupVault({ status: VAULT_STATUS.UNLOCKED });
      openDialog();
      await fillName("demo");

      fireEvent.keyDown(screen.getByLabelText("teamName"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByLabelText("teamName")).not.toBeInTheDocument());
      fireEvent.click(screen.getByText("Open"));

      expect(await screen.findByLabelText("teamName")).toHaveValue("");
    });
  });
});
