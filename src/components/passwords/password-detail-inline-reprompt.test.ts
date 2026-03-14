import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Structural tests to verify that PasswordDetailInline applies reprompt
 * protection to all sensitive operations. These tests read the source files
 * and check for required patterns, serving as a guard against accidental
 * removal of reprompt guards during refactoring.
 */

const SRC_PATH = resolve(
  __dirname,
  "password-detail-inline.tsx",
);
const source = readFileSync(SRC_PATH, "utf-8");

const LOGIN_SECTION_PATH = resolve(
  __dirname,
  "detail-sections/login-section.tsx",
);
const loginSource = readFileSync(LOGIN_SECTION_PATH, "utf-8");

describe("PasswordDetailInline reprompt guards", () => {
  it("imports useReprompt hook", () => {
    expect(source).toContain('import { useReprompt } from "@/hooks/use-reprompt"');
  });

  it("calls useReprompt()", () => {
    expect(source).toMatch(/const\s+\{[\s\S]*requireVerification[\s\S]*createGuardedGetter[\s\S]*repromptDialog[\s\S]*\}\s*=\s*useReprompt\(\)/);
  });

  it("renders repromptDialog", () => {
    expect(source).toContain("{repromptDialog}");
  });

  it("imports section components", () => {
    expect(source).toContain('LoginSection');
    expect(source).toContain('CreditCardSection');
    expect(source).toContain('SshKeySection');
  });

  it("passes requireVerification and createGuardedGetter to sections", () => {
    expect(source).toContain("sectionProps");
    expect(source).toContain("requireVerification");
    expect(source).toContain("createGuardedGetter");
  });

  it("InlineDetailData is re-exported from @/types/entry", () => {
    expect(source).toContain('export type { InlineDetailData } from "@/types/entry"');
  });

  it("password reveal uses requireVerification (via useRevealTimeout in login section)", () => {
    expect(loginSource).toMatch(/handleReveal\b/);
    expect(loginSource).toContain('useRevealTimeout');
  });

  it("password copy uses createGuardedGetter (in login section)", () => {
    expect(loginSource).toMatch(/CopyButton[\s\S]*?createGuardedGetter\([\s\S]*?data\.password/);
  });

  it("TOTP copy uses wrapCopyGetter with createGuardedGetter (in login section)", () => {
    expect(loginSource).toMatch(/wrapCopyGetter=\{[\s\S]*?createGuardedGetter\(/);
  });

  it("HIDDEN custom field reveal uses requireVerification (via useRevealSet in login section)", () => {
    expect(loginSource).toMatch(/CUSTOM_FIELD_TYPE\.HIDDEN[\s\S]*?handleRevealFieldIndex\(/);
    expect(loginSource).toContain('useRevealSet');
  });

  it("HIDDEN custom field copy uses createGuardedGetter (in login section)", () => {
    expect(loginSource).toMatch(/CUSTOM_FIELD_TYPE\.HIDDEN[\s\S]*?createGuardedGetter\(/);
  });

  it("password history reveal uses requireVerification (via useRevealSet in login section)", () => {
    expect(loginSource).toMatch(/handleRevealHistoryIndex\(/);
    expect(loginSource).toContain('useRevealSet');
  });

  it("password history copy uses createGuardedGetter (in login section)", () => {
    expect(loginSource).toMatch(/createGuardedGetter\([\s\S]*?entry\.password/);
  });
});
