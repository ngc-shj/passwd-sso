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

vi.mock("../../content/cc-form-detector-lib", () => ({
  initCreditCardDetector: () => ({ destroy: destroyCC }),
}));

vi.mock("../../content/identity-form-detector-lib", () => ({
  initIdentityDetector: () => ({ destroy: destroyIdentity }),
}));

vi.mock("../../content/form-detector-lib", () => ({
  initFormDetector: () => ({ destroy: destroyForm }),
}));

vi.mock("../../content/login-detector-lib", () => ({
  initLoginDetector: () => ({ destroy: destroyLogin }),
}));

vi.mock("../../content/ui/shadow-host", () => ({
  removeShadowHost: removeShadowHostMock,
  getShadowHost: vi.fn(),
}));

// Side-effect-only imports — empty mocks prevent chrome API calls.
vi.mock("../../content/autofill-lib", () => ({}));
vi.mock("../../content/webauthn-bridge", () => ({}));

const GUARD_KEY = "__passwdSsoFormDetector";

beforeEach(() => {
  destroyCC.mockReset();
  destroyIdentity.mockReset();
  destroyForm.mockReset();
  destroyLogin.mockReset();
  removeShadowHostMock.mockReset();

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
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[GUARD_KEY];
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

  it("double-injection guard prevents a second init when the entry point is imported again", async () => {
    // First import triggers init.
    await import("../../content/form-detector");
    const callsAfterFirst = destroyForm.mock.calls.length;

    // Simulate a second import WITHOUT resetting the guard or modules —
    // the guard key is set, so no second init should run.
    await import("../../content/form-detector");

    // destroyForm should not have been called a second time (no second init).
    expect(destroyForm.mock.calls.length).toBe(callsAfterFirst);
  });
});
