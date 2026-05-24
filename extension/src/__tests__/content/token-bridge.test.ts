/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handlePostMessage } from "../../content/token-bridge-lib";
import { BRIDGE_CODE_MSG_TYPE, EXT_JKT_REQUEST_MSG_TYPE, EXT_JKT_READY_MSG_TYPE } from "../../lib/constants";

const VALID_CODE = "a".repeat(64);

describe("token bridge (postMessage)", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-extension-id",
        sendMessage: vi.fn().mockImplementation(async (msg: { type: string }) => {
          if (msg.type === "GET_DPOP_PROOF") {
            return { dpop: "fake.dpop.jws" };
          }
          return undefined;
        }),
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

  describe("bridge code exchange (BRIDGE_CODE_MSG_TYPE)", () => {
    it("rejects bridge code message from a different origin", async () => {
      const ok = await handlePostMessage(
        makeEvent(
          { type: BRIDGE_CODE_MSG_TYPE, code: VALID_CODE, expiresAt: 123 },
          window,
          "https://evil.com",
        ),
      );
      expect(ok).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects bridge code message with wrong type", async () => {
      const ok = await handlePostMessage(
        makeEvent({ type: "OTHER_MSG", code: VALID_CODE, expiresAt: 123 }),
      );
      expect(ok).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("does not respond to bridge code messages with invalid type (oracle prevention)", async () => {
      await handlePostMessage(makeEvent({ type: "WRONG" }, {}));
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("forwards token to background after successful exchange", async () => {
      const cnfJkt = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: "issued-token",
            expiresAt: "2099-01-01T00:00:00.000Z",
            cnfJkt,
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
          headers: expect.objectContaining({ DPoP: "fake.dpop.jws" }),
        }),
      );
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "GET_DPOP_PROOF" }),
      );
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: "SET_TOKEN",
        token: "issued-token",
        expiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
        cnfJkt,
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
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "SET_TOKEN" }),
      );
    });

    it("does not forward token when fetch network throws", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network"));
      const ok = await handlePostMessage(
        makeEvent({ type: BRIDGE_CODE_MSG_TYPE, code: VALID_CODE, expiresAt: 123 }),
      );
      expect(ok).toBe(false);
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "SET_TOKEN" }),
      );
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
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "SET_TOKEN" }),
      );
    });

    it("returns false when DPoP proof is null (missing IDB key)", async () => {
      // GET_DPOP_PROOF returns null — exchange must be aborted (F2 fix)
      vi.stubGlobal("chrome", {
        runtime: {
          id: "test-extension-id",
          sendMessage: vi.fn().mockImplementation(async (msg: { type: string }) => {
            if (msg.type === "GET_DPOP_PROOF") return { dpop: null };
            return undefined;
          }),
        },
        storage: {
          local: { get: vi.fn().mockResolvedValue({ serverUrl: "https://test.example" }) },
        },
      });
      const ok = await handlePostMessage(
        makeEvent({ type: BRIDGE_CODE_MSG_TYPE, code: VALID_CODE, expiresAt: 123 }),
      );
      expect(ok).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("jkt handshake (EXT_JKT_REQUEST_MSG_TYPE)", () => {
    const STATIC_JKT = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

    beforeEach(() => {
      vi.stubGlobal("chrome", {
        runtime: {
          id: "test-extension-id",
          sendMessage: vi.fn().mockImplementation(async (msg: { type: string }) => {
            if (msg.type === "GET_DPOP_JKT") return { jkt: STATIC_JKT };
            return undefined;
          }),
        },
        storage: {
          local: { get: vi.fn().mockResolvedValue({ serverUrl: "https://test.example" }) },
        },
      });
    });

    it("responds to EXT_JKT_REQUEST with GET_DPOP_JKT and posts back EXT_JKT_READY", async () => {
      const posted: unknown[] = [];
      vi.spyOn(window, "postMessage").mockImplementation((msg) => { posted.push(msg); });

      const reqId = "req-abc-123";
      const ok = await handlePostMessage(
        makeEvent({ type: EXT_JKT_REQUEST_MSG_TYPE, reqId }),
      );

      expect(ok).toBe(true);
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "GET_DPOP_JKT" });
      expect(posted).toContainEqual(
        expect.objectContaining({ type: EXT_JKT_READY_MSG_TYPE, reqId, jkt: STATIC_JKT }),
      );
    });

    it("ignores EXT_JKT_REQUEST from a different origin", async () => {
      const ok = await handlePostMessage(
        makeEvent({ type: EXT_JKT_REQUEST_MSG_TYPE, reqId: "r1" }, window, "https://evil.com"),
      );
      expect(ok).toBe(false);
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it("ignores EXT_JKT_REQUEST from a non-window source (iframe)", async () => {
      const ok = await handlePostMessage(
        makeEvent({ type: EXT_JKT_REQUEST_MSG_TYPE, reqId: "r1" }, {}),
      );
      expect(ok).toBe(false);
    });

    it("ignores EXT_JKT_REQUEST with missing reqId", async () => {
      const posted: unknown[] = [];
      vi.spyOn(window, "postMessage").mockImplementation((msg) => { posted.push(msg); });

      const ok = await handlePostMessage(
        makeEvent({ type: EXT_JKT_REQUEST_MSG_TYPE }),
      );
      // reqId missing → handleJktRequestMessage returns false early
      expect(ok).toBe(false);
      expect(posted).toHaveLength(0);
    });

    it("ignores EXT_JKT_REQUEST with non-string reqId", async () => {
      const ok = await handlePostMessage(
        makeEvent({ type: EXT_JKT_REQUEST_MSG_TYPE, reqId: 42 }),
      );
      expect(ok).toBe(false);
    });
  });
});
