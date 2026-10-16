/**
 * @vitest-environment jsdom
 *
 * M5 — entry-point teardown (form-detector.ts, F6 invariant)
 *
 * The entry point runs module-level code on import (the guard-key pattern).
 * vi.resetModules() + deleting the window guard key lets us re-import cleanly.
 *
 * We mock the four init-lib modules so each returns a destroy spy, and mock
 * removeShadowHost from ./ui/shadow-host so we can count its invocations.
 * After import (which registers the error handler), dispatching a window error
 * with "Extension context invalidated" must call every destroy spy exactly once
 * and removeShadowHost exactly once — not once per detector.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Spies declared with vi.hoisted so they are available inside vi.mock factories.
const destroyCC = vi.hoisted(() => vi.fn());
const destroyIdentity = vi.hoisted(() => vi.fn());
const destroyForm = vi.hoisted(() => vi.fn());
const destroyLogin = vi.hoisted(() => vi.fn());
const removeShadowHostMock = vi.hoisted(() => vi.fn());
// One spy per detector init: the double-injection guard is observed as how
// many times the entry point ran them.
const inits = vi.hoisted(() => ({
  cc: vi.fn(() => ({ destroy: destroyCC })),
  identity: vi.fn(() => ({ destroy: destroyIdentity })),
  form: vi.fn(() => ({ destroy: destroyForm })),
  login: vi.fn(() => ({ destroy: destroyLogin })),
}));

vi.mock("../../content/cc-form-detector-lib", () => ({
  initCreditCardDetector: inits.cc,
}));

vi.mock("../../content/identity-form-detector-lib", () => ({
  initIdentityDetector: inits.identity,
}));

vi.mock("../../content/form-detector-lib", () => ({
  initFormDetector: inits.form,
}));

vi.mock("../../content/login-detector-lib", () => ({
  initLoginDetector: inits.login,
}));

vi.mock("../../content/ui/shadow-host", () => ({
  removeShadowHost: removeShadowHostMock,
  getShadowHost: vi.fn(),
}));

// Side-effect-only imports — empty mocks prevent chrome API calls.
vi.mock("../../content/autofill-lib", () => ({}));
vi.mock("../../content/webauthn-bridge", () => ({}));

const GUARD_KEY = "__passwdSsoFormDetector";

// M5 fix: the entry point registers a window "error" listener at import time
// and never removes it (correct for a real page, which loads it once). The
// jsdom `window` is shared across every test in this file, and vi.resetModules()
// only clears the MODULE cache — it does not detach already-registered DOM
// listeners. Without tracking, a test that imports the entry point but never
// dispatches the invalidation event (e.g. "double-injection guard...") leaves
// its listener attached; a later test's dispatch then fires BOTH that leftover
// listener and its own fresh one, double-counting destroy() calls. Wrapping
// addEventListener here lets afterEach explicitly detach every listener the
// entry point registered during the test, closing the leak at its source.
let errorListeners: Array<{
  listener: EventListenerOrEventListenerObject;
  options?: boolean | AddEventListenerOptions;
}> = [];
let realAddEventListener: typeof window.addEventListener;

beforeEach(() => {
  destroyCC.mockReset();
  destroyIdentity.mockReset();
  destroyForm.mockReset();
  destroyLogin.mockReset();
  removeShadowHostMock.mockReset();
  for (const init of Object.values(inits)) init.mockClear();

  // Clear the double-injection guard so the entry point re-runs on import.
  delete (window as unknown as Record<string, unknown>)[GUARD_KEY];

  vi.resetModules();

  vi.stubGlobal("chrome", {
    runtime: {
      id: "ext-test-id",
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      lastError: null,
    },
    storage: {
      local: { get: vi.fn() },
      session: { setAccessLevel: vi.fn() },
    },
  });

  errorListeners = [];
  realAddEventListener = window.addEventListener.bind(window);
  window.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    // Record the options too: removeEventListener only matches a listener
    // registered with the same capture flag, so dropping the options here
    // would silently defeat the teardown if the entry point ever registers
    // with { capture: true }. (Today it registers "error" with no options.)
    if (type === "error") errorListeners.push({ listener, options });
    realAddEventListener(type, listener, options);
  }) as typeof window.addEventListener;
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[GUARD_KEY];
  for (const { listener, options } of errorListeners) {
    window.removeEventListener("error", listener, options);
  }
  errorListeners = [];
  window.addEventListener = realAddEventListener;
});

describe("M5: entry-point error-handler teardown (F6 invariant)", () => {
  it("dispatching 'Extension context invalidated' calls every destroy once and removeShadowHost once", async () => {
    // Import the entry point — module-level code runs, registers cleanups + error handler.
    await import("../../content/form-detector");

    // Dispatch the error that orphaned content scripts produce.
    window.dispatchEvent(
      new ErrorEvent("error", { message: "Extension context invalidated" }),
    );

    // Each detector's destroy must have been called exactly once.
    expect(destroyForm).toHaveBeenCalledOnce();
    expect(destroyLogin).toHaveBeenCalledOnce();
    expect(destroyCC).toHaveBeenCalledOnce();
    expect(destroyIdentity).toHaveBeenCalledOnce();

    // F6: the shared shadow host is removed once, not once per detector.
    expect(removeShadowHostMock).toHaveBeenCalledOnce();
  });

});

// The guard is what keeps a second evaluation of the entry point in the same
// window (the bundle injected again by the fill's inject-and-resend, beside the
// manifest copy) from starting a second set of detectors. vi.resetModules()
// makes the second import evaluate the module again, as a second injection
// does; a plain re-import would hit the module cache and prove nothing.
describe("double-injection guard", () => {
  const initCallCounts = () => Object.values(inits).map((init) => init.mock.calls.length);

  async function evaluateTwice({ clearKeyBetween }: { clearKeyBetween: boolean }) {
    await import("../../content/form-detector");
    expect(initCallCounts()).toEqual([1, 1, 1, 1]);
    vi.resetModules();
    if (clearKeyBetween) delete (window as unknown as Record<string, unknown>)[GUARD_KEY];
    await import("../../content/form-detector");
  }

  it("a second evaluation with the guard key set runs no detector init", async () => {
    await evaluateTwice({ clearKeyBetween: false });

    expect(initCallCounts()).toEqual([1, 1, 1, 1]);
    expect(errorListeners).toHaveLength(1);
  });

  it("control: a second evaluation with the guard key unset runs every init again", async () => {
    await evaluateTwice({ clearKeyBetween: true });

    expect(initCallCounts()).toEqual([2, 2, 2, 2]);
    expect(errorListeners).toHaveLength(2);
  });
});
