import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSendMessage = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: mockSendMessage,
    },
  });
});

import { sendMessage } from "../../lib/messaging";

describe("sendMessage", () => {
  it("sends a typed message and returns the response", async () => {
    mockSendMessage.mockResolvedValue({
      type: "GET_STATUS",
      hasToken: true,
      expiresAt: 1700000000000,
      vaultUnlocked: false,
    });

    const result = await sendMessage({ type: "GET_STATUS" });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "GET_STATUS",
    });
    expect(result).toEqual({
      type: "GET_STATUS",
      hasToken: true,
      expiresAt: 1700000000000,
      vaultUnlocked: false,
    });
  });

  it("passes message payload to chrome.runtime.sendMessage", async () => {
    mockSendMessage.mockResolvedValue({ type: "SET_TOKEN", ok: true });

    await sendMessage({
      type: "SET_TOKEN",
      token: "tok-1",
      expiresAt: 999,
    });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "SET_TOKEN",
      token: "tok-1",
      expiresAt: 999,
    });
  });

  it("propagates rejection from chrome.runtime.sendMessage", async () => {
    mockSendMessage.mockRejectedValue(new Error("Extension context invalidated"));

    await expect(sendMessage({ type: "GET_TOKEN" })).rejects.toThrow(
      "Extension context invalidated",
    );
  });
});
