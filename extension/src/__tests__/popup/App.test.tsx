/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

const mockSendMessage = vi.fn();
const mockMatchList = vi.fn((_props: unknown) => null);
const mockVaultUnlock = vi.fn((_props: unknown) => null);
const mockLoginPrompt = vi.fn((_props: unknown) => null);

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
});
