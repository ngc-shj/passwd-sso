/**
 * @vitest-environment jsdom
 */
// Uses the REAL form-detector-lib / cc-field-detection-lib (unmocked), unlike
// __tests__/login-detector.test.ts, which mocks findPasswordInputs/
// findUsernameInput wholesale. isContextValid() gates both the submit and the
// click capture paths, so a chrome.runtime.id stub is required — without it
// every deny case here would pass for the wrong reason (nothing is captured
// at all, regardless of the CC exclusion).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initLoginDetector, type LoginDetectorCleanup } from "../../content/login-detector-lib";

if (typeof globalThis.CSS === "undefined") {
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
}

let sentMessages: Array<{ type?: string; username?: string; password?: string }> = [];

function installChrome(): void {
  vi.stubGlobal("chrome", {
    runtime: {
      id: "ext-test-id",
      lastError: null,
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
      sendMessage: vi.fn(
        (
          msg: { type?: string; username?: string; password?: string },
          cb?: (res?: unknown) => void,
        ) => {
          sentMessages.push(msg);
          // action: "none" keeps every response a no-op — the save banner is
          // out of scope here, only whether LOGIN_DETECTED was sent.
          cb?.({ type: msg.type, action: "none" });
        },
      ),
    },
  });
}

function loginDetected(): { username?: string; password?: string } | undefined {
  return sentMessages.find((m) => m.type === "LOGIN_DETECTED");
}

let detector: LoginDetectorCleanup | null = null;

function start(): LoginDetectorCleanup {
  detector = initLoginDetector();
  return detector;
}

beforeEach(() => {
  document.body.innerHTML = "";
  sentMessages = [];
  installChrome();
});

afterEach(() => {
  detector?.destroy();
  detector = null;
});

function submitForm(id: string): void {
  const form = document.getElementById(id) as HTMLFormElement;
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function clickButton(id: string): void {
  const button = document.getElementById(id) as HTMLElement;
  button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

describe("login capture excludes the card form (submit path)", () => {
  it("a checkout form whose only password is the card CVV is not captured", () => {
    document.body.innerHTML = `
      <form id="checkout">
        <input name="cardNumber" />
        <input name="cvv" type="password" value="123" />
      </form>
    `;
    start();
    submitForm("checkout");
    expect(loginDetected()).toBeUndefined();
  });

  it("allow: a login form submit on the same page is captured", () => {
    document.body.innerHTML = `
      <form id="checkout">
        <input name="cardNumber" />
        <input name="cvv" type="password" value="123" />
      </form>
      <form id="loginform">
        <input type="text" name="username" value="alice" />
        <input type="password" name="password" value="secret123" />
      </form>
    `;
    start();
    submitForm("loginform");
    expect(loginDetected()).toMatchObject({ username: "alice", password: "secret123" });
  });

  it("a single form holding a login password and a card CVV captures the login password, not the CVV", () => {
    document.body.innerHTML = `
      <form id="combined">
        <input name="cardNumber" />
        <input name="cvv" type="password" value="999" />
        <input type="text" name="username" value="bob" />
        <input type="password" name="password" value="hunter2" />
      </form>
    `;
    start();
    submitForm("combined");
    expect(loginDetected()).toMatchObject({ username: "bob", password: "hunter2" });
  });
});

describe("login capture: the card form's fields are not registration fields", () => {
  // shouldSkipForm skips a form with 3+ registration-like fields. A cardholder
  // field named "name" is part of the card form and must not be counted: with
  // it, phone + country + name would reach 3 and the login password would be
  // lost; without it, 2 remain and the form is a login form.
  it("a combined form with a cardholder 'name' field and two other registration fields captures the login password", () => {
    document.body.innerHTML = `
      <form id="combined">
        <input id="username" type="text" name="username" value="alice">
        <input id="loginpw" type="password" name="password" value="login-secret">
        <input id="phone" type="text" name="phone" value="1">
        <input id="country" type="text" name="country" value="JP">
        <input id="ccnum" type="text" name="card_number" value="4111111111111111">
        <label>Name on card <input id="holder" type="text" name="name" value="A"></label>
        <input id="cvv" type="password" name="cvv" value="123">
      </form>
    `;
    start();
    submitForm("combined");
    expect(loginDetected()).toEqual(expect.objectContaining({ password: "login-secret" }));
  });
});

describe("login capture: a stray cc-* token does not make a registration form pass as login", () => {
  // Only fields anchored on a detected card number leave the registration count.
  // A new-password form with one registration field stays skipped even when the
  // page tags that field with a cc-* token and there is no card number at all.
  it("a new-password form whose phone field carries a spurious cc-* token is still skipped", () => {
    document.body.innerHTML = `
      <form id="signup">
        <input id="username" type="text" name="username" value="alice">
        <input id="newpw" type="password" name="password" autocomplete="new-password" value="new-secret">
        <input id="phone" type="text" name="phone" autocomplete="tel cc-name" value="1">
      </form>
      <form id="login">
        <input id="lu" type="text" name="username" value="bob">
        <input id="lp" type="password" name="password" value="login-secret">
      </form>
    `;
    start();
    // The detector debounces LOGIN_DETECTED for 2 s after it SENDS one, so the
    // order matters: the signup form goes first, then the plain login form as
    // the control. If the signup form were captured, its password would be the
    // only message (the login submit then falls inside the debounce).
    submitForm("signup");
    submitForm("login");
    const detected = sentMessages.filter((m) => m.type === "LOGIN_DETECTED");
    expect(detected).toHaveLength(1);
    expect(detected[0]).toEqual(expect.objectContaining({ password: "login-secret" }));
  });
});

describe("login capture excludes the card form (click path, extractCredentialsFromPage)", () => {
  it("a filled login password and a filled card CVV: the login password is captured", () => {
    document.body.innerHTML = `
      <div id="page">
        <input name="cardNumber" />
        <input name="cvv" type="password" value="123" />
        <input type="text" name="username" value="carol" />
        <input type="password" name="password" value="pw-click" />
        <button type="button" id="loginBtn">Log in</button>
      </div>
    `;
    start();
    clickButton("loginBtn");
    expect(loginDetected()).toMatchObject({ username: "carol", password: "pw-click" });
  });

  it("deny: only a filled card CVV is not captured", () => {
    document.body.innerHTML = `
      <div id="page">
        <input name="cardNumber" />
        <input name="cvv" type="password" value="123" />
        <button type="button" id="loginBtn">Log in</button>
      </div>
    `;
    start();
    clickButton("loginBtn");
    expect(loginDetected()).toBeUndefined();
  });
});

describe("pinned capture gaps (C5 a/b): captured, by design", () => {
  it("a CVV with autocomplete=current-password is captured (FR2 wins over the card block)", () => {
    document.body.innerHTML = `
      <form id="checkout">
        <input name="cardNumber" />
        <input name="cvv" type="password" value="override-secret" autocomplete="current-password" />
      </form>
    `;
    start();
    submitForm("checkout");
    expect(loginDetected()).toMatchObject({ username: "", password: "override-secret" });
  });

  it("a CVV-only form with no card number in the DOM is captured (point-in-time snapshot)", () => {
    document.body.innerHTML = `
      <form id="cvvonly">
        <input name="cvv" type="password" value="no-card-here" />
      </form>
    `;
    start();
    submitForm("cvvonly");
    expect(loginDetected()).toMatchObject({ username: "", password: "no-card-here" });
  });
});
