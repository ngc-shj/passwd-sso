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

// NF3 call-count test wraps the real ccFormFields in a spy; every other test
// in this file gets the unchanged implementation (importOriginal).
vi.mock("../../content/cc-field-detection-lib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../content/cc-field-detection-lib")>();
  return { ...actual, ccFormFields: vi.fn(actual.ccFormFields) };
});
import { ccFormFields } from "../../content/cc-field-detection-lib";

// Existing rows assert T0 targets only: a zero late-field window keeps them free
// of the deferral wait (every T0 target is still written).
const NO_WAIT = { lateFieldWindowMs: 0 };
// The jsdom page's host. The content frame gate (isFrameAllowedToFill) fills
// only a frame whose host is in allowedHosts, so a payload meant to fill names it.
const PAGE_HOST = new URL(window.location.href).hostname;

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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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
      allowedHosts: [PAGE_HOST],
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

  // Simulate the top frame (window.top === window.self, unchanged) at a given
  // location and/or self.origin. jsdom's self.origin does not follow a
  // window.location override, so the two are set independently; a row that
  // does not need one leaves it at the jsdom default (http://localhost:3000).
  async function inTopFrame(
    { href, origin }: { href?: string; origin?: string },
    run: () => Promise<void>,
  ) {
    const originalLocation = window.location;
    const originalOrigin = self.origin;
    if (href !== undefined) {
      Object.defineProperty(window, "location", { configurable: true, value: new URL(href) });
    }
    if (origin !== undefined) {
      Object.defineProperty(window, "origin", { configurable: true, value: origin });
    }
    try {
      await run();
    } finally {
      if (href !== undefined) {
        Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
      }
      if (origin !== undefined) {
        Object.defineProperty(window, "origin", { configurable: true, value: originalOrigin });
      }
    }
  }

  it("does NOT fill the top frame when neither allowedHosts nor topFrameOrigin matches", async () => {
    // Default jsdom context is the top frame (window.top === window.self).
    // C4 removed the unconditional top-frame pass: a top frame now self-checks
    // like any other frame.
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
    expect((inputs[1] as HTMLInputElement).value).toBe("");
  });

  // C4 acceptance table.
  it("top frame on evil.example with allowedHosts [bank.example] and no topFrameOrigin: no write", async () => {
    setupForm(`
      <input type="text" autocomplete="username" />
      <input type="password" autocomplete="current-password" />
    `);

    await inTopFrame({ href: "https://evil.example/" }, async () => {
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

  it("top frame on evil.example with topFrameOrigin https://evil.example: writes", async () => {
    setupForm(`
      <input type="text" autocomplete="username" />
      <input type="password" autocomplete="current-password" />
    `);

    await inTopFrame({ origin: "https://evil.example" }, async () => {
      await performAutofill({
        type: "AUTOFILL_FILL",
        username: "alice",
        password: "secret",
        topFrameOrigin: "https://evil.example",
      }, NO_WAIT);
    });

    const inputs = document.querySelectorAll("input");
    expect((inputs[1] as HTMLInputElement).value).toBe("secret");
  });

  it("top frame with an http self.origin against an https topFrameOrigin: no write", async () => {
    setupForm(`
      <input type="text" autocomplete="username" />
      <input type="password" autocomplete="current-password" />
    `);

    await inTopFrame({ origin: "http://bank.example" }, async () => {
      await performAutofill({
        type: "AUTOFILL_FILL",
        username: "alice",
        password: "secret",
        topFrameOrigin: "https://bank.example",
      }, NO_WAIT);
    });

    const inputs = document.querySelectorAll("input");
    expect((inputs[1] as HTMLInputElement).value).toBe("");
  });

  it("top frame on evil.bank.example with allowedHosts [other.example] and topFrameOrigin https://bank.example: no write (exact origin, not isHostMatch)", async () => {
    setupForm(`
      <input type="text" autocomplete="username" />
      <input type="password" autocomplete="current-password" />
    `);

    await inTopFrame(
      { href: "https://evil.bank.example/", origin: "https://evil.bank.example" },
      async () => {
        await performAutofill({
          type: "AUTOFILL_FILL",
          username: "alice",
          password: "secret",
          allowedHosts: ["other.example"],
          topFrameOrigin: "https://bank.example",
        }, NO_WAIT);
      },
    );

    const inputs = document.querySelectorAll("input");
    expect((inputs[1] as HTMLInputElement).value).toBe("");
  });

  it("top frame on the entry host with allowedHosts: writes", async () => {
    // jsdom's default top-frame host (localhost) is the entry host here.
    setupForm(`
      <input type="text" autocomplete="username" />
      <input type="password" autocomplete="current-password" />
    `);

    await performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
      allowedHosts: [PAGE_HOST],
    }, NO_WAIT);

    const inputs = document.querySelectorAll("input");
    expect((inputs[1] as HTMLInputElement).value).toBe("secret");
  });

  it("subframe on evil.example with allowedHosts [bank.example] and topFrameOrigin https://evil.example: no write", async () => {
    // A subframe ignores topFrameOrigin entirely (C4).
    setupForm(`
      <input type="text" autocomplete="username" />
      <input type="password" autocomplete="current-password" />
    `);

    await inSubframe("https://evil.example/iframe", async () => {
      await performAutofill({
        type: "AUTOFILL_FILL",
        username: "alice",
        password: "secret",
        allowedHosts: ["bank.example"],
        topFrameOrigin: "https://evil.example",
      }, NO_WAIT);
    });

    const inputs = document.querySelectorAll("input");
    expect((inputs[1] as HTMLInputElement).value).toBe("");
  });

  // C4: an insecure http frame fills only on a host the entry was saved for
  // over http (allowedHttpHosts). Each pair differs on that field alone.
  const LOGIN_FORM = `
    <input type="text" autocomplete="username" />
    <input type="password" autocomplete="current-password" />
  `;
  const writtenPassword = () => (document.querySelectorAll("input")[1] as HTMLInputElement).value;

  it.each([
    { allowedHttpHosts: undefined, written: "" },
    { allowedHttpHosts: [] as string[], written: "" },
    { allowedHttpHosts: ["other.example"], written: "" },
    { allowedHttpHosts: ["bank.example"], written: "secret" },
  ])(
    "C4: an http subframe on a matching allowedHosts host with allowedHttpHosts $allowedHttpHosts writes '$written'",
    async ({ allowedHttpHosts, written }) => {
      setupForm(LOGIN_FORM);

      await inSubframe("http://bank.example/login", async () => {
        await performAutofill({
          type: "AUTOFILL_FILL",
          username: "alice",
          password: "secret",
          allowedHosts: ["bank.example"],
          ...(allowedHttpHosts ? { allowedHttpHosts } : {}),
        }, NO_WAIT);
      });

      expect(writtenPassword()).toBe(written);
    },
  );

  // The top-frame arm (a hostless or mismatched entry the user confirmed) is
  // held to the same http rule.
  it.each([
    { allowedHttpHosts: undefined, written: "" },
    { allowedHttpHosts: ["bank.example"], written: "secret" },
  ])(
    "C4: the top-frame topFrameOrigin arm on an http page with allowedHttpHosts $allowedHttpHosts writes '$written'",
    async ({ allowedHttpHosts, written }) => {
      setupForm(LOGIN_FORM);

      await inTopFrame({ href: "http://bank.example/login", origin: "http://bank.example" }, async () => {
        await performAutofill({
          type: "AUTOFILL_FILL",
          username: "alice",
          password: "secret",
          topFrameOrigin: "http://bank.example",
          ...(allowedHttpHosts ? { allowedHttpHosts } : {}),
        }, NO_WAIT);
      });

      expect(writtenPassword()).toBe(written);
    },
  );

  // An about:blank or srcdoc frame has no URL host; the origin it inherits
  // from an http creator makes it an insecure page all the same.
  it.each([
    { allowedHttpHosts: undefined, written: "" },
    { allowedHttpHosts: ["bank.example"], written: "secret" },
  ])(
    "C4: a top-level about:blank inheriting http://bank.example with allowedHttpHosts $allowedHttpHosts writes '$written'",
    async ({ allowedHttpHosts, written }) => {
      setupForm(LOGIN_FORM);

      await inTopFrame({ href: "about:blank", origin: "http://bank.example" }, async () => {
        await performAutofill({
          type: "AUTOFILL_FILL",
          username: "alice",
          password: "secret",
          topFrameOrigin: "http://bank.example",
          ...(allowedHttpHosts ? { allowedHttpHosts } : {}),
        }, NO_WAIT);
      });

      expect(writtenPassword()).toBe(written);
    },
  );

  // localhost and 127.0.0.1 are not insecure pages: no http host is needed
  // there (the http://bank.example rows above are the deny side).
  it.each(["http://localhost:3000/login", "http://127.0.0.1:8080/login"])(
    "C4: %s fills on allowedHosts alone",
    async (href) => {
      setupForm(LOGIN_FORM);

      await inSubframe(href, async () => {
        await performAutofill({
          type: "AUTOFILL_FILL",
          username: "alice",
          password: "secret",
          allowedHosts: [new URL(href).hostname],
        }, NO_WAIT);
      });

      expect(writtenPassword()).toBe("secret");
    },
  );
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
    allowedHosts: [PAGE_HOST],
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

  async function settle(fill: Promise<unknown>): Promise<void> {
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

    // The second request arrives while the first run's password step is waiting.
    const writes: string[] = [];
    const pw = addPassword(document.getElementById("login") as HTMLElement, "pw");
    pw.addEventListener("input", () => writes.push(pw.value));
    await settle(Promise.all([first, second]).then(() => {}));

    expect(writes).toEqual(["second-pw"]);
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

  // Sony Bank login shape: no <form>, two custom ID fields, then the password.
  // A page handler on one write changes the page before the next write's turn.
  const SONY_SHAPE = `
    <input id="brchNum" type="text" />
    <input id="accountNum" type="text" />
    <input id="loginPwd_inputPass" type="password" name="loginPwd" />
  `;
  const SONY_CUSTOM_FIELDS = [
    { label: "brchNum", value: "123" },
    { label: "accountNum", value: "4567890" },
  ];
  const fillSony = () =>
    settle(performAutofill(loginPayload({ username: "", password: "pw", customFields: SONY_CUSTOM_FIELDS })));

  it("writes the Sony-shaped custom fields, then the password, one field per task", async () => {
    setupForm(SONY_SHAPE);
    const log: string[] = [];
    for (const el of document.querySelectorAll("input")) {
      el.addEventListener("input", () => log.push(el.id));
    }
    // A task queued by the first write runs before the second write only if the
    // fill yields a macrotask between fields.
    byId("brchNum").addEventListener("input", () => setTimeout(() => log.push("task"), 0), { once: true });

    await fillSony();

    expect(log).toEqual(["brchNum", "task", "accountNum", "loginPwd_inputPass"]);
    expect(byId("brchNum").value).toBe("123");
    expect(byId("accountNum").value).toBe("4567890");
    expect(byId("loginPwd_inputPass").value).toBe("pw");
  });

  it("does not write a target the page detached before its turn", async () => {
    setupForm(SONY_SHAPE);
    const account = byId("accountNum");
    byId("brchNum").addEventListener("input", () => account.remove(), { once: true });

    await fillSony();

    expect(account.value).toBe("");
    expect(byId("loginPwd_inputPass").value).toBe("pw");
  });

  it("does not write a password whose type the page changed before its turn", async () => {
    setupForm(SONY_SHAPE);
    const password = byId("loginPwd_inputPass");
    byId("accountNum").addEventListener("input", () => (password.type = "text"), { once: true });

    await fillSony();

    expect(byId("accountNum").value).toBe("4567890");
    expect(password.value).toBe("");
  });

  it.each([
    ["does not write", "hidden", ""],
    ["writes (control)", "text", "1234"],
  ])("%s a custom field into a %s-type input that matches its label", async (_verb, type, expected) => {
    setupForm(`
      <input id="pin" type="${type}" />
      <input id="user" type="text" />
    `);

    await settle(
      performAutofill(loginPayload({ password: "", customFields: [{ label: "pin", value: "1234" }] })),
    );

    expect(byId("pin").value).toBe(expected);
  });

  it("writes a custom field into the text input when a password input earlier shares its label", async () => {
    setupForm(`
      <input name="pin" type="password" />
      <input id="target" name="pin" type="text" />
    `);

    await settle(
      performAutofill(loginPayload({ username: "", password: "", customFields: [{ label: "pin", value: "123" }] })),
    );

    expect(byId("target").value).toBe("123");
  });

  it("leaves to a custom field the input it reserved, and picks the username elsewhere", async () => {
    // The reserved input is username-like and sits nearest the password, where
    // the username walk would otherwise land. Writes are write-once, so without
    // the reservation the username step would hit the already-written field and
    // #user would stay empty.
    setupForm(`
      <input id="user" type="text" />
      <input id="member-id" type="text" />
      <input id="pw" type="password" />
    `);

    await settle(
      performAutofill(loginPayload({ password: "pw", customFields: [{ label: "member-id", value: "M-1" }] })),
    );

    expect(byId("member-id").value).toBe("M-1");
    expect(byId("user").value).toBe("alice");
    expect(byId("pw").value).toBe("pw");
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

  // The dropdown opens on OTP fields and OTP pages autofocus them, so the focused
  // or hinted field is often the OTP field; it is reserved for the code.
  it("writes the TOTP into a focused single OTP field, not the username", async () => {
    setupForm(`<input id="otp" type="text" autocomplete="one-time-code" />`);
    byId("otp").focus();

    await settle(
      performAutofill(
        loginPayload({ password: "", totpCode: "123456", targetHint: { id: "otp" } }),
      ),
    );

    expect(byId("otp").value).toBe("123456");
  });

  it("writes the first digit into a focused first box of a split OTP group", async () => {
    setupForm(`
      <form>${Array.from({ length: 6 }, (_, i) => `<input id="d${i}" type="text" maxlength="1" />`).join("")}</form>
    `);
    byId("d0").focus();

    await settle(
      performAutofill(loginPayload({ password: "", totpCode: "123456", targetHint: { id: "d0" } })),
    );

    expect(Array.from({ length: 6 }, (_, i) => byId(`d${i}`).value).join("")).toBe("123456");
  });

  it("does not write the username into a reserved OTP field when another username field exists", async () => {
    setupForm(`
      <form>
        <input id="user" type="text" name="username" />
        <input id="pw" type="password" />
        <input id="otp" type="text" autocomplete="one-time-code" />
      </form>
    `);
    byId("otp").focus();

    await settle(performAutofill(loginPayload({ totpCode: "123456" })));

    expect(byId("user").value).toBe("alice");
    expect(byId("pw").value).toBe("secret");
    expect(byId("otp").value).toBe("123456");
  });

  // Without focus or a hint, the username search walks back from the password;
  // an OTP field labelled like an account field must still get the code.
  it("does not pick a reserved OTP field as the username when nothing is focused", async () => {
    setupForm(`
      <input id="mfa" type="text" aria-label="Account MFA" />
      <input id="pw" type="password" />
    `);

    await settle(performAutofill(loginPayload({ totpCode: "123456" })));

    expect(byId("mfa").value).toBe("123456");
    expect(byId("pw").value).toBe("secret");
  });

  it.each(["username", "email"])("keeps a focused autocomplete=%s field whose name contains 'otp' as the username", async (autocomplete) => {
    setupForm(`
      <input id="user" type="text" name="hotpepper_id" autocomplete="${autocomplete}" />
      <input id="pw" type="password" />
    `);
    byId("user").focus();

    await settle(performAutofill(loginPayload({ totpCode: "123456" })));

    expect(byId("user").value).toBe("alice");
    expect(byId("pw").value).toBe("secret");
  });

  // Sony Bank: 口座番号 is the entry's username and is labelled only through
  // aria-labelledby; with the password focused (the popup case) the username
  // search must still find it from the referenced label text.
  it("writes the username into a field labelled through aria-labelledby when nothing usable is focused", async () => {
    setupForm(`
      <div><span id="brchNum_label">店番号</span><input id="brchNum" type="text" aria-labelledby="brchNum_label" /></div>
      <div><span id="accountNum_label">口座番号</span><input id="accountNum" type="text" aria-labelledby="accountNum_label" /></div>
      <div><span id="loginPwd_label">ログインパスワード</span><input id="pw" type="password" aria-labelledby="loginPwd_label" /></div>
    `);
    byId("pw").focus();

    await settle(
      performAutofill(
        loginPayload({ username: "4567890", customFields: [{ label: "brchNum", value: "001" }] }),
      ),
    );

    expect(byId("brchNum").value).toBe("001");
    expect(byId("accountNum").value).toBe("4567890");
    expect(byId("pw").value).toBe("secret");
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

// ── CC field exclusion in fill (plan FR1-FR4, C3) ─────────────

function byName(name: string): HTMLInputElement {
  const el = document.querySelector(`[name="${name}"]`);
  if (!(el instanceof HTMLInputElement)) throw new Error(`fixture missing input[name=${name}]`);
  return el;
}

describe("performAutofill — CC field exclusion", () => {
  it("fills the login password, not the masked card CVV (claim-stealing by position)", async () => {
    setupForm(`
      <input type="text" name="username" />
      <input type="password" name="password" />
      <div id="card">
        <input name="cardNumber" />
        <input type="password" name="cvv" />
      </div>
    `);

    await performAutofill({
      type: AUTOFILL_FILL,
      allowedHosts: [PAGE_HOST],
      username: "alice",
      password: "secret",
    }, NO_WAIT);

    expect(byName("password").value).toBe("secret");
    expect(byName("cvv").value).toBe("");
  });

  it("allow: the same page without a card number keeps today's last-password choice", async () => {
    setupForm(`
      <input type="text" name="username" />
      <input type="password" name="password" />
      <div id="card">
        <input type="password" name="cvv" />
      </div>
    `);

    await performAutofill({
      type: AUTOFILL_FILL,
      allowedHosts: [PAGE_HOST],
      username: "alice",
      password: "secret",
    }, NO_WAIT);

    // No card number anywhere on the page: FR3 keeps the pre-fix "last
    // visible password wins" heuristic exactly, even though the field is
    // still named "cvv".
    expect(byName("cvv").value).toBe("secret");
    expect(byName("password").value).toBe("");
  });

  it("FR2: fills a card-form field whose autocomplete explicitly declares current-password", async () => {
    setupForm(`
      <input type="text" name="username" />
      <div id="card">
        <input name="cardNumber" />
        <input type="password" name="cvv" autocomplete="current-password" />
      </div>
    `);

    await performAutofill({
      type: AUTOFILL_FILL,
      allowedHosts: [PAGE_HOST],
      username: "alice",
      password: "secret",
    }, NO_WAIT);

    expect(byName("cvv").value).toBe("secret");
  });

  it("FR4: a login password named security_code is filled, and the card CVV stays empty (claim-stealing)", async () => {
    setupForm(`
      <div id="login">
        <input type="text" name="username" />
        <input type="password" name="security_code" />
      </div>
      <div id="card">
        <input name="cardNumber" />
        <input type="password" name="cvv" />
      </div>
    `);

    await performAutofill({
      type: AUTOFILL_FILL,
      allowedHosts: [PAGE_HOST],
      username: "alice",
      password: "secret",
    }, NO_WAIT);

    expect(byName("security_code").value).toBe("secret");
    expect(byName("cvv").value).toBe("");
  });

  it("allow: the same claim-stealing page without a card number keeps today's choice", async () => {
    setupForm(`
      <div id="login">
        <input type="text" name="username" />
        <input type="password" name="security_code" />
      </div>
      <div id="card">
        <input type="password" name="cvv" />
      </div>
    `);

    await performAutofill({
      type: AUTOFILL_FILL,
      allowedHosts: [PAGE_HOST],
      username: "alice",
      password: "secret",
    }, NO_WAIT);

    expect(byName("cvv").value).toBe("secret");
    expect(byName("security_code").value).toBe("");
  });

  it("split OTP security-code-0..5 fill in the login form; the card form's セキュリティコード CVV elsewhere is not the target", async () => {
    setupForm(`
      <div id="login">
        <input type="text" name="username" />
        <input type="password" name="password" />
        <section>
          <input type="text" name="security-code-0" />
          <input type="text" name="security-code-1" />
          <input type="text" name="security-code-2" />
          <input type="text" name="security-code-3" />
          <input type="text" name="security-code-4" />
          <input type="text" name="security-code-5" />
        </section>
      </div>
      <div id="card">
        <input name="cardNumber" />
        <input type="text" name="cvv" placeholder="セキュリティコード" />
      </div>
    `);

    await performAutofill({
      type: AUTOFILL_FILL,
      allowedHosts: [PAGE_HOST],
      username: "alice",
      password: "secret",
      totpCode: "314159",
    }, NO_WAIT);

    expect(byName("username").value).toBe("alice");
    expect(byName("password").value).toBe("secret");
    expect(byName("security-code-0").value).toBe("3");
    expect(byName("security-code-1").value).toBe("1");
    expect(byName("security-code-2").value).toBe("4");
    expect(byName("security-code-3").value).toBe("1");
    expect(byName("security-code-4").value).toBe("5");
    expect(byName("security-code-5").value).toBe("9");
    expect(byName("cvv").value).toBe("");
  });

  it("three password fields: last eligible (the unrelated field) over the card CVV", async () => {
    setupForm(`
      <input type="text" name="username" />
      <input type="password" name="password" />
      <input type="password" name="other-masked" />
      <div id="card">
        <input name="cardNumber" />
        <input type="password" name="cvv" />
      </div>
    `);

    await performAutofill({
      type: AUTOFILL_FILL,
      allowedHosts: [PAGE_HOST],
      username: "alice",
      password: "secret",
    }, NO_WAIT);

    expect(byName("other-masked").value).toBe("secret");
    expect(byName("password").value).toBe("");
    expect(byName("cvv").value).toBe("");
  });
});

// ── NF3: ccFormFields is called once at T0 and at most once per tick ──

describe("performAutofill — NF3 ccFormFields call count", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.mocked(ccFormFields).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
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

  it("a multi-relocate fill calls ccFormFields once at T0 and at most once per relocate tick", async () => {
    setupForm(`<div id="login"><input id="user" type="text" /></div>`);
    byId("user").focus();

    const fill = performAutofill({
      type: AUTOFILL_FILL,
      allowedHosts: [PAGE_HOST],
      username: "",
      password: "secret",
    });

    // Tick 1: the password step is deferred (no password field yet). Its
    // relocate fails, but still scans the root through the per-tick memo.
    await vi.advanceTimersByTimeAsync(5);

    const pw = addPassword(document.getElementById("login") as HTMLElement, "pw");

    // Tick 2: relocate now succeeds and writes pw — the memo is cleared
    // between ticks (queueMicrotask), so this is a fresh call, not a reuse
    // of tick 1's cached set.
    await vi.advanceTimersByTimeAsync(DEFAULT_LATE_FIELD_WINDOW_MS + 100);
    await fill;

    expect(pw.value).toBe("secret");
    // 1 (T0) + 1 (tick 1, failed relocate) + 1 (tick 2, successful relocate).
    // A positive, bounded count: not zero (the scan did run on both ticks
    // that needed it), and not growing with the 3-then-4 candidate inputs
    // each tick examined (the per-tick-memo-removed mutation would instead
    // call it once per candidate input per tick).
    expect(vi.mocked(ccFormFields)).toHaveBeenCalledTimes(3);
  });
});
