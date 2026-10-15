/**
 * @vitest-environment jsdom
 */
// C5: each fill listener reports what it wrote as { filled: n }. The popup
// broadcasts LOGIN to every frame and takes the first answer, so a LOGIN frame
// answers only when it passed its gate and found a target at T0; any other
// frame returns false and stays silent. CC / Identity go to one document and
// always answer. C4: CC / Identity never fill an insecure http page.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTOFILL_FILL, EXT_MSG } from "../../lib/constants";
import { DEFAULT_LATE_FIELD_WINDOW_MS } from "../../content/fill-sequence-lib";

type SendResponse = (response: unknown) => void;
type Listener = (message: unknown, sender: { id: string }, sendResponse: SendResponse) => unknown;

const EXT_ID = "ext-test-id";
const GUARD_KEYS = ["__pssoAutofillHandler", "__pssoCCAutofillHandler", "__pssoIdentityAutofillHandler"];
const originalLocation = window.location;

afterEach(async () => {
  const { __resetFillSequenceForTests } = await import("../../content/fill-sequence-lib");
  __resetFillSequenceForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  for (const key of GUARD_KEYS) delete (window as unknown as Record<string, unknown>)[key];
  document.body.innerHTML = "";
});

async function registerListener(load: () => Promise<unknown>): Promise<Listener> {
  let listener: Listener | null = null;
  vi.stubGlobal("chrome", {
    runtime: { id: EXT_ID, onMessage: { addListener: (fn: Listener) => (listener = fn) } },
  });
  await load();
  if (!listener) throw new Error("listener was not registered");
  return listener;
}

function atPage(href: string): void {
  Object.defineProperty(window, "location", { configurable: true, value: new URL(href) });
}

/** Delivers `message`, lets every run end, and returns what the listener did. */
async function deliver(listener: Listener, message: unknown) {
  vi.useFakeTimers();
  const sendResponse = vi.fn<SendResponse>();
  const returned = listener(message, { id: EXT_ID }, sendResponse);
  await vi.advanceTimersByTimeAsync(DEFAULT_LATE_FIELD_WINDOW_MS + 100);
  return { returned, sendResponse };
}

const value = (id: string) => (document.getElementById(id) as HTMLInputElement).value;

describe("LOGIN fill listener", () => {
  const loadLogin = () => import("../../content/autofill-lib");
  const PAGE_HOST = new URL(window.location.href).hostname;
  const login = (extra: Record<string, unknown> = {}) => ({
    type: AUTOFILL_FILL,
    username: "alice",
    password: "secret",
    allowedHosts: [PAGE_HOST],
    ...extra,
  });

  it("a frame that fills answers the number of fields it wrote and keeps the channel open", async () => {
    document.body.innerHTML = `
      <input id="u" type="text" autocomplete="username" />
      <input id="p" type="password" autocomplete="current-password" />
    `;
    const listener = await registerListener(loadLogin);

    const { returned, sendResponse } = await deliver(listener, login());

    expect(returned).toBe(true);
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ filled: 2 });
    expect(value("p")).toBe("secret");
  });

  it("a frame its gate refuses returns false and never answers", async () => {
    document.body.innerHTML = `
      <input id="u" type="text" autocomplete="username" />
      <input id="p" type="password" autocomplete="current-password" />
    `;
    const listener = await registerListener(loadLogin);

    const { returned, sendResponse } = await deliver(listener, login({ allowedHosts: ["other.example"] }));

    expect(returned).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
    expect(value("p")).toBe("");
  });

  it("a frame whose T0 finds no target returns false and never answers", async () => {
    document.body.innerHTML = `<input id="search" type="search" />`;
    const listener = await registerListener(loadLogin);

    const { returned, sendResponse } = await deliver(listener, login());

    expect(returned).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it("a refused request still supersedes the frame's pending fill", async () => {
    // The first request waits for a late password field; the refused second
    // request must end it, so the field that appears afterwards stays empty.
    document.body.innerHTML = `<form id="f"><input id="u" type="text" autocomplete="username" /></form>`;
    const listener = await registerListener(loadLogin);
    vi.useFakeTimers();
    listener(login(), { id: EXT_ID }, vi.fn());
    await vi.advanceTimersByTimeAsync(5);
    listener(login({ allowedHosts: ["other.example"] }), { id: EXT_ID }, vi.fn());
    const late = document.createElement("input");
    late.id = "p";
    late.type = "password";
    document.getElementById("f")?.appendChild(late);
    await vi.advanceTimersByTimeAsync(DEFAULT_LATE_FIELD_WINDOW_MS + 100);

    expect(value("u")).toBe("alice");
    expect(value("p")).toBe("");
  });
});

describe.each([
  {
    kind: "CREDIT_CARD",
    load: () => import("../../content/autofill-cc-lib"),
    form: `<input id="f" autocomplete="cc-number" />`,
    message: { type: EXT_MSG.AUTOFILL_CC_FILL, cardNumber: "4111111111111111" },
    written: "4111111111111111",
    fields: 1,
  },
  {
    kind: "IDENTITY",
    load: () => import("../../content/autofill-identity-lib"),
    form: `<input id="f" autocomplete="name" /><input id="e" autocomplete="email" />`,
    message: { type: EXT_MSG.AUTOFILL_IDENTITY_FILL, fullName: "Jane Doe", email: "j@example.com" },
    written: "Jane Doe",
    fields: 2,
  },
])("$kind fill listener", ({ load, form, message, written, fields }) => {
  it.each([
    { page: "https://shop.example/checkout", filled: fields, expected: written },
    { page: "http://localhost:3000/checkout", filled: fields, expected: written },
    { page: "http://127.0.0.1:8080/checkout", filled: fields, expected: written },
    // C4: never into an insecure http page.
    { page: "http://shop.example/checkout", filled: 0, expected: "" },
  ])("on $page answers { filled: $filled }", async ({ page, filled, expected }) => {
    atPage(page);
    document.body.innerHTML = form;
    const listener = await registerListener(load);

    const { returned, sendResponse } = await deliver(listener, { ...message });

    expect(returned).toBe(true);
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ filled });
    expect(value("f")).toBe(expected);
  });

  it("answers { filled: 0 } when the page has no field for it", async () => {
    document.body.innerHTML = `<input id="f" type="search" />`;
    const listener = await registerListener(load);

    const { returned, sendResponse } = await deliver(listener, { ...message });

    expect(returned).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith({ filled: 0 });
  });
});
