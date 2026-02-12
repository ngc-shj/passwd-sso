/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const mockSendMessage = vi.fn();
const mockGetSettings = vi.fn();
const mockEnsureHostPermission = vi.fn();

vi.mock("../../lib/messaging", () => ({
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
}));
vi.mock("../../lib/storage", () => ({
  getSettings: () => mockGetSettings(),
}));
vi.mock("../../lib/api", () => ({
  ensureHostPermission: (...args: unknown[]) => mockEnsureHostPermission(...args),
}));

import { VaultUnlock } from "../../popup/components/VaultUnlock";

describe("VaultUnlock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockResolvedValue({ serverUrl: "https://example.com" });
    mockEnsureHostPermission.mockResolvedValue(true);
  });

  it("does not submit when passphrase is empty", async () => {
    render(<VaultUnlock onUnlocked={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));
    await waitFor(() => {
      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  it("shows error when permission denied", async () => {
    mockEnsureHostPermission.mockResolvedValue(false);
    render(<VaultUnlock onUnlocked={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("Passphrase"), {
      target: { value: "pw" },
    });
    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));

    expect(await screen.findByText(/permission denied/i)).toBeInTheDocument();
  });

  it("calls onUnlocked on success", async () => {
    mockSendMessage.mockResolvedValue({ type: "UNLOCK_VAULT", ok: true });
    const onUnlocked = vi.fn();
    render(<VaultUnlock onUnlocked={onUnlocked} />);

    fireEvent.change(screen.getByPlaceholderText("Passphrase"), {
      target: { value: "pw" },
    });
    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));

    await waitFor(() => {
      expect(onUnlocked).toHaveBeenCalled();
    });
  });

  it("shows error on invalid passphrase", async () => {
    mockSendMessage.mockResolvedValue({
      type: "UNLOCK_VAULT",
      ok: false,
      error: "INVALID_PASSPHRASE",
    });
    render(<VaultUnlock onUnlocked={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("Passphrase"), {
      target: { value: "pw" },
    });
    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));

    expect(await screen.findByText(/invalid_passphrase/i)).toBeInTheDocument();
  });
});
