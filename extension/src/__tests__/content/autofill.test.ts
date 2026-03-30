/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { performAutofill } from "../../content/autofill-lib";

function setupForm(html: string) {
  document.body.innerHTML = html;
}

describe("performAutofill", () => {
  it("fills inputs with autocomplete attributes", () => {
    setupForm(`
      <input type="text" autocomplete="username" />
      <input type="password" autocomplete="current-password" />
    `);

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
    });

    const inputs = document.querySelectorAll("input");
    expect((inputs[0] as HTMLInputElement).value).toBe("alice");
    expect((inputs[1] as HTMLInputElement).value).toBe("secret");
  });

  it("falls back to last password input and previous text input", () => {
    setupForm(`
      <input type="text" id="user" />
      <input type="password" id="pw1" />
      <input type="password" id="pw2" />
    `);

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "bob",
      password: "pw",
    });

    const user = document.getElementById("user") as HTMLInputElement;
    const pw2 = document.getElementById("pw2") as HTMLInputElement;
    expect(user.value).toBe("bob");
    expect(pw2.value).toBe("pw");
  });

  it("fills only password when username is empty", () => {
    setupForm(`
      <input type="text" id="user" />
      <input type="password" id="pw" />
    `);

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "",
      password: "secret",
    });

    const user = document.getElementById("user") as HTMLInputElement;
    const pw = document.getElementById("pw") as HTMLInputElement;
    expect(user.value).toBe("");
    expect(pw.value).toBe("secret");
  });

  it("fills id-like username field before password", () => {
    setupForm(`
      <input type="text" id="userId" name="userId" />
      <input type="password" id="pw" />
    `);

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "myjcb-user",
      password: "secret",
    });

    const user = document.getElementById("userId") as HTMLInputElement;
    const pw = document.getElementById("pw") as HTMLInputElement;
    expect(user.value).toBe("myjcb-user");
    expect(pw.value).toBe("secret");
  });

  it("fills focused text input first (inline dropdown selection case)", () => {
    setupForm(`
      <input type="text" id="focusedUser" />
      <input type="password" id="pw" />
    `);

    const focusedUser = document.getElementById("focusedUser") as HTMLInputElement;
    focusedUser.focus();

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "focus-user",
      password: "secret",
    });

    const pw = document.getElementById("pw") as HTMLInputElement;
    expect(focusedUser.value).toBe("focus-user");
    expect(pw.value).toBe("secret");
  });

  it("fills using target hint even when no field is focused", () => {
    setupForm(`
      <input type="text" id="userId" name="userId" />
      <input type="password" id="pw" />
    `);

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "hint-user",
      password: "secret",
      targetHint: { id: "userId", name: "userId", type: "text" },
    });

    const user = document.getElementById("userId") as HTMLInputElement;
    const pw = document.getElementById("pw") as HTMLInputElement;
    expect(user.value).toBe("hint-user");
    expect(pw.value).toBe("secret");
  });

  it("fills custom fields by matching label to input id", () => {
    setupForm(`
      <input id="brchNum" type="text" />
      <input id="user" type="text" name="username" />
      <input id="pw" type="password" />
    `);

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
      customFields: [{ label: "brchNum", value: "001" }],
    });

    expect((document.getElementById("brchNum") as HTMLInputElement).value).toBe("001");
    expect((document.getElementById("user") as HTMLInputElement).value).toBe("alice");
    expect((document.getElementById("pw") as HTMLInputElement).value).toBe("secret");
  });

  it("fills custom fields by matching label to input name (case-insensitive)", () => {
    setupForm(`
      <input type="text" name="AccountId" />
      <input id="user" type="text" name="username" />
      <input id="pw" type="password" />
    `);

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
      customFields: [{ label: "accountid", value: "123456789012" }],
    });

    expect((document.querySelector("[name=AccountId]") as HTMLInputElement).value).toBe("123456789012");
  });

  it("skips custom fields with no matching input", () => {
    setupForm(`
      <input id="user" type="text" name="username" />
      <input id="pw" type="password" />
    `);

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
      customFields: [{ label: "nonexistent", value: "ignored" }],
    });

    expect((document.getElementById("user") as HTMLInputElement).value).toBe("alice");
    expect((document.getElementById("pw") as HTMLInputElement).value).toBe("secret");
  });

  it("fills OTP field with autocomplete='one-time-code'", () => {
    setupForm(`
      <input type="text" id="user" name="username" />
      <input type="password" id="pw" />
      <input type="text" id="otp" autocomplete="one-time-code" />
    `);

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
      totpCode: "123456",
    });

    expect((document.getElementById("user") as HTMLInputElement).value).toBe("alice");
    expect((document.getElementById("pw") as HTMLInputElement).value).toBe("secret");
    expect((document.getElementById("otp") as HTMLInputElement).value).toBe("123456");
  });

  it("fills OTP field matched by hint pattern (name='otp-code')", () => {
    setupForm(`
      <input type="text" id="user" name="username" />
      <input type="password" id="pw" />
      <input type="text" id="otp" name="otp-code" />
    `);

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
      totpCode: "654321",
    });

    expect((document.getElementById("otp") as HTMLInputElement).value).toBe("654321");
  });

  it("fills OTP field matched by Japanese hint (placeholder='認証コード')", () => {
    setupForm(`
      <input type="text" id="user" name="username" />
      <input type="password" id="pw" />
      <input type="text" id="otp" placeholder="認証コード" />
    `);

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
      totpCode: "111222",
    });

    expect((document.getElementById("otp") as HTMLInputElement).value).toBe("111222");
  });

  it("does not fill OTP field when totpCode is undefined", () => {
    setupForm(`
      <input type="text" id="user" name="username" />
      <input type="password" id="pw" />
      <input type="text" id="otp" autocomplete="one-time-code" />
    `);

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
    });

    expect((document.getElementById("otp") as HTMLInputElement).value).toBe("");
  });

  it("username and password fill are unaffected by totpCode presence", () => {
    setupForm(`
      <input type="text" id="user" name="username" />
      <input type="password" id="pw" />
    `);

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
      totpCode: "123456",
    });

    expect((document.getElementById("user") as HTMLInputElement).value).toBe("alice");
    expect((document.getElementById("pw") as HTMLInputElement).value).toBe("secret");
  });

  it("does not overwrite password field when TOTP-only (no password)", () => {
    setupForm(`
      <input type="text" id="user" name="username" />
      <input type="password" id="pw" value="existing-password" />
      <input type="text" id="otp" autocomplete="one-time-code" />
    `);

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "",
      totpCode: "123456",
    });

    expect((document.getElementById("pw") as HTMLInputElement).value).toBe("existing-password");
    expect((document.getElementById("otp") as HTMLInputElement).value).toBe("123456");
  });

  it("does not overwrite password field when password is undefined", () => {
    setupForm(`
      <input type="text" id="user" name="username" />
      <input type="password" id="pw" value="existing-password" />
      <input type="text" id="otp" autocomplete="one-time-code" />
    `);

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "",
      password: "",
      totpCode: "654321",
    });

    expect((document.getElementById("pw") as HTMLInputElement).value).toBe("existing-password");
    expect((document.getElementById("otp") as HTMLInputElement).value).toBe("654321");
  });

  it("prefers OTP field in same form over OTP field in another form", () => {
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

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
      totpCode: "999888",
    });

    expect((document.getElementById("otp-same") as HTMLInputElement).value).toBe("999888");
    expect((document.getElementById("otp-other") as HTMLInputElement).value).toBe("");
  });

  it("distributes TOTP digits across 6 split single-digit fields (maxLength=1)", () => {
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

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
      totpCode: "123456",
    });

    expect((document.getElementById("d1") as HTMLInputElement).value).toBe("1");
    expect((document.getElementById("d2") as HTMLInputElement).value).toBe("2");
    expect((document.getElementById("d3") as HTMLInputElement).value).toBe("3");
    expect((document.getElementById("d4") as HTMLInputElement).value).toBe("4");
    expect((document.getElementById("d5") as HTMLInputElement).value).toBe("5");
    expect((document.getElementById("d6") as HTMLInputElement).value).toBe("6");
  });

  it("distributes TOTP digits across split fields with type='tel'", () => {
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

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "",
      password: "",
      totpCode: "987654",
    });

    expect((document.getElementById("d1") as HTMLInputElement).value).toBe("9");
    expect((document.getElementById("d2") as HTMLInputElement).value).toBe("8");
    expect((document.getElementById("d3") as HTMLInputElement).value).toBe("7");
    expect((document.getElementById("d4") as HTMLInputElement).value).toBe("6");
    expect((document.getElementById("d5") as HTMLInputElement).value).toBe("5");
    expect((document.getElementById("d6") as HTMLInputElement).value).toBe("4");
  });

  it("prefers split OTP fields over a single OTP field when both exist", () => {
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

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "",
      password: "",
      totpCode: "111222",
    });

    expect((document.getElementById("otp-single") as HTMLInputElement).value).toBe("");
    expect((document.getElementById("d1") as HTMLInputElement).value).toBe("1");
    expect((document.getElementById("d2") as HTMLInputElement).value).toBe("1");
    expect((document.getElementById("d3") as HTMLInputElement).value).toBe("1");
    expect((document.getElementById("d4") as HTMLInputElement).value).toBe("2");
    expect((document.getElementById("d5") as HTMLInputElement).value).toBe("2");
    expect((document.getElementById("d6") as HTMLInputElement).value).toBe("2");
  });

  it("falls back to single field when split fields count does not match code length", () => {
    setupForm(`
      <input type="text" id="otp" autocomplete="one-time-code" />
      <section>
        <input type="text" id="d1" maxlength="1" />
        <input type="text" id="d2" maxlength="1" />
        <input type="text" id="d3" maxlength="1" />
        <input type="text" id="d4" maxlength="1" />
      </section>
    `);

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "",
      password: "",
      totpCode: "123456",
    });

    expect((document.getElementById("otp") as HTMLInputElement).value).toBe("123456");
    expect((document.getElementById("d1") as HTMLInputElement).value).toBe("");
  });

  it("does not treat non-maxLength-1 inputs as split OTP fields", () => {
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

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "",
      password: "",
      totpCode: "123456",
    });

    expect((document.getElementById("otp") as HTMLInputElement).value).toBe("123456");
  });

  it("distributes TOTP across indexed name fields (otp-code-0…5)", () => {
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

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "",
      password: "",
      totpCode: "314159",
    });

    expect((document.getElementById("d0") as HTMLInputElement).value).toBe("3");
    expect((document.getElementById("d1") as HTMLInputElement).value).toBe("1");
    expect((document.getElementById("d2") as HTMLInputElement).value).toBe("4");
    expect((document.getElementById("d3") as HTMLInputElement).value).toBe("1");
    expect((document.getElementById("d4") as HTMLInputElement).value).toBe("5");
    expect((document.getElementById("d5") as HTMLInputElement).value).toBe("9");
  });

  it("skips disabled field and falls back to single OTP", () => {
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

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "",
      password: "",
      totpCode: "123456",
    });

    expect((document.getElementById("otp") as HTMLInputElement).value).toBe("123456");
    expect((document.getElementById("d1") as HTMLInputElement).value).toBe("");
  });

  it("distributes 8-digit TOTP across 8 split fields", () => {
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

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "",
      password: "",
      totpCode: "12345678",
    });

    expect((document.getElementById("d1") as HTMLInputElement).value).toBe("1");
    expect((document.getElementById("d2") as HTMLInputElement).value).toBe("2");
    expect((document.getElementById("d3") as HTMLInputElement).value).toBe("3");
    expect((document.getElementById("d4") as HTMLInputElement).value).toBe("4");
    expect((document.getElementById("d5") as HTMLInputElement).value).toBe("5");
    expect((document.getElementById("d6") as HTMLInputElement).value).toBe("6");
    expect((document.getElementById("d7") as HTMLInputElement).value).toBe("7");
    expect((document.getElementById("d8") as HTMLInputElement).value).toBe("8");
  });

  it("handles split OTP fields in separate wrappers sharing a section ancestor", () => {
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

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "",
      password: "",
      totpCode: "654321",
    });

    expect((document.getElementById("d1") as HTMLInputElement).value).toBe("6");
    expect((document.getElementById("d2") as HTMLInputElement).value).toBe("5");
    expect((document.getElementById("d3") as HTMLInputElement).value).toBe("4");
    expect((document.getElementById("d4") as HTMLInputElement).value).toBe("3");
    expect((document.getElementById("d5") as HTMLInputElement).value).toBe("2");
    expect((document.getElementById("d6") as HTMLInputElement).value).toBe("1");
  });

  it("prefers form-scoped split OTP fields over global ones", () => {
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

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
      totpCode: "999888",
    });

    expect((document.getElementById("f1") as HTMLInputElement).value).toBe("9");
    expect((document.getElementById("f2") as HTMLInputElement).value).toBe("9");
    expect((document.getElementById("f3") as HTMLInputElement).value).toBe("9");
    expect((document.getElementById("f4") as HTMLInputElement).value).toBe("8");
    expect((document.getElementById("f5") as HTMLInputElement).value).toBe("8");
    expect((document.getElementById("f6") as HTMLInputElement).value).toBe("8");
    expect((document.getElementById("g1") as HTMLInputElement).value).toBe("");
  });

  it("does not group split fields across different forms", () => {
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

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "",
      password: "",
      totpCode: "123456",
    });

    // Different <form> ancestors prevent grouping, so falls back to single OTP
    expect((document.getElementById("otp") as HTMLInputElement).value).toBe("123456");
    expect((document.getElementById("a1") as HTMLInputElement).value).toBe("");
  });

  it("skips readOnly field and falls back to single OTP", () => {
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

    performAutofill({
      type: "AUTOFILL_FILL",
      username: "",
      password: "",
      totpCode: "123456",
    });

    expect((document.getElementById("otp") as HTMLInputElement).value).toBe("123456");
    expect((document.getElementById("d1") as HTMLInputElement).value).toBe("");
  });
});
