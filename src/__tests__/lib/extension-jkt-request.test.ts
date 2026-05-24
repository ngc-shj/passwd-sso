// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EXT_JKT_REQUEST_MSG_TYPE, EXT_JKT_READY_MSG_TYPE } from "@/lib/constants";
import { requestExtensionJkt } from "@/lib/extension-jkt-request";

// A valid RFC 7638 P-256 thumbprint — 43 base64url characters.
const VALID_JKT = "A".repeat(43);

// ---------------------------------------------------------------------------
// reqId capture via postMessage spy (re-installed in each test)
// ---------------------------------------------------------------------------

let postMessageSpy: ReturnType<typeof vi.spyOn>;

function getIssuedReqId(): string {
  // Read the reqId from the most recent postMessage call where type matches.
  for (const call of postMessageSpy.mock.calls) {
    const data = call[0] as Record<string, unknown>;
    if (data?.type === EXT_JKT_REQUEST_MSG_TYPE) {
      return data.reqId as string;
    }
  }
  throw new Error("EXT_JKT_REQUEST_MSG_TYPE was not posted — check requestExtensionJkt implementation");
}

// Dispatch a synthetic PASSWD_SSO_EXT_JKT_READY event on window.
function dispatchReady(payload: Record<string, unknown>, source: EventTarget = window): void {
  const event = new MessageEvent("message", {
    data: payload,
    origin: window.location.origin,
    source: source as Window,
  });
  window.dispatchEvent(event);
}

describe("requestExtensionJkt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    postMessageSpy = vi.spyOn(window, "postMessage");
  });

  afterEach(() => {
    postMessageSpy.mockRestore();
    vi.useRealTimers();
  });

  it("returns jkt when a matching READY arrives within timeoutMs", async () => {
    const promise = requestExtensionJkt({ timeoutMs: 500 });

    // Simulate the content script responding with the jkt.
    dispatchReady({
      type: EXT_JKT_READY_MSG_TYPE,
      reqId: getIssuedReqId(),
      jkt: VALID_JKT,
    });

    const result = await promise;
    expect(result).toBe(VALID_JKT);
  });

  it("returns null after timeoutMs when no READY arrives", async () => {
    const promise = requestExtensionJkt({ timeoutMs: 500 });

    vi.advanceTimersByTime(501);

    const result = await promise;
    expect(result).toBeNull();
  });

  it("ignores READY with wrong reqId", async () => {
    const promise = requestExtensionJkt({ timeoutMs: 500 });

    dispatchReady({
      type: EXT_JKT_READY_MSG_TYPE,
      reqId: "wrong-reqid-000000000000000000000000000000000000",
      jkt: VALID_JKT,
    });

    vi.advanceTimersByTime(501);

    const result = await promise;
    expect(result).toBeNull();
  });

  it("ignores READY with wrong origin", async () => {
    const promise = requestExtensionJkt({ timeoutMs: 500 });

    // Dispatch a message that appears to come from a different origin.
    const reqId = getIssuedReqId();
    const event = new MessageEvent("message", {
      data: { type: EXT_JKT_READY_MSG_TYPE, reqId, jkt: VALID_JKT },
      origin: "https://evil.example.com",
      source: window,
    });
    window.dispatchEvent(event);

    vi.advanceTimersByTime(501);

    const result = await promise;
    expect(result).toBeNull();
  });

  it("ignores READY with event.source !== window (e.g. iframe)", async () => {
    const promise = requestExtensionJkt({ timeoutMs: 500 });

    const reqId = getIssuedReqId();
    // Use null as source to simulate a message from an iframe or non-window source.
    const event = new MessageEvent("message", {
      data: { type: EXT_JKT_READY_MSG_TYPE, reqId, jkt: VALID_JKT },
      origin: window.location.origin,
      source: null,
    });
    window.dispatchEvent(event);

    vi.advanceTimersByTime(501);

    const result = await promise;
    expect(result).toBeNull();
  });

  it("ignores READY with malformed jkt — less than 43 chars", async () => {
    const promise = requestExtensionJkt({ timeoutMs: 500 });

    dispatchReady({
      type: EXT_JKT_READY_MSG_TYPE,
      reqId: getIssuedReqId(),
      jkt: "A".repeat(42), // one char short
    });

    vi.advanceTimersByTime(501);

    const result = await promise;
    expect(result).toBeNull();
  });

  it("ignores READY with malformed jkt — invalid charset (contains '+')", async () => {
    const promise = requestExtensionJkt({ timeoutMs: 500 });

    // Base64 standard chars (+, /) are not valid in base64url.
    dispatchReady({
      type: EXT_JKT_READY_MSG_TYPE,
      reqId: getIssuedReqId(),
      jkt: "+".repeat(43),
    });

    vi.advanceTimersByTime(501);

    const result = await promise;
    expect(result).toBeNull();
  });

  it("ignores READY with malformed jkt — more than 43 chars", async () => {
    const promise = requestExtensionJkt({ timeoutMs: 500 });

    dispatchReady({
      type: EXT_JKT_READY_MSG_TYPE,
      reqId: getIssuedReqId(),
      jkt: "A".repeat(44),
    });

    vi.advanceTimersByTime(501);

    const result = await promise;
    expect(result).toBeNull();
  });

  it("removes listener after successful resolution (no leak)", async () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const promise = requestExtensionJkt({ timeoutMs: 500 });

    dispatchReady({
      type: EXT_JKT_READY_MSG_TYPE,
      reqId: getIssuedReqId(),
      jkt: VALID_JKT,
    });

    await promise;

    // The listener that was added must have been removed.
    const addedHandlers = addSpy.mock.calls
      .filter(([event]) => event === "message")
      .map(([, handler]) => handler);
    const removedHandlers = removeSpy.mock.calls
      .filter(([event]) => event === "message")
      .map(([, handler]) => handler);

    for (const h of addedHandlers) {
      expect(removedHandlers).toContain(h);
    }

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it("removes listener after timeout (no leak)", async () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const promise = requestExtensionJkt({ timeoutMs: 500 });
    vi.advanceTimersByTime(501);
    await promise;

    const addedHandlers = addSpy.mock.calls
      .filter(([event]) => event === "message")
      .map(([, handler]) => handler);
    const removedHandlers = removeSpy.mock.calls
      .filter(([event]) => event === "message")
      .map(([, handler]) => handler);

    for (const h of addedHandlers) {
      expect(removedHandlers).toContain(h);
    }

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it("honours only the first matching READY (subsequent messages are ignored)", async () => {
    const promise = requestExtensionJkt({ timeoutMs: 500 });

    const reqId = getIssuedReqId();
    const FIRST_JKT = "B".repeat(43);
    const SECOND_JKT = "C".repeat(43);

    dispatchReady({ type: EXT_JKT_READY_MSG_TYPE, reqId, jkt: FIRST_JKT });
    dispatchReady({ type: EXT_JKT_READY_MSG_TYPE, reqId, jkt: SECOND_JKT });

    const result = await promise;
    expect(result).toBe(FIRST_JKT);
  });

  it("posts EXT_JKT_REQUEST_MSG_TYPE to window.location.origin (not '*')", async () => {
    const promise = requestExtensionJkt({ timeoutMs: 500 });
    vi.advanceTimersByTime(501);
    await promise;

    expect(postMessageSpy).toHaveBeenCalledOnce();
    const [data, targetOrigin] = postMessageSpy.mock.calls[0];
    expect((data as Record<string, unknown>).type).toBe(EXT_JKT_REQUEST_MSG_TYPE);
    expect(targetOrigin).toBe(window.location.origin);
    expect(targetOrigin).not.toBe("*");
  });
});
