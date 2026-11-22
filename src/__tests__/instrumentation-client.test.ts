// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
  captureRouterTransitionStart: vi.fn(),
  init: vi.fn(),
  setNonce: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  captureRouterTransitionStart: mocks.captureRouterTransitionStart,
  init: mocks.init,
}));
// Pass-through spy: get-nonce lives in node_modules, which resetModules does
// not reload, so its module global would leak between tests otherwise.
vi.mock("get-nonce", async (importOriginal) => {
  const actual = await importOriginal<typeof import("get-nonce")>();
  return {
    ...actual,
    setNonce: (nonce: string) => {
      mocks.setNonce(nonce);
      actual.setNonce(nonce);
    },
  };
});

const load = () => import("../../instrumentation-client");

describe("instrumentation-client", () => {
  beforeEach(() => {
    vi.resetModules();
    document.head.innerHTML = "";
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("primes get-nonce with the document's CSP nonce", async () => {
    const meta = document.createElement("meta");
    meta.name = "csp-nonce";
    meta.content = "nonce-from-meta";
    document.head.appendChild(meta);

    await load();

    expect(mocks.setNonce).toHaveBeenCalledWith("nonce-from-meta");
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("warns once and leaves get-nonce unset when the document has no nonce carrier", async () => {
    await load();

    expect(mocks.setNonce).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("CSP_NONCE_CARRIER_UNAVAILABLE"));
  });

  it("switches zod to jitless mode so its eval probe never runs", async () => {
    z.config({ jitless: false });
    await load();
    expect(z.config().jitless).toBe(true);
  });

  it("exports Sentry's router-transition hook", async () => {
    const mod = await load();
    expect(mod.onRouterTransitionStart).toBe(mocks.captureRouterTransitionStart);
  });
});
