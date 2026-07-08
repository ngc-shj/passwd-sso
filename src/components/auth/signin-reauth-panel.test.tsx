// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockSignOut, mockReauthenticateWithPasskey, mockAssign } = vi.hoisted(
  () => ({
    mockSignOut: vi.fn(),
    mockReauthenticateWithPasskey: vi.fn(),
    mockAssign: vi.fn(),
  }),
);

vi.mock("next-auth/react", () => ({
  signOut: mockSignOut,
}));

vi.mock("next-intl", () => ({
  useLocale: () => "ja",
}));

vi.mock("@/lib/url-helpers", () => ({
  withBasePath: (p: string) => `/passwd-sso${p}`,
}));

vi.mock("@/lib/auth/webauthn/passkey-reauth-client", () => ({
  reauthenticateWithPasskey: mockReauthenticateWithPasskey,
}));

import { SignInReauthPanel } from "./signin-reauth-panel";

const LABELS = {
  title: "reauthPanelTitle",
  description: "reauthPanelDescription",
  passkeyAction: "reauthAction",
  passkeyFailed: "reauthFailed",
  passkeyCancelled: "reauthCancelled",
  signInAgainAction: "recentSessionAction",
};

const CALLBACK = "/passwd-sso/api/mcp/authorize?x=1";

function renderPanel(
  overrides: Partial<{ callbackHref: string; canUsePasskey: boolean }> = {},
) {
  return render(
    <SignInReauthPanel
      callbackHref={overrides.callbackHref ?? CALLBACK}
      canUsePasskey={overrides.canUsePasskey ?? true}
      labels={LABELS}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // window.location.assign is not writable in jsdom; replace the whole object.
  Object.defineProperty(window, "location", {
    value: { assign: mockAssign },
    writable: true,
  });
});

describe("SignInReauthPanel", () => {
  it("never fires signOut or navigation on mount (I9)", () => {
    renderPanel();

    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockAssign).not.toHaveBeenCalled();
    expect(mockReauthenticateWithPasskey).not.toHaveBeenCalled();
  });

  it("always renders the sign-in-again action, even on the passkey branch (I6 no-dead-end)", () => {
    renderPanel({ canUsePasskey: true });

    expect(
      screen.getByRole("button", { name: "recentSessionAction" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "reauthAction" }),
    ).toBeInTheDocument();
  });

  it("hides the passkey action when canUsePasskey is false", () => {
    renderPanel({ canUsePasskey: false });

    expect(
      screen.queryByRole("button", { name: "reauthAction" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "recentSessionAction" }),
    ).toBeInTheDocument();
  });

  it("signs out with the nested signin callbackUrl on the sign-in-again click", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "recentSessionAction" }));

    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalledWith({
        callbackUrl: `/passwd-sso/ja/auth/signin?callbackUrl=${encodeURIComponent(CALLBACK)}`,
      });
    });
  });

  it("navigates to the callback after a successful passkey ceremony", async () => {
    mockReauthenticateWithPasskey.mockResolvedValue({
      ok: true,
      verifiedAt: "2026-07-09T00:00:00Z",
    });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "reauthAction" }));

    await waitFor(() => {
      expect(mockAssign).toHaveBeenCalledWith(CALLBACK);
    });
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("shows the failure label and keeps sign-in-again available on ceremony failure", async () => {
    mockReauthenticateWithPasskey.mockResolvedValue({
      ok: false,
      error: "PASSKEY_REAUTH_FAILED",
    });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "reauthAction" }));

    await waitFor(() => {
      expect(screen.getByText("reauthFailed")).toBeInTheDocument();
    });
    expect(mockAssign).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "recentSessionAction" }),
    ).toBeEnabled();
  });

  it("re-enables recovery when the ceremony rejects at the network level (no stranded panel)", async () => {
    mockReauthenticateWithPasskey.mockRejectedValue(new Error("network down"));
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "reauthAction" }));

    await waitFor(() => {
      expect(screen.getByText("reauthFailed")).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: "reauthAction" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "recentSessionAction" }),
    ).toBeEnabled();
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it("refuses a backslash protocol-relative callbackHref (browsers normalize \\ to /)", () => {
    renderPanel({ callbackHref: "/\\evil.example/phish" });

    expect(
      screen.queryByRole("button", { name: "reauthAction" }),
    ).not.toBeInTheDocument();
  });

  it("shows the cancelled label when the user aborts the ceremony", async () => {
    mockReauthenticateWithPasskey.mockResolvedValue({
      ok: false,
      error: "AUTHENTICATION_CANCELLED",
    });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "reauthAction" }));

    await waitFor(() => {
      expect(screen.getByText("reauthCancelled")).toBeInTheDocument();
    });
  });

  it("refuses a protocol-relative callbackHref: no passkey action, no navigation (S1)", async () => {
    renderPanel({ callbackHref: "//evil.example/phish" });

    // The passkey action is withheld entirely (no safe navigation target)...
    expect(
      screen.queryByRole("button", { name: "reauthAction" }),
    ).not.toBeInTheDocument();

    // ...and sign-in-again omits the nested callbackUrl rather than smuggling it.
    fireEvent.click(screen.getByRole("button", { name: "recentSessionAction" }));
    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalledWith({
        callbackUrl: "/passwd-sso/ja/auth/signin",
      });
    });
    expect(mockAssign).not.toHaveBeenCalled();
  });
});
