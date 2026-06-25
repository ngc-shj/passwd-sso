/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PasskeyMatchEntry } from "../../../types/messages";

// Override navigator.language for consistent i18n
Object.defineProperty(navigator, "language", { value: "en-US", configurable: true });

// Mock shadow-host so the test can reach the (otherwise closed) shadow root.
// mockRoot is attached to document.body so keydown events dispatched on
// document reach the capture-phase handler the dropdown registers.
const mockRoot = document.createElement("div");
vi.mock("../../../content/ui/shadow-host", () => ({
  getShadowHost: vi.fn(() => ({ host: document.createElement("div"), root: mockRoot })),
  removeShadowHost: vi.fn(),
}));

import { showPasskeyDropdown, hidePasskeyDropdown } from "../../../content/ui/passkey-dropdown";

// jsdom sets Event.isTrusted as a non-configurable own property that is always
// false for scripted events and cannot be redefined on the instance or faked via
// the prototype. Real dispatch hands the listener that native (untrusted) event.
// So for the POSITIVE (trusted) path we capture the registered listener and invoke
// it directly with a Proxy that reports isTrusted=true — the same technique the
// suggestion-dropdown test uses for its exported keydown handler. The NEGATIVE
// (untrusted) path uses real dispatch, which is genuinely isTrusted=false.
function trusted<E extends Event>(e: E): E {
  return new Proxy(e, {
    get(target, prop, receiver) {
      if (prop === "isTrusted") return true;
      const val = Reflect.get(target, prop, receiver);
      return typeof val === "function" ? (val as (...a: unknown[]) => unknown).bind(target) : val;
    },
  }) as E;
}

// Capture every (target, type, listener) registered while `fn` runs, so a test
// can invoke a specific listener directly with a trusted-event Proxy.
interface Registered { target: EventTarget; type: string; listener: EventListener }
function captureListeners(fn: () => void): Registered[] {
  const registered: Registered[] = [];
  const targets = [EventTarget.prototype];
  const originals = targets.map((t) => t.addEventListener);
  targets.forEach((t) => {
    t.addEventListener = function (type: string, listener: EventListenerOrEventListenerObject | null, opts?: unknown) {
      if (typeof listener === "function") registered.push({ target: this, type, listener: listener as EventListener });
      return (originals[0] as typeof t.addEventListener).call(this, type, listener as EventListener, opts as boolean);
    } as typeof t.addEventListener;
  });
  try {
    fn();
  } finally {
    targets.forEach((t, i) => { t.addEventListener = originals[i]; });
  }
  return registered;
}

// Invoke the click listener registered on `el` directly with a trusted Proxy event.
function trustedClick(registered: Registered[], el: EventTarget): void {
  const reg = registered.find((r) => r.target === el && r.type === "click");
  if (!reg) throw new Error("no click listener registered on element");
  reg.listener.call(el, trusted(new MouseEvent("click")));
}

// Invoke the document keydown listener directly with a trusted Proxy event.
function trustedKeydown(registered: Registered[], key: string): void {
  const reg = registered.find((r) => r.target === document && r.type === "keydown");
  if (!reg) throw new Error("no keydown listener registered on document");
  reg.listener.call(document, trusted(new KeyboardEvent("keydown", { key, cancelable: true })));
}

function makeEntries(): PasskeyMatchEntry[] {
  return [
    { id: "entry-1", title: "Example", username: "alice", relyingPartyId: "example.com", credentialId: "cred-1" },
  ];
}

function makeOptions(overrides?: Partial<Parameters<typeof showPasskeyDropdown>[0]>) {
  return {
    entries: makeEntries(),
    rpId: "example.com",
    onSelect: vi.fn(),
    onPlatform: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

function getItem(): HTMLDivElement {
  const item = mockRoot.querySelector<HTMLDivElement>('.psso-pk-item[data-entry-id="entry-1"]');
  if (!item) throw new Error("passkey item not rendered");
  return item;
}

function getPlatformItem(): HTMLDivElement {
  const item = mockRoot.querySelector<HTMLDivElement>(".psso-pk-platform");
  if (!item) throw new Error("platform item not rendered");
  return item;
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.body.appendChild(mockRoot);
  mockRoot.innerHTML = "";
});

afterEach(() => {
  hidePasskeyDropdown();
  vi.restoreAllMocks();
});

describe("passkey-dropdown user-presence gate", () => {
  it("renders an item per entry plus the platform row", () => {
    showPasskeyDropdown(makeOptions());
    expect(getItem()).toBeTruthy();
    expect(getPlatformItem()).toBeTruthy();
  });

  // ── Mouse ──────────────────────────────────────────────────────

  it("calls onSelect on a trusted item click", () => {
    const opts = makeOptions();
    const registered = captureListeners(() => showPasskeyDropdown(opts));
    trustedClick(registered, getItem());
    expect(opts.onSelect).toHaveBeenCalledTimes(1);
    expect(opts.onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "entry-1" }));
  });

  it("does NOT call onSelect on a synthetic (untrusted) item click — blocks scripted assertion", () => {
    const opts = makeOptions();
    showPasskeyDropdown(opts);
    getItem().dispatchEvent(new MouseEvent("click", { bubbles: true })); // isTrusted=false
    expect(opts.onSelect).not.toHaveBeenCalled();
  });

  it("does NOT call onPlatform on a synthetic (untrusted) platform click", () => {
    const opts = makeOptions();
    showPasskeyDropdown(opts);
    getPlatformItem().dispatchEvent(new MouseEvent("click", { bubbles: true })); // isTrusted=false
    expect(opts.onPlatform).not.toHaveBeenCalled();
  });

  it("calls onPlatform on a trusted platform click", () => {
    const opts = makeOptions();
    const registered = captureListeners(() => showPasskeyDropdown(opts));
    trustedClick(registered, getPlatformItem());
    expect(opts.onPlatform).toHaveBeenCalledTimes(1);
  });

  // ── Keyboard ───────────────────────────────────────────────────

  it("selects the active item on a trusted Enter", () => {
    const opts = makeOptions();
    const registered = captureListeners(() => showPasskeyDropdown(opts));
    // ArrowDown is navigation only (no guard) — moves active to the first item.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true }));
    trustedKeydown(registered, "Enter");
    expect(opts.onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "entry-1" }));
  });

  it("does NOT select on a synthetic (untrusted) Enter — blocks scripted ArrowDown+Enter exfiltration", () => {
    const opts = makeOptions();
    showPasskeyDropdown(opts);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true })); // isTrusted=false
    expect(opts.onSelect).not.toHaveBeenCalled();
    expect(opts.onPlatform).not.toHaveBeenCalled();
  });
});
