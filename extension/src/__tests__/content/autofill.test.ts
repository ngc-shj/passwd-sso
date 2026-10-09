/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { performAutofill } from "../../content/autofill-lib";
import {
  __resetFillSequenceForTests,
  DEFAULT_LATE_FIELD_WINDOW_MS,
} from "../../content/fill-sequence-lib";
import type { AutofillPayload } from "../../types/messages";
import { AUTOFILL_FILL } from "../../lib/constants";

// Existing rows assert T0 targets only: a zero late-field window keeps them free
// of the deferral wait (every T0 target is still written).
const NO_WAIT = { lateFieldWindowMs: 0 };

afterEach(() => {
  __resetFillSequenceForTests();
});

function setupForm(html: string) {
  document.body.innerHTML = html;
}

describe("performAutofill", () => {
  it("fills inputs with autocomplete attributes", async () => {
    setupForm(`
      <input type="text" autocomplete="username" />
      <input type="password" autocomplete="current-password" />
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
    }, NO_WAIT);

    const inputs = document.querySelectorAll("input");
    expect((inputs[0] as HTMLInputElement).value).toBe("alice");
    expect((inputs[1] as HTMLInputElement).value).toBe("secret");
  });

  it("falls back to last password input and previous text input", async () => {
    setupForm(`
      <input type="text" id="user" />
      <input type="password" id="pw1" />
      <input type="password" id="pw2" />
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "bob",
      password: "pw",
    }, NO_WAIT);

    const user = document.getElementById("user") as HTMLInputElement;
    const pw2 = document.getElementById("pw2") as HTMLInputElement;
    expect(user.value).toBe("bob");
    expect(pw2.value).toBe("pw");
  });

  it("fills only password when username is empty", async () => {
    setupForm(`
      <input type="text" id="user" />
      <input type="password" id="pw" />
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "",
      password: "secret",
    }, NO_WAIT);

    const user = document.getElementById("user") as HTMLInputElement;
    const pw = document.getElementById("pw") as HTMLInputElement;
    expect(user.value).toBe("");
    expect(pw.value).toBe("secret");
  });

  it("fills id-like username field before password", async () => {
    setupForm(`
      <input type="text" id="userId" name="userId" />
      <input type="password" id="pw" />
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "myjcb-user",
      password: "secret",
    }, NO_WAIT);

    const user = document.getElementById("userId") as HTMLInputElement;
    const pw = document.getElementById("pw") as HTMLInputElement;
    expect(user.value).toBe("myjcb-user");
    expect(pw.value).toBe("secret");
  });

  it("fills focused text input first (inline dropdown selection case)", async () => {
    setupForm(`
      <input type="text" id="focusedUser" />
      <input type="password" id="pw" />
    `);

    const focusedUser = document.getElementById("focusedUser") as HTMLInputElement;
    focusedUser.focus();

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "focus-user",
      password: "secret",
    }, NO_WAIT);

    const pw = document.getElementById("pw") as HTMLInputElement;
    expect(focusedUser.value).toBe("focus-user");
    expect(pw.value).toBe("secret");
  });

  it("fills using target hint even when no field is focused", async () => {
    setupForm(`
      <input type="text" id="userId" name="userId" />
      <input type="password" id="pw" />
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "hint-user",
      password: "secret",
      targetHint: { id: "userId", name: "userId", type: "text" },
    }, NO_WAIT);

    const user = document.getElementById("userId") as HTMLInputElement;
    const pw = document.getElementById("pw") as HTMLInputElement;
    expect(user.value).toBe("hint-user");
    expect(pw.value).toBe("secret");
  });

  it("fills custom fields by matching label to input id", async () => {
    setupForm(`
      <input id="brchNum" type="text" />
      <input id="user" type="text" name="username" />
      <input id="pw" type="password" />
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
      customFields: [{ label: "brchNum", value: "001" }],
    }, NO_WAIT);

    expect((document.getElementById("brchNum") as HTMLInputElement).value).toBe("001");
    expect((document.getElementById("user") as HTMLInputElement).value).toBe("alice");
    expect((document.getElementById("pw") as HTMLInputElement).value).toBe("secret");
  });

  it("fills custom fields by matching label to input name (case-insensitive)", async () => {
    setupForm(`
      <input type="text" name="AccountId" />
      <input id="user" type="text" name="username" />
      <input id="pw" type="password" />
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
      customFields: [{ label: "accountid", value: "123456789012" }],
    }, NO_WAIT);

    expect((document.querySelector("[name=AccountId]") as HTMLInputElement).value).toBe("123456789012");
  });

  it("skips custom fields with no matching input", async () => {
    setupForm(`
      <input id="user" type="text" name="username" />
      <input id="pw" type="password" />
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
      customFields: [{ label: "nonexistent", value: "ignored" }],
    }, NO_WAIT);

    expect((document.getElementById("user") as HTMLInputElement).value).toBe("alice");
    expect((document.getElementById("pw") as HTMLInputElement).value).toBe("secret");
  });

  it("fills OTP field with autocomplete='one-time-code'", async () => {
    setupForm(`
      <input type="text" id="user" name="username" />
      <input type="password" id="pw" />
      <input type="text" id="otp" autocomplete="one-time-code" />
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
      totpCode: "123456",
    }, NO_WAIT);

    expect((document.getElementById("user") as HTMLInputElement).value).toBe("alice");
    expect((document.getElementById("pw") as HTMLInputElement).value).toBe("secret");
    expect((document.getElementById("otp") as HTMLInputElement).value).toBe("123456");
  });

  it("fills OTP field matched by hint pattern (name='otp-code')", async () => {
    setupForm(`
      <input type="text" id="user" name="username" />
      <input type="password" id="pw" />
      <input type="text" id="otp" name="otp-code" />
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
      totpCode: "654321",
    }, NO_WAIT);

    expect((document.getElementById("otp") as HTMLInputElement).value).toBe("654321");
  });

  it("fills OTP field matched by Japanese hint (placeholder='認証コード')", async () => {
    setupForm(`
      <input type="text" id="user" name="username" />
      <input type="password" id="pw" />
      <input type="text" id="otp" placeholder="認証コード" />
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
      totpCode: "111222",
    }, NO_WAIT);

    expect((document.getElementById("otp") as HTMLInputElement).value).toBe("111222");
  });

  it("does not fill OTP field when totpCode is undefined", async () => {
    setupForm(`
      <input type="text" id="user" name="username" />
      <input type="password" id="pw" />
      <input type="text" id="otp" autocomplete="one-time-code" />
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
    }, NO_WAIT);

    expect((document.getElementById("otp") as HTMLInputElement).value).toBe("");
  });

  it("username and password fill are unaffected by totpCode presence", async () => {
    setupForm(`
      <input type="text" id="user" name="username" />
      <input type="password" id="pw" />
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
      totpCode: "123456",
    }, NO_WAIT);

    expect((document.getElementById("user") as HTMLInputElement).value).toBe("alice");
    expect((document.getElementById("pw") as HTMLInputElement).value).toBe("secret");
  });

  it("does not overwrite password field when TOTP-only (no password)", async () => {
    setupForm(`
      <input type="text" id="user" name="username" />
      <input type="password" id="pw" value="existing-password" />
      <input type="text" id="otp" autocomplete="one-time-code" />
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "",
      totpCode: "123456",
    }, NO_WAIT);

    expect((document.getElementById("pw") as HTMLInputElement).value).toBe("existing-password");
    expect((document.getElementById("otp") as HTMLInputElement).value).toBe("123456");
  });

  it("does not overwrite password field when password is undefined", async () => {
    setupForm(`
      <input type="text" id="user" name="username" />
      <input type="password" id="pw" value="existing-password" />
      <input type="text" id="otp" autocomplete="one-time-code" />
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "",
      password: "",
      totpCode: "654321",
    }, NO_WAIT);

    expect((document.getElementById("pw") as HTMLInputElement).value).toBe("existing-password");
    expect((document.getElementById("otp") as HTMLInputElement).value).toBe("654321");
  });

  it("prefers OTP field in same form over OTP field in another form", async () => {
    setupForm(`
      <form id="login-form">
        <input type="text" id="user" name="username" />
        <input type="password" id="pw" />
        <input type="text" id="otp-same" autocomplete="one-time-code" />
      </form>
      <form id="other-form">
        <input type="text" id="otp-other" autocomplete="one-time-code" />
      </form>
    `);

    const userInput = document.getElementById("user") as HTMLInputElement;
    userInput.focus();

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
      totpCode: "999888",
    }, NO_WAIT);

    expect((document.getElementById("otp-same") as HTMLInputElement).value).toBe("999888");
    expect((document.getElementById("otp-other") as HTMLInputElement).value).toBe("");
  });

  it("distributes TOTP digits across 6 split single-digit fields (maxLength=1)", async () => {
    setupForm(`
      <input type="text" id="user" name="username" />
      <input type="password" id="pw" />
      <section>
        <input type="text" id="d1" maxlength="1" />
        <input type="text" id="d2" maxlength="1" />
        <input type="text" id="d3" maxlength="1" />
        <input type="text" id="d4" maxlength="1" />
        <input type="text" id="d5" maxlength="1" />
        <input type="text" id="d6" maxlength="1" />
      </section>
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
      totpCode: "123456",
    }, NO_WAIT);

    expect((document.getElementById("d1") as HTMLInputElement).value).toBe("1");
    expect((document.getElementById("d2") as HTMLInputElement).value).toBe("2");
    expect((document.getElementById("d3") as HTMLInputElement).value).toBe("3");
    expect((document.getElementById("d4") as HTMLInputElement).value).toBe("4");
    expect((document.getElementById("d5") as HTMLInputElement).value).toBe("5");
    expect((document.getElementById("d6") as HTMLInputElement).value).toBe("6");
  });

  it("distributes TOTP digits across split fields with type='tel'", async () => {
    setupForm(`
      <section>
        <input type="tel" id="d1" maxlength="1" />
        <input type="tel" id="d2" maxlength="1" />
        <input type="tel" id="d3" maxlength="1" />
        <input type="tel" id="d4" maxlength="1" />
        <input type="tel" id="d5" maxlength="1" />
        <input type="tel" id="d6" maxlength="1" />
      </section>
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "",
      password: "",
      totpCode: "987654",
    }, NO_WAIT);

    expect((document.getElementById("d1") as HTMLInputElement).value).toBe("9");
    expect((document.getElementById("d2") as HTMLInputElement).value).toBe("8");
    expect((document.getElementById("d3") as HTMLInputElement).value).toBe("7");
    expect((document.getElementById("d4") as HTMLInputElement).value).toBe("6");
    expect((document.getElementById("d5") as HTMLInputElement).value).toBe("5");
    expect((document.getElementById("d6") as HTMLInputElement).value).toBe("4");
  });

  it("prefers split OTP fields over a single OTP field when both exist", async () => {
    setupForm(`
      <input type="text" id="otp-single" autocomplete="one-time-code" />
      <section>
        <input type="text" id="d1" maxlength="1" />
        <input type="text" id="d2" maxlength="1" />
        <input type="text" id="d3" maxlength="1" />
        <input type="text" id="d4" maxlength="1" />
        <input type="text" id="d5" maxlength="1" />
        <input type="text" id="d6" maxlength="1" />
      </section>
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "",
      password: "",
      totpCode: "111222",
    }, NO_WAIT);

    expect((document.getElementById("otp-single") as HTMLInputElement).value).toBe("");
    expect((document.getElementById("d1") as HTMLInputElement).value).toBe("1");
    expect((document.getElementById("d2") as HTMLInputElement).value).toBe("1");
    expect((document.getElementById("d3") as HTMLInputElement).value).toBe("1");
    expect((document.getElementById("d4") as HTMLInputElement).value).toBe("2");
    expect((document.getElementById("d5") as HTMLInputElement).value).toBe("2");
    expect((document.getElementById("d6") as HTMLInputElement).value).toBe("2");
  });

  it("falls back to single field when split fields count does not match code length", async () => {
    setupForm(`
      <input type="text" id="otp" autocomplete="one-time-code" />
      <section>
        <input type="text" id="d1" maxlength="1" />
        <input type="text" id="d2" maxlength="1" />
        <input type="text" id="d3" maxlength="1" />
        <input type="text" id="d4" maxlength="1" />
      </section>
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "",
      password: "",
      totpCode: "123456",
    }, NO_WAIT);

    expect((document.getElementById("otp") as HTMLInputElement).value).toBe("123456");
    expect((document.getElementById("d1") as HTMLInputElement).value).toBe("");
  });

  it("does not treat non-maxLength-1 inputs as split OTP fields", async () => {
    setupForm(`
      <input type="text" id="otp" autocomplete="one-time-code" />
      <section>
        <input type="text" id="a" />
        <input type="text" id="b" />
        <input type="text" id="c" />
        <input type="text" id="d" />
        <input type="text" id="e" />
        <input type="text" id="f" />
      </section>
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "",
      password: "",
      totpCode: "123456",
    }, NO_WAIT);

    expect((document.getElementById("otp") as HTMLInputElement).value).toBe("123456");
  });

  it("distributes TOTP across indexed name fields (otp-code-0…5)", async () => {
    setupForm(`
      <section>
        <input type="text" id="d0" name="otp-code-0" />
        <input type="text" id="d1" name="otp-code-1" />
        <input type="text" id="d2" name="otp-code-2" />
        <input type="text" id="d3" name="otp-code-3" />
        <input type="text" id="d4" name="otp-code-4" />
        <input type="text" id="d5" name="otp-code-5" />
      </section>
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "",
      password: "",
      totpCode: "314159",
    }, NO_WAIT);

    expect((document.getElementById("d0") as HTMLInputElement).value).toBe("3");
    expect((document.getElementById("d1") as HTMLInputElement).value).toBe("1");
    expect((document.getElementById("d2") as HTMLInputElement).value).toBe("4");
    expect((document.getElementById("d3") as HTMLInputElement).value).toBe("1");
    expect((document.getElementById("d4") as HTMLInputElement).value).toBe("5");
    expect((document.getElementById("d5") as HTMLInputElement).value).toBe("9");
  });

  it("skips disabled field and falls back to single OTP", async () => {
    setupForm(`
      <input type="text" id="otp" autocomplete="one-time-code" />
      <section>
        <input type="text" id="d1" maxlength="1" />
        <input type="text" id="d2" maxlength="1" />
        <input type="text" id="d3" maxlength="1" disabled />
        <input type="text" id="d4" maxlength="1" />
        <input type="text" id="d5" maxlength="1" />
        <input type="text" id="d6" maxlength="1" />
      </section>
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "",
      password: "",
      totpCode: "123456",
    }, NO_WAIT);

    expect((document.getElementById("otp") as HTMLInputElement).value).toBe("123456");
    expect((document.getElementById("d1") as HTMLInputElement).value).toBe("");
  });

  it("distributes 8-digit TOTP across 8 split fields", async () => {
    setupForm(`
      <section>
        <input type="text" id="d1" maxlength="1" />
        <input type="text" id="d2" maxlength="1" />
        <input type="text" id="d3" maxlength="1" />
        <input type="text" id="d4" maxlength="1" />
        <input type="text" id="d5" maxlength="1" />
        <input type="text" id="d6" maxlength="1" />
        <input type="text" id="d7" maxlength="1" />
        <input type="text" id="d8" maxlength="1" />
      </section>
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "",
      password: "",
      totpCode: "12345678",
    }, NO_WAIT);

    expect((document.getElementById("d1") as HTMLInputElement).value).toBe("1");
    expect((document.getElementById("d2") as HTMLInputElement).value).toBe("2");
    expect((document.getElementById("d3") as HTMLInputElement).value).toBe("3");
    expect((document.getElementById("d4") as HTMLInputElement).value).toBe("4");
    expect((document.getElementById("d5") as HTMLInputElement).value).toBe("5");
    expect((document.getElementById("d6") as HTMLInputElement).value).toBe("6");
    expect((document.getElementById("d7") as HTMLInputElement).value).toBe("7");
    expect((document.getElementById("d8") as HTMLInputElement).value).toBe("8");
  });

  it("handles split OTP fields in separate wrappers sharing a section ancestor", async () => {
    setupForm(`
      <section id="otp-group">
        <span><input type="text" id="d1" maxlength="1" /></span>
        <span><input type="text" id="d2" maxlength="1" /></span>
        <span><input type="text" id="d3" maxlength="1" /></span>
        <span><input type="text" id="d4" maxlength="1" /></span>
        <span><input type="text" id="d5" maxlength="1" /></span>
        <span><input type="text" id="d6" maxlength="1" /></span>
      </section>
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "",
      password: "",
      totpCode: "654321",
    }, NO_WAIT);

    expect((document.getElementById("d1") as HTMLInputElement).value).toBe("6");
    expect((document.getElementById("d2") as HTMLInputElement).value).toBe("5");
    expect((document.getElementById("d3") as HTMLInputElement).value).toBe("4");
    expect((document.getElementById("d4") as HTMLInputElement).value).toBe("3");
    expect((document.getElementById("d5") as HTMLInputElement).value).toBe("2");
    expect((document.getElementById("d6") as HTMLInputElement).value).toBe("1");
  });

  it("prefers form-scoped split OTP fields over global ones", async () => {
    setupForm(`
      <form id="login">
        <input type="text" id="user" name="username" />
        <input type="password" id="pw" />
        <section>
          <input type="text" id="f1" maxlength="1" />
          <input type="text" id="f2" maxlength="1" />
          <input type="text" id="f3" maxlength="1" />
          <input type="text" id="f4" maxlength="1" />
          <input type="text" id="f5" maxlength="1" />
          <input type="text" id="f6" maxlength="1" />
        </section>
      </form>
      <section>
        <input type="text" id="g1" maxlength="1" />
        <input type="text" id="g2" maxlength="1" />
        <input type="text" id="g3" maxlength="1" />
        <input type="text" id="g4" maxlength="1" />
        <input type="text" id="g5" maxlength="1" />
        <input type="text" id="g6" maxlength="1" />
      </section>
    `);

    const userInput = document.getElementById("user") as HTMLInputElement;
    userInput.focus();

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
      totpCode: "999888",
    }, NO_WAIT);

    expect((document.getElementById("f1") as HTMLInputElement).value).toBe("9");
    expect((document.getElementById("f2") as HTMLInputElement).value).toBe("9");
    expect((document.getElementById("f3") as HTMLInputElement).value).toBe("9");
    expect((document.getElementById("f4") as HTMLInputElement).value).toBe("8");
    expect((document.getElementById("f5") as HTMLInputElement).value).toBe("8");
    expect((document.getElementById("f6") as HTMLInputElement).value).toBe("8");
    expect((document.getElementById("g1") as HTMLInputElement).value).toBe("");
  });

  it("does not group split fields across different forms", async () => {
    setupForm(`
      <form id="form-a">
        <input type="text" id="a1" maxlength="1" />
        <input type="text" id="a2" maxlength="1" />
        <input type="text" id="a3" maxlength="1" />
      </form>
      <form id="form-b">
        <input type="text" id="b1" maxlength="1" />
        <input type="text" id="b2" maxlength="1" />
        <input type="text" id="b3" maxlength="1" />
      </form>
      <input type="text" id="otp" autocomplete="one-time-code" />
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "",
      password: "",
      totpCode: "123456",
    }, NO_WAIT);

    // Different <form> ancestors prevent grouping, so falls back to single OTP
    expect((document.getElementById("otp") as HTMLInputElement).value).toBe("123456");
    expect((document.getElementById("a1") as HTMLInputElement).value).toBe("");
  });

  it("skips readOnly field and falls back to single OTP", async () => {
    setupForm(`
      <input type="text" id="otp" autocomplete="one-time-code" />
      <section>
        <input type="text" id="d1" maxlength="1" />
        <input type="text" id="d2" maxlength="1" />
        <input type="text" id="d3" maxlength="1" readonly />
        <input type="text" id="d4" maxlength="1" />
        <input type="text" id="d5" maxlength="1" />
        <input type="text" id="d6" maxlength="1" />
      </section>
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "",
      password: "",
      totpCode: "123456",
    }, NO_WAIT);

    expect((document.getElementById("otp") as HTMLInputElement).value).toBe("123456");
    expect((document.getElementById("d1") as HTMLInputElement).value).toBe("");
  });
});

describe("performAutofill — frame-origin gate", () => {
  // Simulate a subframe (window.top !== window.self) at a given origin.
  async function inSubframe(href: string, run: () => Promise<void>) {
    const originalLocation = window.location;
    const originalTop = window.top;
    Object.defineProperty(window, "top", { configurable: true, value: {} });
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL(href),
    });
    try {
      await run();
    } finally {
      Object.defineProperty(window, "top", { configurable: true, value: originalTop });
      Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    }
  }

  it("does NOT fill a cross-origin subframe whose host is not in allowedHosts", async () => {
    setupForm(`
      <input type="text" autocomplete="username" />
      <input type="password" autocomplete="current-password" />
    `);

    await inSubframe("https://attacker.example/iframe", async () => {
      await performAutofill({
        type: "AUTOFILL_FILL",
        username: "alice",
        password: "secret",
        allowedHosts: ["bank.example"],
      }, NO_WAIT);
    });

    const inputs = document.querySelectorAll("input");
    expect((inputs[0] as HTMLInputElement).value).toBe("");
    expect((inputs[1] as HTMLInputElement).value).toBe("");
  });

  it("fills a same-origin-family subframe whose host matches allowedHosts", async () => {
    setupForm(`
      <input type="text" autocomplete="username" />
      <input type="password" autocomplete="current-password" />
    `);

    await inSubframe("https://login.bank.example/sso", async () => {
      await performAutofill({
        type: "AUTOFILL_FILL",
        username: "alice",
        password: "secret",
        allowedHosts: ["bank.example"],
      }, NO_WAIT);
    });

    const inputs = document.querySelectorAll("input");
    expect((inputs[0] as HTMLInputElement).value).toBe("alice");
    expect((inputs[1] as HTMLInputElement).value).toBe("secret");
  });

  it("does NOT fill a subframe when the entry has no bound host (allowedHosts absent)", async () => {
    setupForm(`
      <input type="text" autocomplete="username" />
      <input type="password" autocomplete="current-password" />
    `);

    await inSubframe("https://sub.example/x", async () => {
      await performAutofill({
        type: "AUTOFILL_FILL",
        username: "alice",
        password: "secret",
      }, NO_WAIT);
    });

    const inputs = document.querySelectorAll("input");
    expect((inputs[1] as HTMLInputElement).value).toBe("");
  });

  it("does NOT fill a subframe whose origin cannot be resolved to a host (fail-closed)", async () => {
    // extractHost returns null for a non-http(s) frame URL. The gate must
    // fail closed (`if (!frameHost) return false`) even when the entry has
    // bound hosts — an unresolvable origin can never match an allowed host.
    setupForm(`
      <input type="text" autocomplete="username" />
      <input type="password" autocomplete="current-password" />
    `);

    await inSubframe("about:blank", async () => {
      await performAutofill({
        type: "AUTOFILL_FILL",
        username: "alice",
        password: "secret",
        allowedHosts: ["bank.example"],
      }, NO_WAIT);
    });

    const inputs = document.querySelectorAll("input");
    expect((inputs[1] as HTMLInputElement).value).toBe("");
  });

  it("always fills the top frame regardless of allowedHosts", async () => {
    // Default jsdom context is the top frame (window.top === window.self).
    setupForm(`
      <input type="text" autocomplete="username" />
      <input type="password" autocomplete="current-password" />
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
      allowedHosts: ["other.example"],
    }, NO_WAIT);

    const inputs = document.querySelectorAll("input");
    expect((inputs[1] as HTMLInputElement).value).toBe("secret");
  });
});

// ── Sequential fill (plan C2) ─────────────────────────────────

describe("performAutofill — sequential fill", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const loginPayload = (overrides: Partial<AutofillPayload> = {}): AutofillPayload => ({
    type: AUTOFILL_FILL,
    username: "alice",
    password: "secret",
    ...overrides,
  });

  function byId(id: string): HTMLInputElement {
    const el = document.getElementById(id);
    if (!(el instanceof HTMLInputElement)) throw new Error(`fixture missing #${id}`);
    return el;
  }

  function addPassword(parent: Element, id: string): HTMLInputElement {
    const el = document.createElement("input");
    el.type = "password";
    el.id = id;
    parent.appendChild(el);
    return el;
  }

  async function settle(fill: Promise<void>): Promise<void> {
    await vi.advanceTimersByTimeAsync(DEFAULT_LATE_FIELD_WINDOW_MS + 100);
    await fill;
  }

  it("writes the custom fields, then a focused non-custom username, then the password", async () => {
    setupForm(`
      <input id="member" type="text" />
      <input id="user" type="text" />
      <input id="pw" type="password" />
    `);
    const order: string[] = [];
    for (const el of document.querySelectorAll("input")) {
      el.addEventListener("input", () => order.push(el.id));
    }
    byId("user").focus();

    await settle(
      performAutofill(loginPayload({ customFields: [{ label: "member", value: "M-1" }] })),
    );

    expect(order).toEqual(["member", "user", "pw"]);
    expect(byId("member").value).toBe("M-1");
    expect(byId("user").value).toBe("alice");
    expect(byId("pw").value).toBe("secret");
  });

  it("a second fill supersedes a pending one: a late password field gets only the second password", async () => {
    setupForm(`<div id="login"><input id="user" type="text" /></div>`);
    byId("user").focus();

    const first = performAutofill(loginPayload({ username: "alice", password: "first-pw" }));
    await vi.advanceTimersByTimeAsync(5);
    const second = performAutofill(loginPayload({ username: "bob", password: "second-pw" }));
    await vi.advanceTimersByTimeAsync(5);

    addPassword(document.getElementById("login") as HTMLElement, "pw");
    await settle(Promise.all([first, second]).then(() => {}));

    expect(byId("pw").value).toBe("second-pw");
    expect(byId("user").value).toBe("bob");
  });

  // FR4: a newer request this frame refuses at the origin gate still ends the
  // frame's pending fill, so the earlier entry cannot keep writing.
  it("a later request refused by the frame gate still ends a pending fill", async () => {
    setupForm(`<div id="login"><input id="user" type="text" /></div>`);
    byId("user").focus();
    const fill = performAutofill(loginPayload({ password: "first-pw" }));
    await vi.advanceTimersByTimeAsync(5);

    const originalTop = window.top;
    const originalLocation = window.location;
    Object.defineProperty(window, "top", { configurable: true, value: {} });
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("https://attacker.example/frame"),
    });
    try {
      await performAutofill(loginPayload({ password: "other-pw", allowedHosts: ["bank.example"] }));
    } finally {
      Object.defineProperty(window, "top", { configurable: true, value: originalTop });
      Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    }

    addPassword(document.getElementById("login") as HTMLElement, "pw");
    await settle(fill);

    expect(byId("user").value).toBe("alice");
    expect(byId("pw").value).toBe("");
  });

  it("does not write a custom field into a password input that matches its label", async () => {
    setupForm(`
      <input id="pin" type="password" />
      <input id="user" type="text" />
    `);

    await settle(
      performAutofill(loginPayload({ password: "", customFields: [{ label: "pin", value: "1234" }] })),
    );

    expect(byId("pin").value).toBe("");
  });

  it("does not write a custom field hidden at its turn and revealed after the deadline", async () => {
    setupForm(`
      <input id="member" type="text" style="display:none" />
      <input id="user" type="text" />
    `);

    const fill = performAutofill(
      loginPayload({ password: "", customFields: [{ label: "member", value: "M-1" }] }),
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_LATE_FIELD_WINDOW_MS);
    byId("member").style.display = "";
    await settle(fill);

    expect(byId("member").value).toBe("");
  });

  it("does not write the TOTP into a masked one-time-code field", async () => {
    setupForm(`
      <input id="user" type="text" autocomplete="username" />
      <input id="otp" type="password" autocomplete="one-time-code" />
    `);

    await settle(performAutofill(loginPayload({ password: "", totpCode: "123456" })));

    expect(byId("otp").value).toBe("");
  });

  it("does not write the TOTP into a hidden one-time-code field", async () => {
    setupForm(`
      <input id="user" type="text" autocomplete="username" />
      <input id="otp" type="text" autocomplete="one-time-code" style="display:none" />
    `);

    await settle(performAutofill(loginPayload({ password: "", totpCode: "123456" })));

    expect(byId("otp").value).toBe("");
  });

  it("drops the password and TOTP references on exit", async () => {
    setupForm(`
      <input id="user" type="text" autocomplete="username" />
      <input id="pw" type="password" />
    `);
    const payload = loginPayload({ totpCode: "123456" });

    await settle(performAutofill(payload));

    expect(byId("pw").value).toBe("secret");
    expect(payload.password).toBe("");
    expect(payload.totpCode).toBe("");
  });

  // A visible foreign control in another section bounds the root to the login
  // section: a late password inside that section (outside the anchor's parent)
  // is written; the same late field beyond the foreign control is not.
  describe.each([
    {
      name: "SPA #app wrapper",
      html: `
        <div id="app">
          <section id="login"><div><input id="user" type="text" /></div><div id="slot"></div></section>
          <section id="other"><input id="search" type="text" /><div id="far"></div></section>
        </div>
      `,
    },
    {
      name: "page-wrapping <form>",
      html: `
        <form>
          <div id="login"><div><input id="user" type="text" /></div><div id="slot"></div></div>
          <div id="other"><input id="search" type="text" /><div id="far"></div></div>
        </form>
      `,
    },
  ])("root bounded by a foreign control ($name)", ({ html }) => {
    async function fillWithLatePasswordIn(slotId: string): Promise<HTMLInputElement> {
      setupForm(html);
      byId("user").focus();
      const fill = performAutofill(loginPayload());
      await vi.advanceTimersByTimeAsync(5);
      // Precondition: the foreign control is not a T0 target.
      expect(byId("search").value).toBe("");
      const late = addPassword(document.getElementById(slotId) as HTMLElement, "late");
      await settle(fill);
      return late;
    }

    it("writes a late password inside the root, outside the anchor's parent", async () => {
      expect((await fillWithLatePasswordIn("slot")).value).toBe("secret");
    });

    it("does not write a late password beyond the foreign control", async () => {
      expect((await fillWithLatePasswordIn("far")).value).toBe("");
    });
  });

  it("does not write a password decoy revealed outside the root after the username write", async () => {
    setupForm(`
      <div id="app">
        <section id="login"><input id="user" type="text" /></section>
        <section id="other">
          <input id="search" type="text" />
          <input id="decoy" type="password" style="display:none" />
        </section>
      </div>
    `);
    byId("user").addEventListener("input", () => {
      byId("decoy").style.display = "";
    });
    byId("user").focus();

    await settle(performAutofill(loginPayload()));

    expect(byId("user").value).toBe("alice");
    expect(byId("decoy").value).toBe("");
  });
});

