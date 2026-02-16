// @vitest-environment jsdom
/**
 * AutoExtensionConnect — Client Component test (jsdom)
 *
 * Covers:
 *   - No ?ext_connect → renders nothing (IDLE)
 *   - ?ext_connect=1 → initiates connection, removes param from URL
 *   - Fetch success → CONNECTED state, "Close tab" + "Go to dashboard" buttons
 *   - Fetch failure → FAILED state, "Retry" + "Go to dashboard" buttons
 *   - Retry triggers new connection attempt
 *   - APP_NAME is displayed
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

// ── Hoisted mocks ──────────────────────────────────────────
const { mockInjectToken } = vi.hoisted(() => ({
  mockInjectToken: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/lib/inject-extension-token", () => ({
  injectExtensionToken: mockInjectToken,
}));

import { AutoExtensionConnect } from "./auto-extension-connect";

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
      new Response(JSON.stringify({ token: "t", expiresAt: "2099-01-01T00:00:00Z" }), { status: 200 }),
    );

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(replaceStateSpy).toHaveBeenCalledWith(null, "", "/en/dashboard");
    });
  });

  it("preserves other query params when removing ext_connect", async () => {
    setSearchParams("?ext_connect=1&foo=bar");
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ token: "t", expiresAt: "2099-01-01T00:00:00Z" }), { status: 200 }),
    );

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(replaceStateSpy).toHaveBeenCalledWith(null, "", "/en/dashboard?foo=bar");
    });
  });

  it("shows connecting state, then connected on fetch success", async () => {
    setSearchParams("?ext_connect=1");
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ token: "tok123", expiresAt: "2099-01-01T00:00:00Z" }), { status: 200 }),
    );

    render(<AutoExtensionConnect />);

    // Initially in connecting state
    expect(screen.getByText("connecting")).toBeInTheDocument();

    // After fetch resolves → connected
    await waitFor(() => {
      expect(screen.getByText("connectedTitle")).toBeInTheDocument();
    });
    expect(screen.getByText("connectedDescription")).toBeInTheDocument();
    expect(mockInjectToken).toHaveBeenCalledWith("tok123", expect.any(Number));
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

  it("retry button triggers a new connection attempt", async () => {
    setSearchParams("?ext_connect=1");
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 500 }));

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(screen.getByText("connectFailedTitle")).toBeInTheDocument();
    });

    // Now retry with success
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ token: "t2", expiresAt: "2099-01-01T00:00:00Z" }), { status: 200 }),
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
      new Response(JSON.stringify({ token: "t", expiresAt: "2099-01-01T00:00:00Z" }), { status: 200 }),
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
      new Response(JSON.stringify({ token: "t", expiresAt: "2099-01-01T00:00:00Z" }), { status: 200 }),
    );

    render(<AutoExtensionConnect />);

    await waitFor(() => {
      expect(screen.getByText("connectedTitle")).toBeInTheDocument();
    });

    // APP_NAME defaults to "passwd-sso" (from NEXT_PUBLIC_APP_NAME env)
    expect(screen.getByText("passwd-sso")).toBeInTheDocument();
  });
});
