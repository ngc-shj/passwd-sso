import { describe, expect, it } from "vitest";
import type { EntryFormTranslationsBundle } from "@/hooks/entry-form-translations";
import {
  toPersonalPasswordFormTranslations,
  toOrgPasswordFormTranslations,
} from "@/hooks/entry-form-translations";

function createBundle(): EntryFormTranslationsBundle {
  return {
    t: ((key: string) => `pf:${key}`) as EntryFormTranslationsBundle["t"],
    tGen: ((key: string) => `gen:${key}`) as EntryFormTranslationsBundle["tGen"],
    tc: ((key: string) => `c:${key}`) as EntryFormTranslationsBundle["tc"],
    tn: ((key: string) => `sn:${key}`) as EntryFormTranslationsBundle["tn"],
    tcc: ((key: string) => `cc:${key}`) as EntryFormTranslationsBundle["tcc"],
    ti: ((key: string) => `id:${key}`) as EntryFormTranslationsBundle["ti"],
    tpk: ((key: string) => `pk:${key}`) as EntryFormTranslationsBundle["tpk"],
  };
}

describe("toPersonalPasswordFormTranslations", () => {
  it("picks t, tGen, tc from the bundle", () => {
    const bundle = createBundle();
    const result = toPersonalPasswordFormTranslations(bundle);

    expect(result.t).toBe(bundle.t);
    expect(result.tGen).toBe(bundle.tGen);
    expect(result.tc).toBe(bundle.tc);
    expect(Object.keys(result)).toEqual(["t", "tGen", "tc"]);
  });
});

describe("toOrgPasswordFormTranslations", () => {
  it("picks t, tGen, tn, tcc, ti, tpk from the bundle", () => {
    const bundle = createBundle();
    const result = toOrgPasswordFormTranslations(bundle);

    expect(result.t).toBe(bundle.t);
    expect(result.tGen).toBe(bundle.tGen);
    expect(result.tn).toBe(bundle.tn);
    expect(result.tcc).toBe(bundle.tcc);
    expect(result.ti).toBe(bundle.ti);
    expect(result.tpk).toBe(bundle.tpk);
    expect(Object.keys(result)).toEqual(["t", "tGen", "tn", "tcc", "ti", "tpk"]);
  });
});
