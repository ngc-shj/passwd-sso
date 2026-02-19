import { describe, expect, it } from "vitest";
import { buildOrgPasswordFormTranslations } from "@/hooks/org-password-form-translations";

describe("buildOrgPasswordFormTranslations", () => {
  it("builds org translation bundle with expected translators", () => {
    const t = (key: string) => key;
    const ti = (key: string) => key;
    const tn = (key: string) => key;
    const tcc = (key: string) => key;
    const tpk = (key: string) => key;
    const tGen = (key: string) => key;

    const translations = buildOrgPasswordFormTranslations({ t, ti, tn, tcc, tpk, tGen });

    expect(translations.t).toBe(t);
    expect(translations.ti).toBe(ti);
    expect(translations.tn).toBe(tn);
    expect(translations.tcc).toBe(tcc);
    expect(translations.tpk).toBe(tpk);
    expect(translations.tGen).toBe(tGen);
  });
});
