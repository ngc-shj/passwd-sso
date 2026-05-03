// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const SENTINEL_NOT_A_SECRET_ZJYK = "SENTINEL_NOT_A_SECRET_ZJYK";

const {
  mockUseTravelMode,
  mockUseVault,
  mockComputeVerifier,
} = vi.hoisted(() => ({
  mockUseTravelMode: vi.fn(),
  mockUseVault: vi.fn(),
  mockComputeVerifier: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/hooks/use-travel-mode", () => ({
  useTravelMode: () => mockUseTravelMode(),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => mockUseVault(),
}));

vi.mock("@/lib/crypto/crypto-client", () => ({
  computePassphraseVerifier: (...args: unknown[]) =>
    mockComputeVerifier(...args),
}));

import { TravelModeCard } from "./travel-mode-card";

describe("TravelModeCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseVault.mockReturnValue({
      getAccountSalt: () => "salt-bytes",
    });
  });

  it("renders nothing while travel-mode hook is loading", () => {
    mockUseTravelMode.mockReturnValue({
      active: false,
      loading: true,
      enable: vi.fn(),
      disable: vi.fn(),
    });
    const { container } = render(<TravelModeCard />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the enable button when travel mode is inactive", () => {
    mockUseTravelMode.mockReturnValue({
      active: false,
      loading: false,
      enable: vi.fn(),
      disable: vi.fn(),
    });
    render(<TravelModeCard />);
    expect(
      screen.getByRole("button", { name: /^enable$/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("inactive")).toBeInTheDocument();
  });

  it("renders the disable button when travel mode is active", () => {
    mockUseTravelMode.mockReturnValue({
      active: true,
      loading: false,
      enable: vi.fn(),
      disable: vi.fn(),
    });
    render(<TravelModeCard />);
    expect(
      screen.getByRole("button", { name: /^disable$/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("Sec-2: passphrase entered into disable dialog is NOT echoed in error DOM after wrong-passphrase response", async () => {
    const disable = vi
      .fn()
      .mockResolvedValue({ success: false, error: "INVALID_PASSPHRASE" });
    mockUseTravelMode.mockReturnValue({
      active: true,
      loading: false,
      enable: vi.fn(),
      disable,
    });
    mockComputeVerifier.mockResolvedValue("verifier-hash");

    render(<TravelModeCard />);
    fireEvent.click(screen.getByRole("button", { name: /^disable$/ }));

    const input = screen.getByLabelText("passphrasePlaceholder");
    fireEvent.change(input, {
      target: { value: SENTINEL_NOT_A_SECRET_ZJYK },
    });

    // Click the dialog's disable submit (the second one)
    const disableBtns = screen.getAllByRole("button", { name: /^disable$/ });
    fireEvent.click(disableBtns[disableBtns.length - 1]);

    await waitFor(() => {
      expect(screen.getByText("passphraseIncorrect")).toBeInTheDocument();
    });
    // The passphrase plaintext must NOT have leaked into rendered DOM
    expect(
      screen.queryByText(new RegExp(SENTINEL_NOT_A_SECRET_ZJYK)),
    ).toBeNull();
  });
});
