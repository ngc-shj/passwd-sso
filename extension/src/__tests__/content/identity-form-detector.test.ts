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
});
