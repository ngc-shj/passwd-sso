import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Structural tests to verify that PasswordDetailInline applies reprompt
 * protection to all sensitive operations. These tests read the source file
 * and check for required patterns, serving as a guard against accidental
 * removal of reprompt guards during refactoring.
 */

const SRC_PATH = resolve(
  __dirname,
  "password-detail-inline.tsx",
);
const source = readFileSync(SRC_PATH, "utf-8");

describe("PasswordDetailInline reprompt guards", () => {
  it("imports useReprompt hook", () => {
    expect(source).toContain('import { useReprompt } from "@/hooks/use-reprompt"');
  });

  it("calls useReprompt()", () => {
    expect(source).toMatch(/const\s+\{.*requireVerification.*createGuardedGetter.*repromptDialog.*\}\s*=\s*useReprompt\(\)/s);
  });

  it("renders repromptDialog", () => {
    expect(source).toContain("{repromptDialog}");
  });

  it("InlineDetailData includes requireReprompt field", () => {
    expect(source).toMatch(/interface InlineDetailData[\s\S]*?requireReprompt\??:\s*boolean/);
  });

  it("password reveal uses requireVerification", () => {
    // handleReveal should call requireVerification, not directly setShowPassword
    expect(source).toMatch(/handleReveal\s*=\s*useCallback\(\(\)\s*=>\s*\{[\s\S]*?requireVerification\(/);
  });

  it("password copy uses createGuardedGetter", () => {
    // CopyButton for password uses createGuardedGetter
    expect(source).toMatch(/CopyButton[\s\S]*?createGuardedGetter\([\s\S]*?data\.password/);
  });

  it("TOTP copy uses wrapCopyGetter with createGuardedGetter", () => {
    expect(source).toMatch(/wrapCopyGetter=\{[\s\S]*?createGuardedGetter\(/);
  });

  it("HIDDEN custom field reveal uses requireVerification", () => {
    // The HIDDEN field onClick should call requireVerification (not just toggle)
    expect(source).toMatch(/CUSTOM_FIELD_TYPE\.HIDDEN[\s\S]*?requireVerification\(/);
  });

  it("HIDDEN custom field copy uses createGuardedGetter", () => {
    expect(source).toMatch(/CUSTOM_FIELD_TYPE\.HIDDEN[\s\S]*?createGuardedGetter\(/);
  });

  it("password history reveal uses requireVerification", () => {
    // The history reveal onClick should call requireVerification
    expect(source).toMatch(/revealedHistory[\s\S]*?requireVerification\(/);
  });

  it("password history copy uses createGuardedGetter", () => {
    expect(source).toMatch(/entry\.password[\s\S]*?createGuardedGetter\(/);
  });
});
