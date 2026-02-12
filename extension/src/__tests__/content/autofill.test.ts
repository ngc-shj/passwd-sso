/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { performAutofill } from "../../content/autofill";

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
});
