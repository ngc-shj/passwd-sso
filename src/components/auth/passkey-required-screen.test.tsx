// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { useEffect } from "react";

const {
  mockUpdate,
  mockSignOut,
  mockHardNavigate,
  mockSetMounted,
  flagAtCardMount,
} = vi.hoisted(() => ({
  mockUpdate: vi.fn(),
  mockSignOut: vi.fn(),
  mockHardNavigate: vi.fn(),
  mockSetMounted: vi.fn(),
  flagAtCardMount: { calls: [] as unknown[][] },
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({ update: mockUpdate }),
  signOut: mockSignOut,
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/url-helpers", () => ({
  currentAppPath: () => "/ja/dashboard/settings/auth/passkey?from=1",
  hardNavigate: mockHardNavigate,
  setPasskeyRequiredScreenMounted: mockSetMounted,
  withBasePath: (p: string) => p,
}));

// The card is stubbed: it records what the mounted flag looked like when its
// own mount effect ran (its list fetch fires from that effect) and exposes the
// onRegistered prop through a button.
vi.mock("@/components/settings/security/passkey-credentials-card", () => ({
  PasskeyCredentialsCard: ({ onRegistered }: { onRegistered?: () => Promise<void> }) => {
    useEffect(() => {
      flagAtCardMount.calls = mockSetMounted.mock.calls.map((c) => [...c]);
    }, []);
    return (
      <button type="button" onClick={() => void onRegistered?.()}>
        stub-register
      </button>
    );
  },
}));

import { PasskeyRequiredScreen } from "./passkey-required-screen";

describe("PasskeyRequiredScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flagAtCardMount.calls = [];
  });

  it("sets the screen-mounted flag before the card's mount effects, and clears it on unmount", () => {
    const { unmount } = render(<PasskeyRequiredScreen />);

    expect(flagAtCardMount.calls).toEqual([[true]]);
    expect(mockSetMounted).toHaveBeenLastCalledWith(true);

    unmount();
    expect(mockSetMounted).toHaveBeenLastCalledWith(false);
  });

  it("renders the title, the registration card and sign-out", () => {
    render(<PasskeyRequiredScreen />);

    expect(screen.getByRole("heading", { name: "passkeyRequiredTitle" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "stub-register" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /signOut/ })).toBeInTheDocument();
  });

  it("onRegistered awaits the session update before reloading the current path", async () => {
    let resolveUpdate: () => void = () => {};
    mockUpdate.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveUpdate = resolve;
      }),
    );
    render(<PasskeyRequiredScreen />);

    fireEvent.click(screen.getByRole("button", { name: "stub-register" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockHardNavigate).not.toHaveBeenCalled();

    await act(async () => {
      resolveUpdate();
      await Promise.resolve();
    });
    expect(mockHardNavigate).toHaveBeenCalledWith("/ja/dashboard/settings/auth/passkey?from=1");
  });
});
