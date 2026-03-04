/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from "vitest";
import { performIdentityAutofill } from "../../content/autofill-identity-lib";

beforeEach(() => {
  Object.defineProperty(navigator, "language", {
    value: "en-US",
    configurable: true,
  });
});

function setupForm(html: string) {
  document.body.innerHTML = html;
}

describe("performIdentityAutofill", () => {
  it("fills fields by autocomplete attributes", () => {
    setupForm(`
      <input autocomplete="name" />
      <input autocomplete="address-line1" />
      <input autocomplete="tel" />
      <input autocomplete="email" />
    `);

    performIdentityAutofill({
      type: "AUTOFILL_IDENTITY_FILL",
      fullName: "Jane Doe",
      address: "123 Main St",
      phone: "555-1234",
      email: "jane@example.com",
      dateOfBirth: "",
      nationality: "",
      idNumber: "",
    });

    const inputs = document.querySelectorAll("input");
    expect((inputs[0] as HTMLInputElement).value).toBe("Jane Doe");
    expect((inputs[1] as HTMLInputElement).value).toBe("123 Main St");
    expect((inputs[2] as HTMLInputElement).value).toBe("555-1234");
    expect((inputs[3] as HTMLInputElement).value).toBe("jane@example.com");
  });

  it("fills region select element", () => {
    setupForm(`
      <input autocomplete="name" />
      <input autocomplete="tel" />
      <select autocomplete="address-level1">
        <option value="">Select</option>
        <option value="CA">California</option>
        <option value="NY">New York</option>
      </select>
    `);

    performIdentityAutofill({
      type: "AUTOFILL_IDENTITY_FILL",
      fullName: "Jane Doe",
      address: "",
      phone: "555-1234",
      email: "",
      dateOfBirth: "",
      nationality: "CA",
      idNumber: "",
    });

    const regionSelect = document.querySelector('[autocomplete="address-level1"]') as HTMLSelectElement;
    expect(regionSelect.value).toBe("CA");
  });

  it("fills date of birth field", () => {
    setupForm(`
      <input autocomplete="name" />
      <input autocomplete="bday" />
    `);

    performIdentityAutofill({
      type: "AUTOFILL_IDENTITY_FILL",
      fullName: "Jane Doe",
      address: "",
      phone: "",
      email: "",
      dateOfBirth: "1990-01-15",
      nationality: "",
      idNumber: "",
    });

    const dobInput = document.querySelector('[autocomplete="bday"]') as HTMLInputElement;
    expect(dobInput.value).toBe("1990-01-15");
  });

  it("does not fill when fewer than 2 identity fields exist", () => {
    setupForm(`
      <input autocomplete="name" />
    `);

    performIdentityAutofill({
      type: "AUTOFILL_IDENTITY_FILL",
      fullName: "Jane Doe",
      address: "123 Main St",
      phone: "555-1234",
      email: "jane@example.com",
      dateOfBirth: "",
      nationality: "",
      idNumber: "",
    });

    const nameInput = document.querySelector('[autocomplete="name"]') as HTMLInputElement;
    expect(nameInput.value).toBe("");
  });

  it("skips display:none input (visibility check)", () => {
    setupForm(`
      <input autocomplete="name" />
      <input autocomplete="tel" />
      <input autocomplete="email" style="display: none" />
    `);

    performIdentityAutofill({
      type: "AUTOFILL_IDENTITY_FILL",
      fullName: "Jane Doe",
      address: "",
      phone: "555-1234",
      email: "hidden@example.com",
      dateOfBirth: "",
      nationality: "",
      idNumber: "",
    });

    const emailInput = document.querySelector('[autocomplete="email"]') as HTMLInputElement;
    expect(emailInput.value).toBe("");
  });

  it("skips visibility:hidden input (visibility check)", () => {
    setupForm(`
      <input autocomplete="name" />
      <input autocomplete="tel" style="visibility: hidden" />
      <input autocomplete="email" />
    `);

    performIdentityAutofill({
      type: "AUTOFILL_IDENTITY_FILL",
      fullName: "Jane Doe",
      address: "",
      phone: "555-1234",
      email: "jane@example.com",
      dateOfBirth: "",
      nationality: "",
      idNumber: "",
    });

    const phoneInput = document.querySelector('[autocomplete="tel"]') as HTMLInputElement;
    expect(phoneInput.value).toBe("");
  });

  it("does not fill login fields when identity autofill runs (non-destructive)", () => {
    setupForm(`
      <input type="text" autocomplete="username" />
      <input type="password" autocomplete="current-password" />
      <input autocomplete="name" />
      <input autocomplete="tel" />
      <input autocomplete="email" />
    `);

    performIdentityAutofill({
      type: "AUTOFILL_IDENTITY_FILL",
      fullName: "Jane Doe",
      address: "",
      phone: "555-1234",
      email: "jane@example.com",
      dateOfBirth: "",
      nationality: "",
      idNumber: "",
    });

    const usernameInput = document.querySelector('[autocomplete="username"]') as HTMLInputElement;
    const passwordInput = document.querySelector('[autocomplete="current-password"]') as HTMLInputElement;
    expect(usernameInput.value).toBe("");
    expect(passwordInput.value).toBe("");
  });

  it("fills fields detected by Japanese labels", () => {
    setupForm(`
      <label for="name">氏名</label>
      <input id="name" type="text" />
      <label for="addr">住所</label>
      <input id="addr" type="text" />
      <label for="tel">電話</label>
      <input id="tel" type="text" />
    `);

    performIdentityAutofill({
      type: "AUTOFILL_IDENTITY_FILL",
      fullName: "山田太郎",
      address: "東京都渋谷区1-2-3",
      phone: "03-1234-5678",
      email: "",
      dateOfBirth: "",
      nationality: "",
      idNumber: "",
    });

    const nameInput = document.getElementById("name") as HTMLInputElement;
    const addrInput = document.getElementById("addr") as HTMLInputElement;
    const telInput = document.getElementById("tel") as HTMLInputElement;
    expect(nameInput.value).toBe("山田太郎");
    expect(addrInput.value).toBe("東京都渋谷区1-2-3");
    expect(telInput.value).toBe("03-1234-5678");
  });
});
