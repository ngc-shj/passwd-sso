/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Override navigator.language for consistent i18n
Object.defineProperty(navigator, "language", { value: "en-US", configurable: true });

// Mock shadow-host so the test can reach the (otherwise closed) shadow root.
const mockRoot = document.createElement("div");
vi.mock("../../../content/ui/shadow-host", () => ({
  getShadowHost: vi.fn(() => ({ host: document.createElement("div"), root: mockRoot })),
  removeShadowHost: vi.fn(),
}));

import { showPasskeySaveBanner, hidePasskeySaveBanner } from "../../../content/ui/passkey-save-banner";

// jsdom marks scripted events isTrusted=false (non-configurable), and real
// dispatch hands the listener the native event. For the POSITIVE (trusted) path
// we capture the registered listener and invoke it with a Proxy reporting
// isTrusted=true; the NEGATIVE path uses real dispatch (genuinely untrusted).
function trusted<E extends Event>(e: E): E {
  return new Proxy(e, {
    get(target, prop, receiver) {
      if (prop === "isTrusted") return true;
      const val = Reflect.get(target, prop, receiver);
      return typeof val === "function" ? (val as (...a: unknown[]) => unknown).bind(target) : val;
    },
  }) as E;
}

interface Registered { target: EventTarget; type: string; listener: EventListener }
function captureListeners(fn: () => void): Registered[] {
  const registered: Registered[] = [];
  const original = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type: string, listener: EventListenerOrEventListenerObject | null, opts?: unknown) {
    if (typeof listener === "function") registered.push({ target: this, type, listener: listener as EventListener });
    return original.call(this, type, listener as EventListener, opts as boolean);
  } as typeof EventTarget.prototype.addEventListener;
  try {
    fn();
  } finally {
    EventTarget.prototype.addEventListener = original;
  }
  return registered;
}

function trustedClick(registered: Registered[], el: EventTarget): void {
  const reg = registered.find((r) => r.target === el && r.type === "click");
  if (!reg) throw new Error("no click listener registered on element");
  reg.listener.call(el, trusted(new MouseEvent("click")));
}

function makeOptions(overrides?: Partial<Parameters<typeof showPasskeySaveBanner>[0]>) {
  return {
    rpName: "Example",
    userName: "alice",
    onSave: vi.fn(),
    onDismiss: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

function saveButton(): HTMLButtonElement {
  const btn = mockRoot.querySelector<HTMLButtonElement>(".psso-btn-primary");
  if (!btn) throw new Error("save button not rendered");
  return btn;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
  document.body.appendChild(mockRoot);
  mockRoot.innerHTML = "";
});

afterEach(() => {
  hidePasskeySaveBanner();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("passkey-save-banner user-presence gate", () => {
  it("calls onSave on a trusted save click", () => {
    const opts = makeOptions();
    const registered = captureListeners(() => showPasskeySaveBanner(opts));
    trustedClick(registered, saveButton());
    expect(opts.onSave).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onSave on a synthetic (untrusted) save click — blocks scripted credential creation", () => {
    const opts = makeOptions();
    showPasskeySaveBanner(opts);
    saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })); // isTrusted=false
    expect(opts.onSave).not.toHaveBeenCalled();
  });
});
