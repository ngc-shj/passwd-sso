// @vitest-environment jsdom
/**
 * AutoExtensionConnect — Client Component test (jsdom)
 *
 * Covers:
 *   - No ?ext_connect → renders nothing (IDLE)
 *   - ?ext_connect=1 → initiates connection, removes param from URL
 *   - Fetch success → CONNECTED state, "Go to dashboard" button
 *   - Fetch failure → FAILED state, "Retry" + "Go to dashboard" buttons
 *   - Retry triggers new connection attempt
 *   - APP_NAME is displayed
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

// ── Hoisted mocks ──────────────────────────────────────────
const { mockInjectBridgeCode, mockReauthenticateWithPasskey, mockSignOut, mockRequestExtensionJkt } = vi.hoisted(() => ({
  mockInjectBridgeCode: vi.fn(),
  mockReauthenticateWithPasskey: vi.fn(),
  mockSignOut: vi.fn(),
  // Resolves to a valid 43-char jkt by default so existing tests are unaffected.
  mockRequestExtensionJkt: vi.fn().mockResolvedValue("A".repeat(43)) as ReturnType<typeof vi.fn>,
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));
vi.mock("next-auth/react", () => ({
  signOut: mockSignOut,
}));
vi.mock("@/lib/inject-extension-bridge-code", () => ({
  injectExtensionBridgeCode: mockInjectBridgeCode,
}));
vi.mock("@/lib/extension-jkt-request", () => ({
  requestExtensionJkt: mockRequestExtensionJkt,
}));
vi.mock("@/lib/auth/webauthn/passkey-reauth-client", () => ({
  reauthenticateWithPasskey: mockReauthenticateWithPasskey,
}));
vi.mock("@/lib/url-helpers", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withBasePath: (path: string) => path,
}));

import { AutoExtensionConnect, isOverlayActive } from "./auto-extension-connect";

// ── Helpers ────────────────────────────────────────────────

let replaceStateSpy: ReturnType<typeof vi.spyOn>;
let fetchSpy: ReturnType<typeof vi.spyOn>;
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
  fetchSpy = vi.spyOn(globalThis, "fetch");
  mockReauthenticateWithPasskey.mockReset();
  mockSignOut.mockReset();
  // Default: extension is present and responds with a valid jkt.
  mockRequestExtensionJkt.mockResolvedValue("A".repeat(43));
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    value: originalLocation,
    writable: true,
    configurable: true,
  });
  replaceStateSpy.mockRestore();
  fetchSpy.mockRestore();
});

describe("AutoExtensionConnect", () => {
  it("renders nothing when ext_connect param is absent", () => {
    setSearchParams("");

    const { container } = render(<AutoExtensionConnect />);

    expect(container.innerHTML).toBe("");
  });

  it("removes ext_connect from URL when present", async () => {
    setSearchParams("?ext_connect=1");
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ code: "a".repeat(64), expiresAt: "2099-01-01T00:00:00Z" }), { status: 200 }),
    );

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(replaceStateSpy).toHaveBeenCalledWith(null, "", "/en/dashboard");
    });
  });

  it("preserves other query params when removing ext_connect", async () => {
    setSearchParams("?ext_connect=1&foo=bar");
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ code: "a".repeat(64), expiresAt: "2099-01-01T00:00:00Z" }), { status: 200 }),
    );

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(replaceStateSpy).toHaveBeenCalledWith(null, "", "/en/dashboard?foo=bar");
    });
  });

  it("shows connecting state, then connected on fetch success", async () => {
    setSearchParams("?ext_connect=1");
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ code: "b".repeat(64), expiresAt: "2099-01-01T00:00:00Z" }),
        { status: 200 },
      ),
    );

    render(<AutoExtensionConnect />);

    // Initially in connecting state
    expect(screen.getByText("connecting")).toBeInTheDocument();

    // After fetch resolves → connected
    await waitFor(() => {
      expect(screen.getByText("connectedTitle")).toBeInTheDocument();
    });
    expect(screen.getByText("connectedDescription")).toBeInTheDocument();
    expect(mockInjectBridgeCode).toHaveBeenCalledWith("b".repeat(64), expect.any(Number));
  });

  it("shows failed state on fetch error", async () => {
    setSearchParams("?ext_connect=1");
    fetchSpy.mockRejectedValue(new Error("network error"));

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(screen.getByText("connectFailedTitle")).toBeInTheDocument();
    });
    expect(screen.getByText("connectFailedDescription")).toBeInTheDocument();
  });

  it("shows failed state on non-ok response", async () => {
    setSearchParams("?ext_connect=1");
    fetchSpy.mockResolvedValue(new Response(null, { status: 500 }));

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(screen.getByText("connectFailedTitle")).toBeInTheDocument();
    });
  });

  it("shows reauth guidance when bridge-code returns SESSION_STEP_UP_REQUIRED", async () => {
    setSearchParams("?ext_connect=1");
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "SESSION_STEP_UP_REQUIRED" }),
          { status: 403 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ canPasskeySignIn: true }), { status: 200 }),
      );

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(screen.getByText("connectReauthTitle")).toBeInTheDocument();
    });
    expect(screen.getByText("connectReauthDescription")).toBeInTheDocument();
  });

  it("reauthenticates and retries when retry is clicked from reauth-required state", async () => {
    setSearchParams("?ext_connect=1");
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "SESSION_STEP_UP_REQUIRED" }),
          { status: 403 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ canPasskeySignIn: true }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: "d".repeat(64), expiresAt: "2099-01-01T00:00:00Z" }),
          { status: 200 },
        ),
      );
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
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "SESSION_STEP_UP_REQUIRED" }),
          { status: 403 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ canPasskeySignIn: true }), { status: 200 }),
      );
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

  it("redirects to sign-in when stale session is returned for a non-passkey user", async () => {
    setSearchParams("?ext_connect=1");
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "SESSION_STEP_UP_REQUIRED" }),
          { status: 403 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ canPasskeySignIn: false }), { status: 200 }),
      );

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
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 500 }));

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(screen.getByText("connectFailedTitle")).toBeInTheDocument();
    });

    // Now retry with success
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: "c".repeat(64), expiresAt: "2099-01-01T00:00:00Z" }), { status: 200 }),
    );

    const user = userEvent.setup();
    await user.click(screen.getByText("retry"));

    await waitFor(() => {
      expect(screen.getByText("connectedTitle")).toBeInTheDocument();
    });
  });

  it("'Go to dashboard' button returns to IDLE (renders nothing)", async () => {
    setSearchParams("?ext_connect=1");
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ code: "a".repeat(64), expiresAt: "2099-01-01T00:00:00Z" }), { status: 200 }),
    );

    const { container } = render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(screen.getByText("connectedTitle")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("goToDashboard"));

    // Back to IDLE → renders nothing
    expect(container.innerHTML).toBe("");
  });

  it("displays APP_NAME in branding section", async () => {
    setSearchParams("?ext_connect=1");
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ code: "a".repeat(64), expiresAt: "2099-01-01T00:00:00Z" }), { status: 200 }),
    );

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(screen.getByText("connectedTitle")).toBeInTheDocument();
    });

    // APP_NAME defaults to "passwd-sso" (from NEXT_PUBLIC_APP_NAME env)
    expect(screen.getByText("passwd-sso")).toBeInTheDocument();
  });

  it("sets data-overlay-active on overlay div when CONNECTED", async () => {
    setSearchParams("?ext_connect=1");
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ code: "a".repeat(64), expiresAt: "2099-01-01T00:00:00Z" }), { status: 200 }),
    );

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(screen.getByText("connectedTitle")).toBeInTheDocument();
    });

    expect(document.querySelector("[data-overlay-active]")).not.toBeNull();
  });

  it("sets data-overlay-active on overlay div when CONNECTING", async () => {
    setSearchParams("?ext_connect=1");
    // Never resolve fetch to stay in CONNECTING state
    fetchSpy.mockReturnValue(new Promise(() => {}));

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(screen.getByText("connecting")).toBeInTheDocument();
    });

    expect(document.querySelector("[data-overlay-active]")).not.toBeNull();
  });

  it("sets data-overlay-active on overlay div when FAILED", async () => {
    setSearchParams("?ext_connect=1");
    fetchSpy.mockResolvedValue(new Response("", { status: 500 }));

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

  // ── DPoP handshake (C9) ────────────────────────────────────────────────────

  it("posts bridge-code request with cnfJkt body when stage-1 jkt resolves", async () => {
    setSearchParams("?ext_connect=1");
    const jkt = "B".repeat(43);
    mockRequestExtensionJkt.mockResolvedValueOnce(jkt);
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ code: "a".repeat(64), expiresAt: "2099-01-01T00:00:00Z" }),
        { status: 200 },
      ),
    );

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(screen.getByText("connectedTitle")).toBeInTheDocument();
    });

    // The bridge-code fetch MUST include the jkt in the request body.
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/extension/bridge-code"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ cnfJkt: jkt }),
      }),
    );
  });

  it("shows extensionRequired message and does not call fetch when stage-1 returns null", async () => {
    setSearchParams("?ext_connect=1");
    mockRequestExtensionJkt.mockResolvedValueOnce(null);

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      // The i18n mock returns the translation key itself.
      expect(screen.getByText("extensionRequired")).toBeInTheDocument();
    });

    // No bridge-code fetch should have been attempted.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows extensionRequiredAction link when stage-1 returns null", async () => {
    setSearchParams("?ext_connect=1");
    mockRequestExtensionJkt.mockResolvedValueOnce(null);

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(screen.getByText("extensionRequiredAction")).toBeInTheDocument();
    });
  });
});

describe("keyboard shortcut guard with isOverlayActive", () => {
  it("suppresses shortcuts when data-overlay-active is in the DOM", () => {
    // Simulate the guard pattern used in password-dashboard.tsx
    const shortcutFired = vi.fn();
    const handler = (e: KeyboardEvent) => {
      if (isOverlayActive()) return;
      if (e.key === "n") shortcutFired();
    };

    window.addEventListener("keydown", handler);

    // With overlay active — shortcut should NOT fire
    const overlay = document.createElement("div");
    overlay.setAttribute("data-overlay-active", "");
    document.body.appendChild(overlay);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "n" }));
    expect(shortcutFired).not.toHaveBeenCalled();

    // After overlay removed — shortcut should fire (F3: resume)
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
