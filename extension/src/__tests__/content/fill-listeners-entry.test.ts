/**
 * @vitest-environment jsdom
 *
 * fill-listeners.ts is the fill-only entry injected into plain http pages. It
 * must register the three fill listeners and nothing else: no detector (whose
 * guard key would be set) and no WebAuthn bridge (a window "message"
 * listener), since a page outside the manifest scope gets no more than the fill.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DETECTOR_GUARD_KEY = "__passwdSsoFormDetector";
const BRIDGE_GUARD_KEY = "__pssoWebAuthnBridge";
const FILL_GUARD_KEYS = ["__pssoAutofillHandler", "__pssoCCAutofillHandler", "__pssoIdentityAutofillHandler"];

let addListener: ReturnType<typeof vi.fn>;
let addEventListenerSpy: ReturnType<typeof vi.spyOn>;

const messageListenerTypes = () =>
  (addEventListenerSpy.mock.calls as unknown[][]).map((c) => c[0]).filter((type) => type === "message");

beforeEach(() => {
  vi.resetModules();
  const win = window as unknown as Record<string, unknown>;
  for (const key of [DETECTOR_GUARD_KEY, BRIDGE_GUARD_KEY, ...FILL_GUARD_KEYS]) delete win[key];
  addListener = vi.fn();
  vi.stubGlobal("chrome", {
    runtime: { id: "ext-id", onMessage: { addListener }, sendMessage: vi.fn() },
    storage: { local: { get: vi.fn() } },
  });
  addEventListenerSpy = vi.spyOn(window, "addEventListener");
});

afterEach(() => {
  addEventListenerSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe("fill-listeners entry", () => {
  it("registers the LOGIN, CC and Identity fill listeners", async () => {
    await import("../../content/fill-listeners");

    expect(addListener).toHaveBeenCalledTimes(3);
    const win = window as unknown as Record<string, unknown>;
    expect(FILL_GUARD_KEYS.map((key) => win[key])).toEqual([true, true, true]);
  });

  it("starts no detector and no WebAuthn bridge", async () => {
    await import("../../content/fill-listeners");

    expect((window as unknown as Record<string, unknown>)[DETECTOR_GUARD_KEY]).toBeUndefined();
    expect(messageListenerTypes()).toEqual([]);
  });

  it("control: the WebAuthn bridge, when imported, does add a window message listener", async () => {
    await import("../../content/webauthn-bridge");

    expect(messageListenerTypes()).toEqual(["message"]);
  });

  it("a second evaluation adds no listener", async () => {
    await import("../../content/fill-listeners");
    vi.resetModules();
    await import("../../content/fill-listeners");

    expect(addListener).toHaveBeenCalledTimes(3);
  });
});
