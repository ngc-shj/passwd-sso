import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTranslator } from "next-intl";
import {
  JIT_TOKEN_TTL_MIN,
  JIT_TOKEN_TTL_MAX,
  DELEGATION_TTL_MIN,
  DELEGATION_TTL_MAX,
} from "@/lib/validations/common";
import { CRYPTO_CONSTANTS } from "@/lib/crypto/crypto-client";

function readMessages(locale: string, namespace: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), "messages", locale, `${namespace}.json`),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

const LOCALES = ["en", "ja"] as const;

describe("TenantAdmin TTL help text interpolation", () => {
  for (const locale of LOCALES) {
    const messages = readMessages(locale, "TenantAdmin");
    const t = createTranslator({ locale, messages });

    it(`[${locale}] jitTokenDefaultTtlSecHelp renders min and max values`, () => {
      const result = t("jitTokenDefaultTtlSecHelp", { min: JIT_TOKEN_TTL_MIN, max: JIT_TOKEN_TTL_MAX });
      expect(result).toContain(String(JIT_TOKEN_TTL_MIN));
      expect(result).toContain(String(JIT_TOKEN_TTL_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] jitTokenMaxTtlSecHelp renders min and max values`, () => {
      const result = t("jitTokenMaxTtlSecHelp", { min: JIT_TOKEN_TTL_MIN, max: JIT_TOKEN_TTL_MAX });
      expect(result).toContain(String(JIT_TOKEN_TTL_MIN));
      expect(result).toContain(String(JIT_TOKEN_TTL_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] jitTokenTtlValidationMin renders min value`, () => {
      const result = t("jitTokenTtlValidationMin", { min: JIT_TOKEN_TTL_MIN });
      expect(result).toContain(String(JIT_TOKEN_TTL_MIN));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] jitTokenTtlValidationMax renders max value`, () => {
      const result = t("jitTokenTtlValidationMax", { max: JIT_TOKEN_TTL_MAX });
      expect(result).toContain(String(JIT_TOKEN_TTL_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] delegationDefaultTtlSecHelp renders min and max values`, () => {
      const result = t("delegationDefaultTtlSecHelp", { min: DELEGATION_TTL_MIN, max: DELEGATION_TTL_MAX });
      expect(result).toContain(String(DELEGATION_TTL_MIN));
      expect(result).toContain(String(DELEGATION_TTL_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] delegationMaxTtlSecHelp renders min and max values`, () => {
      const result = t("delegationMaxTtlSecHelp", { min: DELEGATION_TTL_MIN, max: DELEGATION_TTL_MAX });
      expect(result).toContain(String(DELEGATION_TTL_MIN));
      expect(result).toContain(String(DELEGATION_TTL_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] delegationTtlValidationMin renders min value`, () => {
      const result = t("delegationTtlValidationMin", { min: DELEGATION_TTL_MIN });
      expect(result).toContain(String(DELEGATION_TTL_MIN));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] delegationTtlValidationMax renders max value`, () => {
      const result = t("delegationTtlValidationMax", { max: DELEGATION_TTL_MAX });
      expect(result).toContain(String(DELEGATION_TTL_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });
  }
});

describe("PrivacyPolicy security section PBKDF2 iterations interpolation", () => {
  // PBKDF2_ITERATIONS is sourced from CRYPTO_CONSTANTS (crypto-client.ts).
  // When C1 creates crypto-params.ts, the import source can be updated to
  // @/lib/crypto/crypto-params without changing the assertion logic.
  const PBKDF2_ITERATIONS = CRYPTO_CONSTANTS.PBKDF2_ITERATIONS;

  for (const locale of LOCALES) {
    const rawMessages = readMessages(locale, "PrivacyPolicy");
    // sections is a nested object; createTranslator needs flat messages or supports nesting
    const t = createTranslator({ locale, messages: { PrivacyPolicy: rawMessages }, namespace: "PrivacyPolicy" });

    it(`[${locale}] sections.security.body renders PBKDF2 iterations without placeholder residue`, () => {
      const result = t("sections.security.body", { iterations: PBKDF2_ITERATIONS });
      // Rendered number must appear (locale-formatted: "600,000" for both en and ja)
      expect(result).toContain("600,000");
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });
  }
});
