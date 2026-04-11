/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handlePostMessage } from "../../content/token-bridge-lib";
import {
  TOKEN_BRIDGE_MSG_TYPE,
  BRIDGE_CODE_MSG_TYPE,
} from "../../lib/constants";

const VALID_CODE = "a".repeat(64);

describe("token bridge (postMessage)", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-extension-id",
        sendMessage: vi.fn(),
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({ serverUrl: "https://test.example" }),
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeEvent(
    data: unknown,
    source: unknown = window,
    origin = window.location.origin,
  ): MessageEvent {
    return { data, source, origin } as unknown as MessageEvent;
  }

  // ── Legacy token relay path (kept until extension v0.5.x) ──

  describe("legacy token relay (TOKEN_BRIDGE_MSG_TYPE)", () => {
    it("forwards valid relay message to background", async () => {
      const ok = await handlePostMessage(
        makeEvent({ type: TOKEN_BRIDGE_MSG_TYPE, token: "tkn", expiresAt: 123 }),
      );
      expect(ok).toBe(true);
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: "SET_TOKEN",
        token: "tkn",
        expiresAt: 123,
      });
    });

    it("rejects message from different source (iframe)", async () => {
      const ok = await handlePostMessage(
        makeEvent({ type: TOKEN_BRIDGE_MSG_TYPE, token: "tkn", expiresAt: 123 }, {}),
      );
      expect(ok).toBe(false);
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it("rejects message with wrong type", async () => {
      const ok = await handlePostMessage(
        makeEvent({ type: "OTHER_MSG", token: "tkn", expiresAt: 123 }),
      );
      expect(ok).toBe(false);
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it("rejects message with missing token", async () => {
      const ok = await handlePostMessage(
        makeEvent({ type: TOKEN_BRIDGE_MSG_TYPE, expiresAt: 123 }),
      );
      expect(ok).toBe(false);
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it("rejects message with NaN expiresAt", async () => {
      const ok = await handlePostMessage(
        makeEvent({ type: TOKEN_BRIDGE_MSG_TYPE, token: "tkn", expiresAt: NaN }),
      );
      expect(ok).toBe(false);
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it("does not send error response on invalid messages (oracle prevention)", async () => {
      await handlePostMessage(makeEvent({ type: "WRONG" }, {}));
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it("rejects message from a different origin", async () => {
      const ok = await handlePostMessage(
        makeEvent(
          { type: TOKEN_BRIDGE_MSG_TYPE, token: "tkn", expiresAt: 123 },
          window,
          "https://evil.com",
        ),
      );
      expect(ok).toBe(false);
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    });
  });

  // ── New bridge code path ──

  describe("bridge code exchange (BRIDGE_CODE_MSG_TYPE)", () => {
    it("forwards token to background after successful exchange", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: "issued-token",
            expiresAt: "2099-01-01T00:00:00.000Z",
          }),
          { status: 201 },
        ),
      );

      const ok = await handlePostMessage(
        makeEvent({ type: BRIDGE_CODE_MSG_TYPE, code: VALID_CODE, expiresAt: 123 }),
      );

      expect(ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://test.example/api/extension/token/exchange",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ code: VALID_CODE }),
        }),
      );
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: "SET_TOKEN",
        token: "issued-token",
        expiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
      });
    });

    it("rejects bridge code message from a different source (iframe)", async () => {
      const ok = await handlePostMessage(
        makeEvent({ type: BRIDGE_CODE_MSG_TYPE, code: VALID_CODE, expiresAt: 123 }, {}),
      );
      expect(ok).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects bridge code message with code of wrong length", async () => {
      const ok = await handlePostMessage(
        makeEvent({ type: BRIDGE_CODE_MSG_TYPE, code: "tooshort", expiresAt: 123 }),
      );
      expect(ok).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects bridge code message with NaN expiresAt", async () => {
      const ok = await handlePostMessage(
        makeEvent({ type: BRIDGE_CODE_MSG_TYPE, code: VALID_CODE, expiresAt: NaN }),
      );
      expect(ok).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("does not forward token when exchange returns 401", async () => {
      mockFetch.mockResolvedValueOnce(new Response("", { status: 401 }));
      const ok = await handlePostMessage(
        makeEvent({ type: BRIDGE_CODE_MSG_TYPE, code: VALID_CODE, expiresAt: 123 }),
      );
      expect(ok).toBe(false);
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it("does not forward token when fetch network throws", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network"));
      const ok = await handlePostMessage(
        makeEvent({ type: BRIDGE_CODE_MSG_TYPE, code: VALID_CODE, expiresAt: 123 }),
      );
      expect(ok).toBe(false);
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it("does not exchange when serverUrl is missing", async () => {
      vi.stubGlobal("chrome", {
        runtime: { id: "test-extension-id", sendMessage: vi.fn() },
        storage: {
          local: { get: vi.fn().mockResolvedValue({}) },
        },
      });
      const ok = await handlePostMessage(
        makeEvent({ type: BRIDGE_CODE_MSG_TYPE, code: VALID_CODE, expiresAt: 123 }),
      );
      expect(ok).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("does not forward token when exchange response shape is invalid", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ unexpected: "shape" }), { status: 201 }),
      );
      const ok = await handlePostMessage(
        makeEvent({ type: BRIDGE_CODE_MSG_TYPE, code: VALID_CODE, expiresAt: 123 }),
      );
      expect(ok).toBe(false);
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    });
  });
});
