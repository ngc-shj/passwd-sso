/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { isLikelyOtpInput } from "../../content/form-detector-lib";

function setupInput(attrs: Record<string, string>, labelText?: string): HTMLInputElement {
  document.body.innerHTML = "";
  const input = document.createElement("input");
  for (const [key, value] of Object.entries(attrs)) {
    input.setAttribute(key, value);
  }
  document.body.appendChild(input);

  if (labelText && attrs.id) {
    const label = document.createElement("label");
    label.setAttribute("for", attrs.id);
    label.textContent = labelText;
    document.body.appendChild(label);
  }

  return input;
}

describe("isLikelyOtpInput", () => {
  describe("positive cases", () => {
    it("detects autocomplete='one-time-code'", () => {
      const input = setupInput({ type: "text", autocomplete: "one-time-code" });
      expect(isLikelyOtpInput(input)).toBe(true);
    });

    it("detects name='otp'", () => {
      const input = setupInput({ type: "text", name: "otp" });
      expect(isLikelyOtpInput(input)).toBe(true);
    });

    it("detects name='totp'", () => {
      const input = setupInput({ type: "text", name: "totp" });
      expect(isLikelyOtpInput(input)).toBe(true);
    });

    it("detects name='totpmfa' (concatenated)", () => {
      const input = setupInput({ type: "text", name: "totpmfa" });
      expect(isLikelyOtpInput(input)).toBe(true);
    });

    it("detects id='2fa-code'", () => {
      const input = setupInput({ type: "text", id: "2fa-code" });
      expect(isLikelyOtpInput(input)).toBe(true);
    });

    it("detects id='mfaCode'", () => {
      const input = setupInput({ type: "text", id: "mfaCode" });
      expect(isLikelyOtpInput(input)).toBe(true);
    });

    it("detects placeholder='verification code'", () => {
      const input = setupInput({ type: "text", placeholder: "verification code" });
      expect(isLikelyOtpInput(input)).toBe(true);
    });

    it("detects placeholder='認証コード'", () => {
      const input = setupInput({ type: "text", placeholder: "認証コード" });
      expect(isLikelyOtpInput(input)).toBe(true);
    });

    it("detects label text 'ワンタイムパスワード'", () => {
      const input = setupInput({ type: "text", id: "code" }, "ワンタイムパスワード");
      expect(isLikelyOtpInput(input)).toBe(true);
    });

    it("detects type='tel' OTP field", () => {
      const input = setupInput({ type: "tel", name: "otp" });
      expect(isLikelyOtpInput(input)).toBe(true);
    });

    it("detects type='number' OTP field", () => {
      const input = setupInput({ type: "number", name: "otp" });
      expect(isLikelyOtpInput(input)).toBe(true);
    });
  });

  describe("negative cases (false positive suppression)", () => {
    it("rejects password type input", () => {
      const input = setupInput({ type: "password", name: "otp" });
      expect(isLikelyOtpInput(input)).toBe(false);
    });

    it("rejects disabled input", () => {
      const input = setupInput({ type: "text", name: "otp", disabled: "" });
      expect(isLikelyOtpInput(input)).toBe(false);
    });

    it("rejects readOnly input", () => {
      const input = setupInput({ type: "text", name: "otp", readonly: "" });
      expect(isLikelyOtpInput(input)).toBe(false);
    });

    it("rejects plain text input with no OTP hints", () => {
      const input = setupInput({ type: "text", name: "firstName", id: "firstName" });
      expect(isLikelyOtpInput(input)).toBe(false);
    });

    it("rejects search input", () => {
      const input = setupInput({ type: "text", name: "search", placeholder: "Search..." });
      expect(isLikelyOtpInput(input)).toBe(false);
    });

    it("rejects email type input", () => {
      const input = setupInput({ type: "email", name: "otp-code" });
      expect(isLikelyOtpInput(input)).toBe(false);
    });

    it("rejects hidden input", () => {
      const input = setupInput({ type: "hidden", name: "otp" });
      expect(isLikelyOtpInput(input)).toBe(false);
    });

    it("rejects input with no hints at all", () => {
      const input = setupInput({ type: "text" });
      expect(isLikelyOtpInput(input)).toBe(false);
    });
  });
});
