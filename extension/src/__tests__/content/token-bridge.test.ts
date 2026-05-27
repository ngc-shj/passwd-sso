/**
 * @vitest-environment jsdom
 *
 * C7 — content script connect-request relay tests. The content script's only
 * job is to forward EXT_CONNECT_REQUEST → SW.START_CONNECT and post back
 * EXT_CONNECT_READY with the SW's result.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handlePostMessage } from "../../content/token-bridge-lib";
import {
  EXT_CONNECT_REQUEST_MSG_TYPE,
  EXT_CONNECT_READY_MSG_TYPE,
} from "../../lib/constants";

describe("token bridge (postMessage) — EXT_CONNECT_REQUEST relay", () => {
  let mockSendMessage: ReturnType<typeof vi.fn>;
  let postedMessages: Array<{ data: unknown; targetOrigin: string }>;
  let originalPostMessage: typeof window.postMessage;

  beforeEach(() => {
    mockSendMessage = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-extension-id",
        sendMessage: mockSendMessage,
      },
    });

    // Capture window.postMessage targets without dispatching events (which
    // would cause infinite recursion through handlePostMessage's listener).
    postedMessages = [];
    originalPostMessage = window.postMessage.bind(window);
    window.postMessage = ((data: unknown, targetOrigin: string) => {
      postedMessages.push({ data, targetOrigin });
    }) as typeof window.postMessage;

    // C15-v2 gate: default to a fresh user activation so existing tests
    // exercise the post-gate paths. The gate itself is covered by
    // token-bridge-user-activation.test.ts.
    Object.defineProperty(navigator, "userActivation", {
      value: { isActive: true, hasBeenActive: true },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.postMessage = originalPostMessage;
    delete (navigator as Navigator & { userActivation?: unknown }).userActivation;
  });

  function makeEvent(
    data: unknown,
    source: unknown = window,
    origin = window.location.origin,
  ): MessageEvent {
    return { data, source, origin } as unknown as MessageEvent;
  }

  it("rejects message from a different origin (cross-origin)", async () => {
    const ok = await handlePostMessage(
      makeEvent(
        { type: EXT_CONNECT_REQUEST_MSG_TYPE, reqId: "req-1" },
        window,
        "https://evil.com",
      ),
    );
    expect(ok).toBe(false);
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(postedMessages).toHaveLength(0);
  });

  it("rejects message from a different source (iframe)", async () => {
    const ok = await handlePostMessage(
      makeEvent({ type: EXT_CONNECT_REQUEST_MSG_TYPE, reqId: "req-1" }, {}),
    );
    expect(ok).toBe(false);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("ignores messages with unknown type (oracle prevention)", async () => {
    const ok = await handlePostMessage(makeEvent({ type: "OTHER_MSG", reqId: "req-1" }));
    expect(ok).toBe(false);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("ignores connect requests without a reqId (defensive)", async () => {
    const ok = await handlePostMessage(makeEvent({ type: EXT_CONNECT_REQUEST_MSG_TYPE }));
    expect(ok).toBe(false);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("forwards START_CONNECT and posts READY with ok:true on success", async () => {
    mockSendMessage.mockResolvedValueOnce({ ok: true });

    const ok = await handlePostMessage(
      makeEvent({ type: EXT_CONNECT_REQUEST_MSG_TYPE, reqId: "req-42" }),
    );

    expect(ok).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledWith({ type: "START_CONNECT" });
    expect(postedMessages).toHaveLength(1);
    expect(postedMessages[0]).toEqual({
      data: { type: EXT_CONNECT_READY_MSG_TYPE, reqId: "req-42", ok: true },
      targetOrigin: window.location.origin,
    });
  });

  it("propagates errorCode from SW on failure", async () => {
    mockSendMessage.mockResolvedValueOnce({ ok: false, errorCode: "SESSION_STEP_UP_REQUIRED" });

    const ok = await handlePostMessage(
      makeEvent({ type: EXT_CONNECT_REQUEST_MSG_TYPE, reqId: "req-7" }),
    );

    expect(ok).toBe(true);
    expect(postedMessages[0].data).toEqual({
      type: EXT_CONNECT_READY_MSG_TYPE,
      reqId: "req-7",
      ok: false,
      errorCode: "SESSION_STEP_UP_REQUIRED",
    });
  });

  it("posts READY with GENERIC_FAILURE when sendMessage throws", async () => {
    mockSendMessage.mockRejectedValueOnce(new Error("context invalidated"));

    const ok = await handlePostMessage(
      makeEvent({ type: EXT_CONNECT_REQUEST_MSG_TYPE, reqId: "req-9" }),
    );

    expect(ok).toBe(true);
    expect(postedMessages[0].data).toEqual({
      type: EXT_CONNECT_READY_MSG_TYPE,
      reqId: "req-9",
      ok: false,
      errorCode: "GENERIC_FAILURE",
    });
  });

  it("never forwards bridge codes or tokens — request envelope carries only reqId", async () => {
    mockSendMessage.mockResolvedValueOnce({ ok: true });

    await handlePostMessage(
      makeEvent({
        type: EXT_CONNECT_REQUEST_MSG_TYPE,
        reqId: "req-1",
        // Even if the page maliciously injects extra fields, they MUST NOT
        // leak into the runtime message — START_CONNECT carries no payload.
        token: "should-not-appear",
        code: "should-not-appear",
      }),
    );

    const sentMessage = mockSendMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(sentMessage).sort()).toEqual(["type"]);
  });
});
