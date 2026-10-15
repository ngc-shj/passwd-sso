/**
 * @vitest-environment jsdom
 */
// C1: each fill listener calls its perform…() without awaiting it, so a throw
// during T0 detection must reach the closed-code diagnostic sink instead of
// escaping as an unhandled rejection. Only the code is logged, never a value.
// C5: CC / Identity still answer { filled: 0 }; a LOGIN frame whose T0 threw
// stays silent on the popup broadcast, like any frame that cannot fill.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTOFILL_FILL, EXT_MSG } from "../../lib/constants";

type Listener = (
  message: unknown,
  sender: { id: string },
  sendResponse: (response: unknown) => void,
) => unknown;

afterEach(() => {
  vi.doUnmock("../../content/fill-sequence-lib");
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
    message: { type: AUTOFILL_FILL, username: "alice", password: "secret", allowedHosts: ["localhost"] },
    code: "fill-login-failed",
    answers: false,
  },
  {
    kind: "CREDIT_CARD",
    load: () => import("../../content/autofill-cc-lib"),
    message: { type: EXT_MSG.AUTOFILL_CC_FILL, cardNumber: "4111111111111111", cvv: "123" },
    code: "fill-cc-failed",
    answers: true,
  },
  {
    kind: "IDENTITY",
    load: () => import("../../content/autofill-identity-lib"),
    message: { type: EXT_MSG.AUTOFILL_IDENTITY_FILL, fullName: "Jane Doe" },
    code: "fill-identity-failed",
    answers: true,
  },
])("$kind fill listener", ({ load, message, code, answers }) => {
  it("logs only its closed code when T0 detection throws", async () => {
    const listener = await registerListener(load);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(document, "querySelectorAll").mockImplementation(() => {
      throw new Error("page-controlled detail");
    });

    const sendResponse = vi.fn();
    const returned = listener(message, { id: "ext-test-id" }, sendResponse);
    await Promise.resolve();
    await Promise.resolve();

    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith(`[passwd-sso] Fill error: ${code}`);
    expect(returned).toBe(answers);
    if (answers) {
      expect(sendResponse).toHaveBeenCalledTimes(1);
      expect(sendResponse).toHaveBeenCalledWith({ filled: 0 });
    } else {
      expect(sendResponse).not.toHaveBeenCalled();
    }
  });
});

// A LOGIN frame that found a target at T0 has promised an answer; a run that
// then rejects still answers, with nothing filled.
describe("LOGIN fill listener, run rejecting after T0", () => {
  it("answers { filled: 0 } and logs its closed code", async () => {
    vi.doMock("../../content/fill-sequence-lib", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../content/fill-sequence-lib")>();
      return { ...actual, runFillSequence: () => Promise.reject(new Error("page-controlled detail")) };
    });
    document.body.innerHTML = `
      <input type="text" autocomplete="username" />
      <input type="password" autocomplete="current-password" />
    `;
    const listener = await registerListener(() => import("../../content/autofill-lib"));
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const sendResponse = vi.fn();

    const returned = listener(
      { type: AUTOFILL_FILL, username: "alice", password: "secret", allowedHosts: ["localhost"] },
      { id: "ext-test-id" },
      sendResponse,
    );
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

    expect(returned).toBe(true);
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ filled: 0 });
    expect(debug).toHaveBeenCalledWith("[passwd-sso] Fill error: fill-login-failed");
  });
});
