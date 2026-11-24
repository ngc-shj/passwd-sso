// @vitest-environment jsdom
/**
 * Unit tests for extension-connect-request helpers.
 *
 * C5 (T9): `coerceErrorCode` is now exported so it can be tested directly.
 * The component test mocks `requestExtensionConnect` wholesale and cannot
 * reach this seam — direct testing is the only reliable way to assert the
 * allowlist is correct.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  EXT_CONNECT_READY_MSG_TYPE,
  EXT_CONNECT_REQUEST_MSG_TYPE,
} from "@/lib/constants";
import {
  coerceErrorCode,
  requestExtensionConnect,
  EXTENSION_CONNECT_ERROR_CODE,
  type ExtensionConnectResult,
} from "./extension-connect-request";

describe("coerceErrorCode", () => {
  it("passes SESSION_STEP_UP_REQUIRED through unchanged", () => {
    expect(coerceErrorCode("SESSION_STEP_UP_REQUIRED")).toBe(
      EXTENSION_CONNECT_ERROR_CODE.SESSION_STEP_UP_REQUIRED,
    );
  });

  it("passes EXTENSION_ABSENT through unchanged", () => {
    expect(coerceErrorCode("EXTENSION_ABSENT")).toBe(
      EXTENSION_CONNECT_ERROR_CODE.EXTENSION_ABSENT,
    );
  });

  it("passes PASSKEY_REQUIRED through unchanged (C5)", () => {
    expect(coerceErrorCode("PASSKEY_REQUIRED")).toBe(
      EXTENSION_CONNECT_ERROR_CODE.PASSKEY_REQUIRED,
    );
  });

  it("coerces an unknown string to GENERIC_FAILURE", () => {
    expect(coerceErrorCode("SOME_UNKNOWN_CODE")).toBe(
      EXTENSION_CONNECT_ERROR_CODE.GENERIC_FAILURE,
    );
  });

  it("coerces a non-string input to GENERIC_FAILURE", () => {
    expect(coerceErrorCode(null)).toBe(EXTENSION_CONNECT_ERROR_CODE.GENERIC_FAILURE);
    expect(coerceErrorCode(undefined)).toBe(EXTENSION_CONNECT_ERROR_CODE.GENERIC_FAILURE);
    expect(coerceErrorCode(42)).toBe(EXTENSION_CONNECT_ERROR_CODE.GENERIC_FAILURE);
    expect(coerceErrorCode({})).toBe(EXTENSION_CONNECT_ERROR_CODE.GENERIC_FAILURE);
  });

  it("does NOT pass GENERIC_FAILURE through as an allowlisted code (it is the fallback)", () => {
    // GENERIC_FAILURE is not in the allowlist — it is the default. Passing
    // the literal "GENERIC_FAILURE" in a message also returns GENERIC_FAILURE,
    // which is correct (not a bypass).
    expect(coerceErrorCode("GENERIC_FAILURE")).toBe(
      EXTENSION_CONNECT_ERROR_CODE.GENERIC_FAILURE,
    );
  });
});

describe("requestExtensionConnect", () => {
  // postMessage is the browser boundary: capture the outgoing request instead
  // of delivering it, and play the content-script relay's reply by hand.
  let posted: Array<{ message: { type: string; reqId: string }; targetOrigin: string }>;

  beforeEach(() => {
    vi.useFakeTimers();
    posted = [];
    vi.spyOn(window, "postMessage").mockImplementation(((message: { type: string; reqId: string }, targetOrigin: string) => {
      posted.push({ message, targetOrigin });
    }) as typeof window.postMessage);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function reply(data: unknown, init: { origin?: string; source?: Window | null } = {}) {
    window.dispatchEvent(
      new MessageEvent("message", {
        data,
        origin: init.origin ?? window.location.origin,
        source: init.source === undefined ? window : init.source,
      }),
    );
  }

  function readyFor(reqId: string, extra: Record<string, unknown>) {
    return { type: EXT_CONNECT_READY_MSG_TYPE, reqId, ...extra };
  }

  async function settledWithin(promise: Promise<ExtensionConnectResult>, ms: number) {
    let result: ExtensionConnectResult | undefined;
    void promise.then((r) => {
      result = r;
    });
    await vi.advanceTimersByTimeAsync(ms);
    return result;
  }

  it("posts the connect request to its own origin", () => {
    void requestExtensionConnect();
    expect(posted).toHaveLength(1);
    expect(posted[0].message.type).toBe(EXT_CONNECT_REQUEST_MSG_TYPE);
    expect(posted[0].targetOrigin).toBe(window.location.origin);
  });

  it("resolves ok on a matching READY reply", async () => {
    const promise = requestExtensionConnect();
    reply(readyFor(posted[0].message.reqId, { ok: true }));
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("passes an allowlisted error code through", async () => {
    const promise = requestExtensionConnect();
    reply(readyFor(posted[0].message.reqId, { ok: false, errorCode: "PASSKEY_REQUIRED" }));
    await expect(promise).resolves.toEqual({ ok: false, errorCode: "PASSKEY_REQUIRED" });
  });

  it("coerces an unknown error code to GENERIC_FAILURE", async () => {
    const promise = requestExtensionConnect();
    reply(readyFor(posted[0].message.reqId, { ok: false, errorCode: "<script>" }));
    await expect(promise).resolves.toEqual({ ok: false, errorCode: "GENERIC_FAILURE" });
  });

  it("treats a truthy non-true ok as a failure", async () => {
    const promise = requestExtensionConnect();
    reply(readyFor(posted[0].message.reqId, { ok: "true" }));
    await expect(promise).resolves.toEqual({ ok: false, errorCode: "GENERIC_FAILURE" });
  });

  it("ignores a reply for another request id", async () => {
    const promise = requestExtensionConnect({ timeoutMs: 100 });
    reply(readyFor("someone-else", { ok: true }));
    await expect(settledWithin(promise, 100)).resolves.toEqual({ ok: false, errorCode: "EXTENSION_ABSENT" });
  });

  it("ignores a reply from another origin", async () => {
    const promise = requestExtensionConnect({ timeoutMs: 100 });
    reply(readyFor(posted[0].message.reqId, { ok: true }), { origin: "https://evil.example" });
    await expect(settledWithin(promise, 100)).resolves.toEqual({ ok: false, errorCode: "EXTENSION_ABSENT" });
  });

  it("ignores a reply whose source is not this window", async () => {
    const promise = requestExtensionConnect({ timeoutMs: 100 });
    reply(readyFor(posted[0].message.reqId, { ok: true }), { source: null });
    await expect(settledWithin(promise, 100)).resolves.toEqual({ ok: false, errorCode: "EXTENSION_ABSENT" });
  });

  it("ignores a message of another type and a null payload", async () => {
    const promise = requestExtensionConnect({ timeoutMs: 100 });
    const reqId = posted[0].message.reqId;
    reply({ type: EXT_CONNECT_REQUEST_MSG_TYPE, reqId, ok: true });
    reply(null);
    await expect(settledWithin(promise, 100)).resolves.toEqual({ ok: false, errorCode: "EXTENSION_ABSENT" });
  });

  it("keeps the first reply when a second one arrives", async () => {
    const promise = requestExtensionConnect();
    const reqId = posted[0].message.reqId;
    reply(readyFor(reqId, { ok: true }));
    reply(readyFor(reqId, { ok: false, errorCode: "PASSKEY_REQUIRED" }));
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("waits the default 8 seconds before reporting the extension absent", async () => {
    const promise = requestExtensionConnect();
    await expect(settledWithin(promise, 7_999)).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toEqual({ ok: false, errorCode: "EXTENSION_ABSENT" });
  });

  it("removes its message listener once settled", async () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const promise = requestExtensionConnect();
    reply(readyFor(posted[0].message.reqId, { ok: true }));
    await promise;
    expect(removeSpy).toHaveBeenCalledWith("message", expect.any(Function));
  });

  it("falls back to a generated request id without crypto.randomUUID", async () => {
    vi.stubGlobal("crypto", {});
    const promise = requestExtensionConnect();
    const reqId = posted[0].message.reqId;
    expect(reqId).toMatch(/^req-[a-z0-9]+-\d+$/);
    reply(readyFor(reqId, { ok: true }));
    await expect(promise).resolves.toEqual({ ok: true });
  });
});
