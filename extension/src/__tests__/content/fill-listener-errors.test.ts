/**
 * @vitest-environment jsdom
 */
// C1: each fill listener calls its perform…() without awaiting it, so a throw
// during T0 detection must reach the closed-code diagnostic sink instead of
// escaping as an unhandled rejection. Only the code is logged, never a value.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTOFILL_FILL, EXT_MSG } from "../../lib/constants";

type Listener = (message: unknown, sender: { id: string }) => void;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  for (const key of [
    "__pssoAutofillHandler",
    "__pssoCCAutofillHandler",
    "__pssoIdentityAutofillHandler",
  ]) {
    delete (window as unknown as Record<string, unknown>)[key];
  }
});

async function registerListener(load: () => Promise<unknown>): Promise<Listener> {
  let listener: Listener | null = null;
  vi.stubGlobal("chrome", {
    runtime: {
      id: "ext-test-id",
      onMessage: { addListener: (fn: Listener) => (listener = fn) },
    },
  });
  await load();
  if (!listener) throw new Error("listener was not registered");
  return listener;
}

describe.each([
  {
    kind: "LOGIN",
    load: () => import("../../content/autofill-lib"),
    message: { type: AUTOFILL_FILL, username: "alice", password: "secret" },
    code: "fill-login-failed",
  },
  {
    kind: "CREDIT_CARD",
    load: () => import("../../content/autofill-cc-lib"),
    message: { type: EXT_MSG.AUTOFILL_CC_FILL, cardNumber: "4111111111111111", cvv: "123" },
    code: "fill-cc-failed",
  },
  {
    kind: "IDENTITY",
    load: () => import("../../content/autofill-identity-lib"),
    message: { type: EXT_MSG.AUTOFILL_IDENTITY_FILL, fullName: "Jane Doe" },
    code: "fill-identity-failed",
  },
])("$kind fill listener", ({ load, message, code }) => {
  it("logs only its closed code when T0 detection throws", async () => {
    const listener = await registerListener(load);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(document, "querySelectorAll").mockImplementation(() => {
      throw new Error("page-controlled detail");
    });

    listener(message, { id: "ext-test-id" });
    await Promise.resolve();
    await Promise.resolve();

    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith(`[passwd-sso] Fill error: ${code}`);
  });
});
