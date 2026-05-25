// @vitest-environment jsdom
/**
 * AutoExtensionConnect — Client Component test (jsdom)
 *
 * Post-C7 (SW-initiated handshake): the component drives a single helper
 * `requestExtensionConnect()` and reacts to its `{ ok, errorCode }` result.
 * It no longer does any bridge-code fetch itself — that logic lives in the
 * extension SW now.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

// ── Hoisted mocks ──────────────────────────────────────────
const {
  mockRequestExtensionConnect,
  mockReauthenticateWithPasskey,
  mockSignOut,
  mockCanUsePasskeyRecovery,
} = vi.hoisted(() => ({
  mockRequestExtensionConnect: vi.fn() as ReturnType<typeof vi.fn>,
  mockReauthenticateWithPasskey: vi.fn(),
  mockSignOut: vi.fn(),
  mockCanUsePasskeyRecovery: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));
vi.mock("next-auth/react", () => ({
  signOut: mockSignOut,
}));
vi.mock("@/lib/extension-connect-request", () => ({
  requestExtensionConnect: mockRequestExtensionConnect,
  EXTENSION_CONNECT_ERROR_CODE: {
    EXTENSION_ABSENT: "EXTENSION_ABSENT",
    SESSION_STEP_UP_REQUIRED: "SESSION_STEP_UP_REQUIRED",
    GENERIC_FAILURE: "GENERIC_FAILURE",
  },
}));
vi.mock("@/lib/auth/webauthn/passkey-reauth-client", () => ({
  reauthenticateWithPasskey: mockReauthenticateWithPasskey,
}));
vi.mock("@/lib/auth/webauthn/can-use-passkey-recovery", () => ({
  canUsePasskeyRecovery: mockCanUsePasskeyRecovery,
}));
vi.mock("@/lib/url-helpers", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  withBasePath: (path: string) => path,
}));

import { AutoExtensionConnect, isOverlayActive } from "./auto-extension-connect";

// ── Helpers ────────────────────────────────────────────────

let replaceStateSpy: ReturnType<typeof vi.spyOn>;
let originalLocation: Location;

function setSearchParams(search: string) {
  Object.defineProperty(window, "location", {
    value: {
      ...originalLocation,
      search,
      pathname: "/en/dashboard",
      hash: "",
    },
    writable: true,
    configurable: true,
  });
}

beforeEach(() => {
  originalLocation = window.location;
  replaceStateSpy = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
  mockRequestExtensionConnect.mockReset();
  mockReauthenticateWithPasskey.mockReset();
  mockSignOut.mockReset();
  mockCanUsePasskeyRecovery.mockReset();
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    value: originalLocation,
    writable: true,
    configurable: true,
  });
  replaceStateSpy.mockRestore();
});

describe("AutoExtensionConnect", () => {
  it("renders nothing when ext_connect param is absent", () => {
    setSearchParams("");
    const { container } = render(<AutoExtensionConnect />);
    expect(container.innerHTML).toBe("");
    expect(mockRequestExtensionConnect).not.toHaveBeenCalled();
  });

  it("removes ext_connect from URL when present", async () => {
    setSearchParams("?ext_connect=1");
    mockRequestExtensionConnect.mockResolvedValue({ ok: true });

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(replaceStateSpy).toHaveBeenCalledWith(null, "", "/en/dashboard");
    });
  });

  it("preserves other query params when removing ext_connect", async () => {
    setSearchParams("?ext_connect=1&foo=bar");
    mockRequestExtensionConnect.mockResolvedValue({ ok: true });

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(replaceStateSpy).toHaveBeenCalledWith(null, "", "/en/dashboard?foo=bar");
    });
  });

  it("calls requestExtensionConnect and shows CONNECTED on ok:true", async () => {
    setSearchParams("?ext_connect=1");
    mockRequestExtensionConnect.mockResolvedValue({ ok: true });

    render(<AutoExtensionConnect />);

    expect(screen.getByText("connecting")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("connectedTitle")).toBeInTheDocument();
    });
    expect(mockRequestExtensionConnect).toHaveBeenCalledTimes(1);
  });

  it("shows extension-required state when errorCode = EXTENSION_ABSENT", async () => {
    setSearchParams("?ext_connect=1");
    mockRequestExtensionConnect.mockResolvedValue({
      ok: false,
      errorCode: "EXTENSION_ABSENT",
    });

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(screen.getByText("extensionRequired")).toBeInTheDocument();
    });
    expect(screen.getByText("extensionRequiredAction")).toBeInTheDocument();
  });

  it("shows generic failure on errorCode = GENERIC_FAILURE", async () => {
    setSearchParams("?ext_connect=1");
    mockRequestExtensionConnect.mockResolvedValue({
      ok: false,
      errorCode: "GENERIC_FAILURE",
    });

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(screen.getByText("connectFailedTitle")).toBeInTheDocument();
    });
    expect(screen.getByText("connectFailedDescription")).toBeInTheDocument();
  });

  it("shows reauth guidance when SESSION_STEP_UP_REQUIRED + passkey-capable", async () => {
    setSearchParams("?ext_connect=1");
    mockRequestExtensionConnect.mockResolvedValue({
      ok: false,
      errorCode: "SESSION_STEP_UP_REQUIRED",
    });
    mockCanUsePasskeyRecovery.mockResolvedValue(true);

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(screen.getByText("connectReauthTitle")).toBeInTheDocument();
    });
    expect(screen.getByText("connectReauthDescription")).toBeInTheDocument();
  });

  it("reauthenticates and retries when retry is clicked from reauth-required state", async () => {
    setSearchParams("?ext_connect=1");
    mockRequestExtensionConnect
      .mockResolvedValueOnce({ ok: false, errorCode: "SESSION_STEP_UP_REQUIRED" })
      .mockResolvedValueOnce({ ok: true });
    mockCanUsePasskeyRecovery.mockResolvedValue(true);
    mockReauthenticateWithPasskey.mockResolvedValue({
      ok: true,
      verifiedAt: "2099-01-01T00:00:00Z",
    });

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(screen.getByText("connectReauthTitle")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("connectReauthAction"));

    await waitFor(() => {
      expect(mockReauthenticateWithPasskey).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByText("connectedTitle")).toBeInTheDocument();
    });
  });

  it("shows cancellation feedback when reauth is cancelled", async () => {
    setSearchParams("?ext_connect=1");
    mockRequestExtensionConnect.mockResolvedValue({
      ok: false,
      errorCode: "SESSION_STEP_UP_REQUIRED",
    });
    mockCanUsePasskeyRecovery.mockResolvedValue(true);
    mockReauthenticateWithPasskey.mockResolvedValue({
      ok: false,
      error: "AUTHENTICATION_CANCELLED",
    });

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(screen.getByText("connectReauthTitle")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("connectReauthAction"));

    await waitFor(() => {
      expect(screen.getByText("connectReauthCancelled")).toBeInTheDocument();
    });
  });

  it("redirects to sign-in when stale session for a non-passkey user", async () => {
    setSearchParams("?ext_connect=1");
    mockRequestExtensionConnect.mockResolvedValue({
      ok: false,
      errorCode: "SESSION_STEP_UP_REQUIRED",
    });
    mockCanUsePasskeyRecovery.mockResolvedValue(false);

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(screen.getByText("connectRecentSessionTitle")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("connectRecentSessionAction"));

    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalledTimes(1);
    });
  });

  it("retry button triggers a new connection attempt", async () => {
    setSearchParams("?ext_connect=1");
    mockRequestExtensionConnect
      .mockResolvedValueOnce({ ok: false, errorCode: "GENERIC_FAILURE" })
      .mockResolvedValueOnce({ ok: true });

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(screen.getByText("connectFailedTitle")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("retry"));

    await waitFor(() => {
      expect(screen.getByText("connectedTitle")).toBeInTheDocument();
    });
  });

  it("'Go to dashboard' button returns to IDLE (renders nothing)", async () => {
    setSearchParams("?ext_connect=1");
    mockRequestExtensionConnect.mockResolvedValue({ ok: true });

    const { container } = render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(screen.getByText("connectedTitle")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("goToDashboard"));

    expect(container.innerHTML).toBe("");
  });

  it("displays APP_NAME in branding section", async () => {
    setSearchParams("?ext_connect=1");
    mockRequestExtensionConnect.mockResolvedValue({ ok: true });

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(screen.getByText("connectedTitle")).toBeInTheDocument();
    });

    // APP_NAME defaults to "passwd-sso" (from NEXT_PUBLIC_APP_NAME env)
    expect(screen.getByText("passwd-sso")).toBeInTheDocument();
  });

  it("sets data-overlay-active on overlay div when CONNECTED", async () => {
    setSearchParams("?ext_connect=1");
    mockRequestExtensionConnect.mockResolvedValue({ ok: true });

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(screen.getByText("connectedTitle")).toBeInTheDocument();
    });

    expect(document.querySelector("[data-overlay-active]")).not.toBeNull();
  });

  it("sets data-overlay-active on overlay div when CONNECTING", async () => {
    setSearchParams("?ext_connect=1");
    mockRequestExtensionConnect.mockReturnValue(new Promise(() => {}));

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(screen.getByText("connecting")).toBeInTheDocument();
    });

    expect(document.querySelector("[data-overlay-active]")).not.toBeNull();
  });

  it("sets data-overlay-active on overlay div when FAILED", async () => {
    setSearchParams("?ext_connect=1");
    mockRequestExtensionConnect.mockResolvedValue({
      ok: false,
      errorCode: "GENERIC_FAILURE",
    });

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(screen.getByText("connectFailedTitle")).toBeInTheDocument();
    });

    expect(document.querySelector("[data-overlay-active]")).not.toBeNull();
  });

  it("does not have data-overlay-active when IDLE (no ext_connect)", () => {
    setSearchParams("");
    render(<AutoExtensionConnect />);

    expect(document.querySelector("[data-overlay-active]")).toBeNull();
  });
});

describe("keyboard shortcut guard with isOverlayActive", () => {
  it("suppresses shortcuts when data-overlay-active is in the DOM", () => {
    const shortcutFired = vi.fn();
    const handler = (e: KeyboardEvent) => {
      if (isOverlayActive()) return;
      if (e.key === "n") shortcutFired();
    };

    window.addEventListener("keydown", handler);

    const overlay = document.createElement("div");
    overlay.setAttribute("data-overlay-active", "");
    document.body.appendChild(overlay);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "n" }));
    expect(shortcutFired).not.toHaveBeenCalled();

    document.body.removeChild(overlay);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "n" }));
    expect(shortcutFired).toHaveBeenCalledTimes(1);

    window.removeEventListener("keydown", handler);
  });
});

describe("isOverlayActive", () => {
  it("returns true when data-overlay-active element exists", () => {
    const div = document.createElement("div");
    div.setAttribute("data-overlay-active", "");
    document.body.appendChild(div);

    expect(isOverlayActive()).toBe(true);

    document.body.removeChild(div);
  });

  it("returns false when no data-overlay-active element exists", () => {
    expect(isOverlayActive()).toBe(false);
  });
});
