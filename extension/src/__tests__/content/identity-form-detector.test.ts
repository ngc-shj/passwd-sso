/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from "vitest";
import { detectIdentityFields } from "../../content/identity-form-detector-lib";

// Polyfill CSS.escape for jsdom
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

describe("detectIdentityFields", () => {
  it("detects fields by autocomplete attributes", () => {
    setupForm(`
      <input autocomplete="name" />
      <input autocomplete="address-line1" />
      <input autocomplete="postal-code" />
      <input autocomplete="tel" />
      <input autocomplete="email" />
    `);

    const fields = detectIdentityFields(document);
    expect(fields).not.toBeNull();
    expect(fields!.fullName).toBeTruthy();
    expect(fields!.address).toBeTruthy();
    expect(fields!.postalCode).toBeTruthy();
    expect(fields!.phone).toBeTruthy();
    expect(fields!.email).toBeTruthy();
  });

  it("detects fields by name/id regex fallback", () => {
    setupForm(`
      <input name="fullName" />
      <input name="address" />
      <input name="phone" />
    `);

    const fields = detectIdentityFields(document);
    expect(fields).not.toBeNull();
    expect(fields!.fullName).toBeTruthy();
    expect(fields!.address).toBeTruthy();
    expect(fields!.phone).toBeTruthy();
  });

  it("detects Japanese label fields", () => {
    setupForm(`
      <label for="name">氏名</label>
      <input id="name" type="text" />
      <label for="addr">住所</label>
      <input id="addr" type="text" />
      <label for="tel">電話</label>
      <input id="tel" type="text" />
    `);

    const fields = detectIdentityFields(document);
    expect(fields).not.toBeNull();
    expect(fields!.fullName).toBeTruthy();
    expect(fields!.address).toBeTruthy();
    expect(fields!.phone).toBeTruthy();
  });

  it("returns null when fewer than 2 fields found", () => {
    setupForm(`
      <input name="fullName" />
    `);

    const fields = detectIdentityFields(document);
    expect(fields).toBeNull();
  });

  it("returns null for a login form (no identity fields)", () => {
    setupForm(`
      <input type="text" name="username" />
      <input type="password" />
    `);

    const fields = detectIdentityFields(document);
    expect(fields).toBeNull();
  });

  it("skips disabled and readonly fields", () => {
    setupForm(`
      <input autocomplete="name" disabled />
      <input autocomplete="tel" readonly />
    `);

    const fields = detectIdentityFields(document);
    expect(fields).toBeNull();
  });

  it("does not claim a radio (id=Email) as the email field on a mixed form", () => {
    // Reproduces the reported bug: a 2FA-method radio group whose id="Email"
    // matches EMAIL_RE sits alongside real identity text fields. Without the
    // fillable-type gate, the radio is claimed as `email` and the identity
    // dropdown fires on it. The form has real fields so detection is non-null —
    // the point is that `email` must be null, not the radio.
    setupForm(`
      <form>
        <input id="Email" name="AuthenicationType" type="radio" value="Email" />
        <input name="fullName" type="text" />
        <input name="phone" type="text" />
      </form>
    `);

    const fields = detectIdentityFields(document);
    expect(fields).not.toBeNull();
    expect(fields!.email).toBeNull(); // the radio must NOT be claimed
    expect(fields!.fullName).toBeTruthy();
    expect(fields!.phone).toBeTruthy();
  });

  it("does not claim checkbox / submit inputs whose hints match, on a mixed form", () => {
    // Load-bearing (mixed form so detection stays non-null): a checkbox named
    // email_optin and a submit named address_submit sit next to real text fields.
    // Without the fillable-type gate the checkbox is claimed as `email` and the
    // submit as `address`; the gate must keep those on null.
    setupForm(`
      <form>
        <input type="checkbox" name="email_optin" />
        <input type="submit" name="address_submit" />
        <input name="fullName" type="text" />
        <input name="phone" type="text" />
      </form>
    `);

    const fields = detectIdentityFields(document);
    expect(fields).not.toBeNull();
    expect(fields!.email).toBeNull();
    expect(fields!.address).toBeNull();
    expect(fields!.fullName).toBeTruthy();
    expect(fields!.phone).toBeTruthy();
  });

  it("ignores hidden inputs (excluded by visibility) with matching hints", () => {
    setupForm(`
      <input type="hidden" name="phone" value="x" />
      <input type="submit" name="address_submit" />
    `);

    const fields = detectIdentityFields(document);
    expect(fields).toBeNull();
  });

  it("skips hidden fields", () => {
    setupForm(`
      <input autocomplete="name" style="display: none" />
      <input autocomplete="tel" style="visibility: hidden" />
    `);

    const fields = detectIdentityFields(document);
    expect(fields).toBeNull();
  });

  it("detects select element for region", () => {
    setupForm(`
      <input autocomplete="name" />
      <input autocomplete="tel" />
      <select autocomplete="address-level1">
        <option value="CA">California</option>
        <option value="NY">New York</option>
      </select>
    `);

    const fields = detectIdentityFields(document);
    expect(fields).not.toBeNull();
    expect(fields!.region).toBeInstanceOf(HTMLSelectElement);
  });

  it("detects date of birth field", () => {
    setupForm(`
      <input autocomplete="name" />
      <input autocomplete="bday" />
    `);

    const fields = detectIdentityFields(document);
    expect(fields).not.toBeNull();
    expect(fields!.dateOfBirth).toBeTruthy();
  });

  it("detects postal code by Japanese label", () => {
    setupForm(`
      <label for="zip">郵便番号</label>
      <input id="zip" type="text" />
      <label for="pref">都道府県</label>
      <select id="pref">
        <option value="tokyo">東京都</option>
      </select>
    `);

    const fields = detectIdentityFields(document);
    expect(fields).not.toBeNull();
    expect(fields!.postalCode).toBeTruthy();
    expect(fields!.region).toBeTruthy();
  });

  // ── T5: structured split tokens ──

  it("detects split given/family/line2/city/country by autocomplete tokens", () => {
    setupForm(`
      <input autocomplete="given-name" />
      <input autocomplete="family-name" />
      <input autocomplete="address-line1" />
      <input autocomplete="address-line2" />
      <input autocomplete="address-level2" />
      <input autocomplete="address-level1" />
      <input autocomplete="postal-code" />
      <input autocomplete="country-name" />
    `);

    const fields = detectIdentityFields(document);
    expect(fields).not.toBeNull();
    expect(fields!.givenName).toBeTruthy();
    expect(fields!.familyName).toBeTruthy();
    expect(fields!.address).toBeTruthy();
    expect(fields!.addressLine2).toBeTruthy();
    expect(fields!.city).toBeTruthy();
    expect(fields!.region).toBeTruthy();
    expect(fields!.postalCode).toBeTruthy();
    expect(fields!.country).toBeTruthy();
    // No combined name token present → fullName stays null.
    expect(fields!.fullName).toBeNull();
  });

  it("detects split city/country by Japanese labels", () => {
    setupForm(`
      <label for="city">市区町村</label>
      <input id="city" type="text" />
      <label for="country">国</label>
      <input id="country" type="text" />
    `);

    const fields = detectIdentityFields(document);
    expect(fields).not.toBeNull();
    expect(fields!.city).toBeTruthy();
    expect(fields!.country).toBeTruthy();
  });

  // ── Kana disambiguation (both directions) ──

  it("detects フリガナ セイ/メイ as kana AND plain 姓/名 as given/family", () => {
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

    const fields = detectIdentityFields(document);
    expect(fields).not.toBeNull();

    const sei = document.getElementById("sei");
    const mei = document.getElementById("mei");
    const seiKana = document.getElementById("sei-kana");
    const meiKana = document.getElementById("mei-kana");

    // Plain name fields → given/family, NOT kana.
    expect(fields!.familyName).toBe(sei);
    expect(fields!.givenName).toBe(mei);
    // Kana fields → kana slots, NOT the plain given/family.
    expect(fields!.familyNameKana).toBe(seiKana);
    expect(fields!.givenNameKana).toBe(meiKana);

    // Disambiguation both ways: a kana element never lands in a plain slot…
    expect(fields!.familyName).not.toBe(seiKana);
    expect(fields!.givenName).not.toBe(meiKana);
    // …and a plain element never lands in a kana slot.
    expect(fields!.familyNameKana).not.toBe(sei);
    expect(fields!.givenNameKana).not.toBe(mei);
  });
});
