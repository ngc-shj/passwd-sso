// @vitest-environment jsdom
/**
 * AutoExtensionConnect — Client Component test (jsdom)
 *
 * C15-v2 (click-driven flow): when `?ext_connect=1` is on the URL, the
 * component renders an AWAITING_CLICK confirmation card. `connect()` only
 * runs when the user clicks the Allow button — never from useEffect. The
 * click satisfies `navigator.userActivation.isActive`, which the extension
 * content-script then verifies as the unforgeable XSS gate.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
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

/**
 * Render the component, wait for the AWAITING_CLICK prompt, then click the
 * Allow button. Use this in any test that asserts on post-click state.
 */
async function renderAndClickAllow() {
  render(<AutoExtensionConnect />);
  const button = await screen.findByRole("button", {
    name: "awaitingClickAction",
  });
  const user = userEvent.setup();
  await user.click(button);
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

  it("?ext_connect=1 shows AWAITING_CLICK prompt with no postMessage yet", async () => {
    setSearchParams("?ext_connect=1");
    render(<AutoExtensionConnect />);
    expect(
      await screen.findByText("awaitingClickTitle"),
    ).toBeInTheDocument();
    expect(screen.getByText("awaitingClickDescription")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "awaitingClickAction" }),
    ).toBeInTheDocument();
    expect(mockRequestExtensionConnect).not.toHaveBeenCalled();
  });

  it("does NOT call requestExtensionConnect on mount (click is the only trigger)", async () => {
    // RT4 negative test: closes the "test the gate but not the door" pattern.
    setSearchParams("?ext_connect=1");
    render(<AutoExtensionConnect />);
    // Flush microtasks + a tick to defeat any deferred auto-fire.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(mockRequestExtensionConnect).not.toHaveBeenCalled();
    expect(screen.getByText("awaitingClickTitle")).toBeInTheDocument();
  });

  it("keeps ?ext_connect=1 in URL while AWAITING_CLICK (reload re-prompts)", async () => {
    setSearchParams("?ext_connect=1");
    render(<AutoExtensionConnect />);
    await screen.findByText("awaitingClickTitle");
    expect(replaceStateSpy).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?ext_connect=1");
  });

  it("removes ?ext_connect=1 only after the user clicks Allow", async () => {
    setSearchParams("?ext_connect=1");
    mockRequestExtensionConnect.mockResolvedValue({ ok: true });
    await renderAndClickAllow();
    await waitFor(() => {
      expect(replaceStateSpy).toHaveBeenCalledWith(null, "", "/en/dashboard");
    });
  });

  it("S3: re-rendering with ?ext_connect=1 retained shows the prompt again", async () => {
    setSearchParams("?ext_connect=1");
    const { unmount } = render(<AutoExtensionConnect />);
    await screen.findByText("awaitingClickTitle");
    unmount();
    // Re-mount simulates page reload while URL still has the param.
    render(<AutoExtensionConnect />);
    expect(
      await screen.findByText("awaitingClickTitle"),
    ).toBeInTheDocument();
    expect(mockRequestExtensionConnect).not.toHaveBeenCalled();
  });

  it("preserves other query params when removing ext_connect after click", async () => {
    setSearchParams("?ext_connect=1&foo=bar");
    mockRequestExtensionConnect.mockResolvedValue({ ok: true });
    await renderAndClickAllow();
    await waitFor(() => {
      expect(replaceStateSpy).toHaveBeenCalledWith(null, "", "/en/dashboard?foo=bar");
    });
  });

  it("calls requestExtensionConnect and shows CONNECTED on ok:true (post-click)", async () => {
    setSearchParams("?ext_connect=1");
    mockRequestExtensionConnect.mockResolvedValue({ ok: true });
    await renderAndClickAllow();
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
    await renderAndClickAllow();
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
    await renderAndClickAllow();
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
    await renderAndClickAllow();
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
    await renderAndClickAllow();
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
    await renderAndClickAllow();
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
    await renderAndClickAllow();
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
    await renderAndClickAllow();
    await waitFor(() => {
      expect(screen.getByText("connectFailedTitle")).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(screen.getByText("retry"));
    await waitFor(() => {
      expect(screen.getByText("connectedTitle")).toBeInTheDocument();
    });
  });

  it("'Go to dashboard' button (from CONNECTED) returns to IDLE", async () => {
    setSearchParams("?ext_connect=1");
    mockRequestExtensionConnect.mockResolvedValue({ ok: true });
    const { container } = render(<AutoExtensionConnect />);
    const allowButton = await screen.findByRole("button", {
      name: "awaitingClickAction",
    });
    const user = userEvent.setup();
    await user.click(allowButton);
    await waitFor(() => {
      expect(screen.getByText("connectedTitle")).toBeInTheDocument();
    });
    await user.click(screen.getByText("goToDashboard"));
    expect(container.innerHTML).toBe("");
  });

  it("displays APP_NAME in branding section (AWAITING_CLICK + post-click)", async () => {
    setSearchParams("?ext_connect=1");
    render(<AutoExtensionConnect />);
    await screen.findByText("awaitingClickTitle");
    // APP_NAME defaults to "passwd-sso" (from NEXT_PUBLIC_APP_NAME env)
    expect(screen.getByText("passwd-sso")).toBeInTheDocument();
  });

  it("sets data-overlay-active on overlay div in AWAITING_CLICK", async () => {
    setSearchParams("?ext_connect=1");
    render(<AutoExtensionConnect />);
    await screen.findByText("awaitingClickTitle");
    expect(document.querySelector("[data-overlay-active]")).not.toBeNull();
  });

  it("sets data-overlay-active on overlay div when CONNECTED", async () => {
    setSearchParams("?ext_connect=1");
    mockRequestExtensionConnect.mockResolvedValue({ ok: true });
    await renderAndClickAllow();
    await waitFor(() => {
      expect(screen.getByText("connectedTitle")).toBeInTheDocument();
    });
    expect(document.querySelector("[data-overlay-active]")).not.toBeNull();
  });

  it("sets data-overlay-active on overlay div when CONNECTING", async () => {
    setSearchParams("?ext_connect=1");
    mockRequestExtensionConnect.mockReturnValue(new Promise(() => {}));
    await renderAndClickAllow();
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
    await renderAndClickAllow();
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

  it("Allow button has data-c15-action attribute (stable selector for manual tests)", async () => {
    setSearchParams("?ext_connect=1");
    render(<AutoExtensionConnect />);
    const button = await screen.findByRole("button", {
      name: "awaitingClickAction",
    });
    expect(button.getAttribute("data-c15-action")).toBe("allow-connect");
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
