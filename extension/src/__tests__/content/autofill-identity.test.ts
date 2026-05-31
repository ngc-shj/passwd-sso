/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from "vitest";
import { performIdentityAutofill } from "../../content/autofill-identity-lib";
import { EXT_MSG } from "../../lib/constants";
import type { IdentityAutofillPayload } from "../../types/messages";

// Polyfill CSS.escape for jsdom (label[for=...] lookups)
if (typeof globalThis.CSS === "undefined") {
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
}

beforeEach(() => {
  Object.defineProperty(navigator, "language", {
    value: "en-US",
    configurable: true,
  });
});

function setupForm(html: string) {
  document.body.innerHTML = html;
}

function payload(
  overrides: Partial<IdentityAutofillPayload>,
): IdentityAutofillPayload {
  return {
    type: EXT_MSG.AUTOFILL_IDENTITY_FILL,
    fullName: "",
    givenName: "",
    familyName: "",
    familyNameKana: "",
    givenNameKana: "",
    address: "",
    addressLine2: "",
    city: "",
    state: "",
    postalCode: "",
    country: "",
    phone: "",
    email: "",
    dateOfBirth: "",
    nationality: "",
    idNumber: "",
    ...overrides,
  };
}

describe("performIdentityAutofill", () => {
  it("fills fields by autocomplete attributes", () => {
    setupForm(`
      <input autocomplete="name" />
      <input autocomplete="address-line1" />
      <input autocomplete="tel" />
      <input autocomplete="email" />
    `);

    performIdentityAutofill(
      payload({
        fullName: "Jane Doe",
        address: "123 Main St",
        phone: "555-1234",
        email: "jane@example.com",
      }),
    );

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

    performIdentityAutofill(
      payload({ fullName: "Jane Doe", phone: "555-1234", nationality: "CA" }),
    );

    const regionSelect = document.querySelector('[autocomplete="address-level1"]') as HTMLSelectElement;
    expect(regionSelect.value).toBe("CA");
  });

  it("fills date of birth field", () => {
    setupForm(`
      <input autocomplete="name" />
      <input autocomplete="bday" />
    `);

    performIdentityAutofill(
      payload({ fullName: "Jane Doe", dateOfBirth: "1990-01-15" }),
    );

    const dobInput = document.querySelector('[autocomplete="bday"]') as HTMLInputElement;
    expect(dobInput.value).toBe("1990-01-15");
  });

  it("does not fill when fewer than 2 identity fields exist", () => {
    setupForm(`
      <input autocomplete="name" />
    `);

    performIdentityAutofill(
      payload({
        fullName: "Jane Doe",
        address: "123 Main St",
        phone: "555-1234",
        email: "jane@example.com",
      }),
    );

    const nameInput = document.querySelector('[autocomplete="name"]') as HTMLInputElement;
    expect(nameInput.value).toBe("");
  });

  it("skips display:none input (visibility check)", () => {
    setupForm(`
      <input autocomplete="name" />
      <input autocomplete="tel" />
      <input autocomplete="email" style="display: none" />
    `);

    performIdentityAutofill(
      payload({
        fullName: "Jane Doe",
        phone: "555-1234",
        email: "hidden@example.com",
      }),
    );

    const emailInput = document.querySelector('[autocomplete="email"]') as HTMLInputElement;
    expect(emailInput.value).toBe("");
  });

  it("skips visibility:hidden input (visibility check)", () => {
    setupForm(`
      <input autocomplete="name" />
      <input autocomplete="tel" style="visibility: hidden" />
      <input autocomplete="email" />
    `);

    performIdentityAutofill(
      payload({
        fullName: "Jane Doe",
        phone: "555-1234",
        email: "jane@example.com",
      }),
    );

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

    performIdentityAutofill(
      payload({
        fullName: "Jane Doe",
        phone: "555-1234",
        email: "jane@example.com",
      }),
    );

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

    performIdentityAutofill(
      payload({
        fullName: "山田太郎",
        address: "東京都渋谷区1-2-3",
        phone: "03-1234-5678",
      }),
    );

    const nameInput = document.getElementById("name") as HTMLInputElement;
    const addrInput = document.getElementById("addr") as HTMLInputElement;
    const telInput = document.getElementById("tel") as HTMLInputElement;
    expect(nameInput.value).toBe("山田太郎");
    expect(addrInput.value).toBe("東京都渋谷区1-2-3");
    expect(telInput.value).toBe("03-1234-5678");
  });

  // ── T2: structured split fill (non-vacuous — distinct value per field) ──

  it("routes each structured field to its correctly-typed split field", () => {
    setupForm(`
      <input autocomplete="given-name" />
      <input autocomplete="family-name" />
      <input autocomplete="address-line1" />
      <input autocomplete="address-line2" />
      <input autocomplete="address-level2" />
      <select autocomplete="address-level1">
        <option value="">Select</option>
        <option value="CA">California</option>
        <option value="NY">New York</option>
      </select>
      <input autocomplete="postal-code" />
      <select autocomplete="country-name">
        <option value="">Select</option>
        <option value="US">United States</option>
        <option value="JP">Japan</option>
      </select>
    `);

    performIdentityAutofill(
      payload({
        givenName: "Jane",
        familyName: "Doe",
        address: "123 Main St",
        addressLine2: "Apt 4B",
        city: "Springfield",
        state: "CA",
        postalCode: "90210",
        country: "US",
      }),
    );

    expect((document.querySelector('[autocomplete="given-name"]') as HTMLInputElement).value).toBe("Jane");
    expect((document.querySelector('[autocomplete="family-name"]') as HTMLInputElement).value).toBe("Doe");
    expect((document.querySelector('[autocomplete="address-line1"]') as HTMLInputElement).value).toBe("123 Main St");
    expect((document.querySelector('[autocomplete="address-line2"]') as HTMLInputElement).value).toBe("Apt 4B");
    expect((document.querySelector('[autocomplete="address-level2"]') as HTMLInputElement).value).toBe("Springfield");
    expect((document.querySelector('[autocomplete="address-level1"]') as HTMLSelectElement).value).toBe("CA");
    expect((document.querySelector('[autocomplete="postal-code"]') as HTMLInputElement).value).toBe("90210");
    expect((document.querySelector('[autocomplete="country-name"]') as HTMLSelectElement).value).toBe("US");
  });

  // ── Kana fill: kana values land only in the kana fields ──

  it("routes kana values to kana fields without touching the plain name fields", () => {
    setupForm(`
      <label for="sei">姓</label>
      <input id="sei" type="text" />
      <label for="mei">名</label>
      <input id="mei" type="text" />
      <label for="sei-kana">セイ（フリガナ）</label>
      <input id="sei-kana" type="text" />
      <label for="mei-kana">メイ（フリガナ）</label>
      <input id="mei-kana" type="text" />
    `);

    performIdentityAutofill(
      payload({
        familyName: "山田",
        givenName: "太郎",
        familyNameKana: "ヤマダ",
        givenNameKana: "タロウ",
      }),
    );

    expect((document.getElementById("sei") as HTMLInputElement).value).toBe("山田");
    expect((document.getElementById("mei") as HTMLInputElement).value).toBe("太郎");
    expect((document.getElementById("sei-kana") as HTMLInputElement).value).toBe("ヤマダ");
    expect((document.getElementById("mei-kana") as HTMLInputElement).value).toBe("タロウ");
  });

  // ── T3: back-compat no-mis-split ──

  it("leaves split name fields EMPTY for a legacy entry (only fullName) on a split form", () => {
    setupForm(`
      <input autocomplete="given-name" />
      <input autocomplete="family-name" />
      <input autocomplete="tel" />
    `);

    // Legacy entry: only the monolithic fullName, no structured given/family.
    performIdentityAutofill(payload({ fullName: "Jane Doe", phone: "555-1234" }));

    expect((document.querySelector('[autocomplete="given-name"]') as HTMLInputElement).value).toBe("");
    expect((document.querySelector('[autocomplete="family-name"]') as HTMLInputElement).value).toBe("");
    // Non-name field still fills (proves the form was detected, not skipped).
    expect((document.querySelector('[autocomplete="tel"]') as HTMLInputElement).value).toBe("555-1234");
  });

  it("fills a combined name field from fullName for a legacy entry", () => {
    setupForm(`
      <input autocomplete="name" />
      <input autocomplete="tel" />
    `);

    performIdentityAutofill(payload({ fullName: "Jane Doe", phone: "555-1234" }));

    expect((document.querySelector('[autocomplete="name"]') as HTMLInputElement).value).toBe("Jane Doe");
  });
});
