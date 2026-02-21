/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, screen, fireEvent } from "@testing-library/react";

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
});
