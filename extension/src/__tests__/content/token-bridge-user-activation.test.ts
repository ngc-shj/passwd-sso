/**
 * @vitest-environment jsdom
 *
 * C15-v2 — token-bridge userActivation gate.
 *
 * The gate drops EXT_CONNECT_REQUEST silently (no EXT_CONNECT_READY reply)
 * when navigator.userActivation.isActive is false. This prevents XSS in the
 * host page from autonomously triggering the SW's connect flow:
 * programmatic .click() and dispatchEvent(MouseEvent) do not set
 * userActivation per HTML User Activation v2, so an XSS payload cannot
 * forge the flag.
 *
 * Why silent drop: any postReady on activation failure would create an
 * oracle ("extension installed but I lack activation" vs "extension
 * absent"). The page-side requestExtensionConnect helper has an 8-second
 * timeout that collapses both cases to EXTENSION_ABSENT.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { handlePostMessage } from "../../content/token-bridge-lib";
import {
  EXT_CONNECT_REQUEST_MSG_TYPE,
} from "../../lib/constants";

describe("token-bridge userActivation gate", () => {
  let mockSendMessage: ReturnType<typeof vi.fn>;
  let postedMessages: Array<{ data: unknown; targetOrigin: string }>;
  let originalPostMessage: typeof window.postMessage;
  let originalUserActivationDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    mockSendMessage = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-extension-id",
        sendMessage: mockSendMessage,
      },
    });

    postedMessages = [];
    originalPostMessage = window.postMessage.bind(window);
    window.postMessage = ((data: unknown, targetOrigin: string) => {
      postedMessages.push({ data, targetOrigin });
    }) as typeof window.postMessage;

    // Save prototype descriptor (jsdom may or may not provide one). Use
    // Object.defineProperty rather than vi.stubGlobal("navigator",...) to
    // avoid clobbering other navigator accessors.
    originalUserActivationDescriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(navigator) as object,
      "userActivation",
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.postMessage = originalPostMessage;
    delete (navigator as Navigator & { userActivation?: unknown }).userActivation;
    if (originalUserActivationDescriptor) {
      Object.defineProperty(
        Object.getPrototypeOf(navigator) as object,
        "userActivation",
        originalUserActivationDescriptor,
      );
    }
  });

  function setUserActivation(value: unknown): void {
    Object.defineProperty(navigator, "userActivation", {
      value,
      configurable: true,
      writable: true,
    });
  }

  function makeEvent(
    data: unknown,
    source: unknown = window,
    origin = window.location.origin,
  ): MessageEvent {
    return { data, source, origin } as unknown as MessageEvent;
  }

  it("processes EXT_CONNECT_REQUEST when isActive is true", async () => {
    setUserActivation({ isActive: true, hasBeenActive: true });
    const ok = await handlePostMessage(
      makeEvent({ type: EXT_CONNECT_REQUEST_MSG_TYPE, reqId: "req-1" }),
    );
    expect(ok).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it("silently drops when isActive is false (no EXT_CONNECT_READY emitted)", async () => {
    setUserActivation({ isActive: false, hasBeenActive: false });
    const ok = await handlePostMessage(
      makeEvent({ type: EXT_CONNECT_REQUEST_MSG_TYPE, reqId: "req-1" }),
    );
    expect(ok).toBe(false);
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(postedMessages).toHaveLength(0);
  });

  it("silently drops when navigator.userActivation is undefined", async () => {
    setUserActivation(undefined);
    const ok = await handlePostMessage(
      makeEvent({ type: EXT_CONNECT_REQUEST_MSG_TYPE, reqId: "req-1" }),
    );
    expect(ok).toBe(false);
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(postedMessages).toHaveLength(0);
  });

  it("silently drops when navigator.userActivation is {} (no isActive property)", async () => {
    setUserActivation({});
    const ok = await handlePostMessage(
      makeEvent({ type: EXT_CONNECT_REQUEST_MSG_TYPE, reqId: "req-1" }),
    );
    expect(ok).toBe(false);
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(postedMessages).toHaveLength(0);
  });

  it("silently drops when only hasBeenActive is true (sticky activation does NOT bypass gate)", async () => {
    // Pins the invariant that ONLY transient activation matters. Sticky
    // activation persists for the document lifetime and would defeat the
    // gate if hasBeenActive were used.
    setUserActivation({ isActive: false, hasBeenActive: true });
    const ok = await handlePostMessage(
      makeEvent({ type: EXT_CONNECT_REQUEST_MSG_TYPE, reqId: "req-1" }),
    );
    expect(ok).toBe(false);
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(postedMessages).toHaveLength(0);
  });

  it("activation check fires after reqId validation (malformed payload still rejected)", async () => {
    setUserActivation({ isActive: true });
    const ok = await handlePostMessage(
      makeEvent({ type: EXT_CONNECT_REQUEST_MSG_TYPE /* no reqId */ }),
    );
    expect(ok).toBe(false);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("activation check fires before isContextValid (no EXTENSION_ABSENT oracle when activation is missing)", async () => {
    // isActive=false + chrome.runtime undefined → gate fires first → silent
    // drop, NOT the EXTENSION_ABSENT postReady that isContextValid would
    // otherwise emit.
    vi.stubGlobal("chrome", {} as unknown);
    setUserActivation({ isActive: false });
    const ok = await handlePostMessage(
      makeEvent({ type: EXT_CONNECT_REQUEST_MSG_TYPE, reqId: "req-1" }),
    );
    expect(ok).toBe(false);
    expect(postedMessages).toHaveLength(0);
  });

  it("gate body does not reference window.location (pathname-independent)", () => {
    // jsdom does not allow redefining window.location.pathname, so we pin
    // the requirement via static source inspection. A future regression
    // that adds `if (location.pathname === "/dashboard") return;` would be
    // caught — the gate must remain location-agnostic so XSS firing from
    // any dashboard route is equally blocked.
    const file = readFileSync(
      resolve(__dirname, "../../content/token-bridge-lib.ts"),
      "utf8",
    );
    const fnMatch = file.match(
      /async function handleConnectRequestMessage[\s\S]+?\n\}/,
    );
    expect(fnMatch, "could not locate handleConnectRequestMessage").not.toBeNull();
    const body = fnMatch?.[0] ?? "";
    expect(body).not.toMatch(/\blocation\b/);
  });
});
