// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { mockMatchMedia } from "@/__tests__/helpers/mock-match-media";

const { mockUseVault } = vi.hoisted(() => ({
  mockUseVault: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => mockUseVault(),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick }: React.ComponentProps<"button">) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

// The dialog has its own render tests; here we only observe whether it is open.
vi.mock("./recovery-key-dialog", () => ({
  RecoveryKeyDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="recovery-key-dialog" /> : null,
}));

import { RecoveryKeyBanner } from "./recovery-key-banner";
import { LOCAL_STORAGE_KEY, VAULT_STATUS } from "@/lib/constants";

const DISMISS_KEY = LOCAL_STORAGE_KEY.RECOVERY_KEY_BANNER_DISMISSED;

function vaultState(overrides: Record<string, unknown> = {}) {
  mockUseVault.mockReturnValue({
    status: VAULT_STATUS.UNLOCKED,
    hasRecoveryKey: false,
    recoveryKeyInvalidated: false,
    ...overrides,
  });
}

describe("RecoveryKeyBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMatchMedia();
    localStorage.clear();
  });

  it("prompts for a recovery key when the vault is unlocked without one", () => {
    vaultState();
    render(<RecoveryKeyBanner />);

    expect(screen.getByText("recoveryKeyBannerMessage")).toBeInTheDocument();
  });

  it("shows the invalidated message when the existing recovery key was invalidated", () => {
    vaultState({ recoveryKeyInvalidated: true });
    render(<RecoveryKeyBanner />);

    expect(screen.getByText("recoveryKeyBannerMessageInvalidated")).toBeInTheDocument();
    expect(screen.queryByText("recoveryKeyBannerMessage")).toBeNull();
  });

  it("renders nothing while the vault is locked", () => {
    vaultState({ status: VAULT_STATUS.LOCKED });
    const { container } = render(<RecoveryKeyBanner />);

    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when a recovery key already exists", () => {
    vaultState({ hasRecoveryKey: true });
    const { container } = render(<RecoveryKeyBanner />);

    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when dismissed within the last day", () => {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
    vaultState();
    const { container } = render(<RecoveryKeyBanner />);

    expect(container).toBeEmptyDOMElement();
  });

  it("opens the recovery key dialog from the banner action", () => {
    vaultState();
    render(<RecoveryKeyBanner />);
    expect(screen.queryByTestId("recovery-key-dialog")).toBeNull();

    fireEvent.click(screen.getByText("recoveryKeyBannerAction"));

    expect(screen.getByTestId("recovery-key-dialog")).toBeInTheDocument();
  });

  it("hides the banner and records the dismissal time when dismissed", () => {
    vi.useFakeTimers({ now: new Date("2026-02-16T12:00:00Z") });
    try {
      vaultState();
      render(<RecoveryKeyBanner />);

      fireEvent.click(screen.getByLabelText("recoveryKeyBannerDismiss"));

      expect(screen.queryByText("recoveryKeyBannerMessage")).toBeNull();
      expect(localStorage.getItem(DISMISS_KEY)).toBe(
        String(new Date("2026-02-16T12:00:00Z").getTime()),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("still hides the banner when storing the dismissal throws", () => {
    vaultState();
    render(<RecoveryKeyBanner />);
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    try {
      fireEvent.click(screen.getByLabelText("recoveryKeyBannerDismiss"));
    } finally {
      setItem.mockRestore();
    }

    expect(screen.queryByText("recoveryKeyBannerMessage")).toBeNull();
  });
});
