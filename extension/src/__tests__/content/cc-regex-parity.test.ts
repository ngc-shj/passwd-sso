/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { CC_DETECT_RE, CC_CONF_NUM_RE } from "../../content/cc-form-detector-lib";
import { ADDRESS_JA_RE } from "../../content/identity-form-detector-lib";

// autofill-cc.js / autofill-identity.js are hand-maintained plain-JS
// production content scripts (the *-lib.ts files are typed test-only twins).
// A regex change landed only in the .ts twin would silently ship a stale
// production regex while unit tests (which import the .ts twin) stay green.
// Pin the FULL delimited literal (RegExp.prototype.toString(), flags
// included) so append/prepend drift AND flag drift both break containment —
// `.source` alone is append-blind (see plan C6 rationale).
describe("cc regex parity — .js production copy vs .ts lib", () => {
  it("ccNumRe matches CC_DETECT_RE.number", async () => {
    const { default: autofillCcRaw } = await import("../../content/autofill-cc.js?raw");
    expect(autofillCcRaw).toContain(CC_DETECT_RE.number.toString());
  });

  it("ccNameRe matches CC_DETECT_RE.name", async () => {
    const { default: autofillCcRaw } = await import("../../content/autofill-cc.js?raw");
    expect(autofillCcRaw).toContain(CC_DETECT_RE.name.toString());
  });

  it("ccExpMonthRe matches CC_DETECT_RE.expiryMonth", async () => {
    const { default: autofillCcRaw } = await import("../../content/autofill-cc.js?raw");
    expect(autofillCcRaw).toContain(CC_DETECT_RE.expiryMonth.toString());
  });

  it("ccExpYearRe matches CC_DETECT_RE.expiryYear", async () => {
    const { default: autofillCcRaw } = await import("../../content/autofill-cc.js?raw");
    expect(autofillCcRaw).toContain(CC_DETECT_RE.expiryYear.toString());
  });

  it("ccCvvRe matches CC_DETECT_RE.cvv", async () => {
    const { default: autofillCcRaw } = await import("../../content/autofill-cc.js?raw");
    expect(autofillCcRaw).toContain(CC_DETECT_RE.cvv.toString());
  });

  it("ccConfNumRe matches CC_CONF_NUM_RE (same-form-scoped conf.?num fallback)", async () => {
    const { default: autofillCcRaw } = await import("../../content/autofill-cc.js?raw");
    expect(autofillCcRaw).toContain(CC_CONF_NUM_RE.toString());
  });

  it("conf.?num is NOT in the page-wide CC_DETECT_RE.cvv alternation", async () => {
    // Regression: conf.?num must only be reachable via the same-form-scoped
    // fallback, never the first-match-wins page-wide cvv regex.
    expect(CC_DETECT_RE.cvv.source).not.toContain("conf");
  });

  it("addrJa matches ADDRESS_JA_RE", async () => {
    const { default: autofillIdentityRaw } = await import("../../content/autofill-identity.js?raw");
    expect(autofillIdentityRaw).toContain(ADDRESS_JA_RE.toString());
  });

  it("addrJa does not reintroduce the forbidden 番号 alternation", async () => {
    const { default: autofillIdentityRaw } = await import("../../content/autofill-identity.js?raw");
    expect(autofillIdentityRaw).not.toMatch(/addrJa\s*=[^;]*番号/);
  });

  it("normalizeYearValue canonicalizes 2-digit years to 20xx", async () => {
    const { default: autofillCcRaw } = await import("../../content/autofill-cc.js?raw");
    expect(autofillCcRaw).toContain("return String(2000 + num)");
  });

  it("normalizeYearValue guards the 2-digit range as [0,99]", async () => {
    const { default: autofillCcRaw } = await import("../../content/autofill-cc.js?raw");
    expect(autofillCcRaw).toContain("num >= 0 && num <= 99");
  });
});
