/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, screen, fireEvent, act } from "@testing-library/react";

const mockSendMessage = vi.fn();
const mockMatchList = vi.fn((_props: unknown) => null);
const mockVaultUnlock = vi.fn((_props: unknown) => null);
const mockLoginPrompt = vi.fn((_props: unknown) => null);

const mockOpenOptionsPage = vi.fn();

vi.mock("../../lib/messaging", () => ({
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
}));
vi.mock("../../popup/components/MatchList", () => ({
  MatchList: (props: unknown) => {
    mockMatchList(props);
    return null;
  },
}));
vi.mock("../../popup/components/VaultUnlock", () => ({
  VaultUnlock: (props: unknown) => {
    mockVaultUnlock(props);
    return null;
  },
}));
vi.mock("../../popup/components/LoginPrompt", () => ({
  LoginPrompt: (props: unknown) => {
    mockLoginPrompt(props);
    return null;
  },
}));

import { App } from "../../popup/App";

describe("App tab URL handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const chromeMock = {
      tabs: {
        query: vi.fn(),
      },
      runtime: {
        openOptionsPage: mockOpenOptionsPage,
      },
      storage: {
        onChanged: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
    };
    vi.stubGlobal("chrome", chromeMock);
  });

  it("passes null tabUrl to MatchList when tabs query fails", async () => {
    const chromeMock = (globalThis as unknown as { chrome: { tabs: { query: ReturnType<typeof vi.fn> } } }).chrome;
    chromeMock.tabs.query.mockRejectedValueOnce(new Error("no tabs"));
    mockSendMessage.mockResolvedValueOnce({
      type: "GET_STATUS",
      hasToken: true,
      vaultUnlocked: true,
      expiresAt: Date.now() + 1000,
    });

    render(<App />);

    await waitFor(() => {
      expect(mockMatchList).toHaveBeenCalled();
    });

    const props = (mockMatchList.mock.calls as unknown[][])[0]?.[0] as
      | { tabUrl?: string | null }
      | undefined;
    expect(props?.tabUrl ?? null).toBeNull();
  });

  it("opens options page from header button", async () => {
    const chromeMock = (globalThis as unknown as { chrome: { tabs: { query: ReturnType<typeof vi.fn> }; runtime: { openOptionsPage: ReturnType<typeof vi.fn> } } }).chrome;
    chromeMock.tabs.query.mockResolvedValueOnce([{ url: "https://example.com" }]);
    mockSendMessage.mockResolvedValueOnce({
      type: "GET_STATUS",
      hasToken: false,
      vaultUnlocked: false,
      expiresAt: null,
    });

    render(<App />);

    const button = await screen.findByTitle("Settings");
    fireEvent.click(button);
    expect(mockOpenOptionsPage).toHaveBeenCalled();
  });

  it("shows header disconnect in unlocked state and clears token", async () => {
    const chromeMock = (globalThis as unknown as { chrome: { tabs: { query: ReturnType<typeof vi.fn> } } }).chrome;
    chromeMock.tabs.query.mockResolvedValueOnce([{ url: "https://example.com" }]);
    mockSendMessage
      .mockResolvedValueOnce({
        type: "GET_STATUS",
        hasToken: true,
        vaultUnlocked: true,
        expiresAt: Date.now() + 1000,
      })
      .mockResolvedValueOnce({ type: "CLEAR_TOKEN", ok: true });

    render(<App />);

    const disconnectButton = await screen.findByRole("button", { name: /disconnect/i });
    fireEvent.click(disconnectButton);

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith({ type: "CLEAR_TOKEN" });
    });
  });

  it("shows header disconnect in locked state and clears token", async () => {
    const chromeMock = (globalThis as unknown as { chrome: { tabs: { query: ReturnType<typeof vi.fn> } } }).chrome;
    chromeMock.tabs.query.mockResolvedValueOnce([{ url: "https://example.com" }]);
    mockSendMessage
      .mockResolvedValueOnce({
        type: "GET_STATUS",
        hasToken: true,
        vaultUnlocked: false,
        expiresAt: Date.now() + 1000,
      })
      .mockResolvedValueOnce({ type: "CLEAR_TOKEN", ok: true });

    render(<App />);

    const disconnectButton = await screen.findByRole("button", { name: /disconnect/i });
    fireEvent.click(disconnectButton);

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith({ type: "CLEAR_TOKEN" });
    });
  });

  it("threads the disconnect reason from GET_STATUS into LoginPrompt", async () => {
    const chromeMock = (globalThis as unknown as { chrome: { tabs: { query: ReturnType<typeof vi.fn> } } }).chrome;
    chromeMock.tabs.query.mockResolvedValueOnce([{ url: "https://example.com" }]);
    mockSendMessage.mockResolvedValueOnce({
      type: "GET_STATUS",
      hasToken: false,
      vaultUnlocked: false,
      expiresAt: null,
      disconnectReason: "expired",
    });

    render(<App />);

    await waitFor(() => {
      expect(mockLoginPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "expired" }),
      );
    });
  });

  it("shows a retry control instead of spinning forever when status cannot be fetched", async () => {
    const chromeMock = (globalThis as unknown as { chrome: { tabs: { query: ReturnType<typeof vi.fn> } } }).chrome;
    chromeMock.tabs.query.mockResolvedValue([{ url: "https://example.com" }]);
    // GET_STATUS rejects on the initial attempt and every retry (e.g. the MV3
    // service worker was torn down and the message channel closed).
    mockSendMessage.mockRejectedValue(new Error("channel closed"));

    render(<App />);

    const retryButton = await screen.findByRole("button", { name: /retry/i }, { timeout: 2000 });
    expect(retryButton).toBeInTheDocument();
    expect(screen.queryByText(/loading/i)).toBeNull();
  });

  it("recovers automatically when an internal retry succeeds (no user action)", async () => {
    const chromeMock = (globalThis as unknown as { chrome: { tabs: { query: ReturnType<typeof vi.fn> } } }).chrome;
    chromeMock.tabs.query.mockResolvedValue([{ url: "https://example.com" }]);
    // First attempt fails (SW waking up), the scheduled retry succeeds.
    mockSendMessage
      .mockRejectedValueOnce(new Error("channel closed"))
      .mockResolvedValue({
        type: "GET_STATUS",
        hasToken: true,
        vaultUnlocked: true,
        expiresAt: Date.now() + 1000,
      });

    render(<App />);

    await waitFor(() => {
      expect(mockMatchList).toHaveBeenCalled();
    });
    // The error pane must never have appeared — the retry self-healed.
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("shows the retry control when the status request hangs past the timeout", async () => {
    vi.useFakeTimers();
    try {
      const chromeMock = (globalThis as unknown as { chrome: { tabs: { query: ReturnType<typeof vi.fn> } } }).chrome;
      chromeMock.tabs.query.mockResolvedValue([{ url: "https://example.com" }]);
      // Never settles — exercises the fetchStatus timeout branch on every attempt.
      mockSendMessage.mockReturnValue(new Promise(() => {}));

      render(<App />);

      // Drive all attempts: 3 timeouts (3s) + 2 retry delays (250ms).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000);
      });

      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers from the error state when retry succeeds", async () => {
    const chromeMock = (globalThis as unknown as { chrome: { tabs: { query: ReturnType<typeof vi.fn> } } }).chrome;
    chromeMock.tabs.query.mockResolvedValue([{ url: "https://example.com" }]);
    mockSendMessage.mockRejectedValue(new Error("channel closed"));

    render(<App />);

    const retryButton = await screen.findByRole("button", { name: /retry/i }, { timeout: 2000 });

    mockSendMessage.mockReset();
    mockSendMessage.mockResolvedValue({
      type: "GET_STATUS",
      hasToken: true,
      vaultUnlocked: true,
      expiresAt: Date.now() + 1000,
    });
    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(mockMatchList).toHaveBeenCalled();
    });
  });

  it("does not render 'Enable autofill' button in vault_unlocked state", async () => {
    const chromeMock = (globalThis as unknown as { chrome: { tabs: { query: ReturnType<typeof vi.fn> } } }).chrome;
    chromeMock.tabs.query.mockResolvedValueOnce([{ url: "https://example.com" }]);
    mockSendMessage.mockResolvedValueOnce({
      type: "GET_STATUS",
      hasToken: true,
      vaultUnlocked: true,
      expiresAt: Date.now() + 1000,
    });

    render(<App />);

    await waitFor(() => {
      expect(mockMatchList).toHaveBeenCalled();
    });

    expect(screen.queryByText(/enable autofill/i)).toBeNull();
    expect(screen.queryByText(/自動入力を有効にする/i)).toBeNull();
  });
});
