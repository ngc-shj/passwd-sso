import { describe, expect, it } from "vitest";
import { buildPersonalPasswordFormTranslations } from "@/hooks/personal-password-form-translations";

describe("buildPersonalPasswordFormTranslations", () => {
  it("builds personal translation bundle with expected translators", () => {
    const t = (key: string) => key;
    const tGen = (key: string) => key;
    const tc = (key: string) => key;

    const translations = buildPersonalPasswordFormTranslations({ t, tGen, tc });

    expect(translations.t).toBe(t);
    expect(translations.tGen).toBe(tGen);
    expect(translations.tc).toBe(tc);
  });
});
