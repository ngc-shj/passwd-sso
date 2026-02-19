import type {
  CommonTranslator,
  PasswordFormTranslator,
  PasswordGeneratorTranslator,
} from "@/lib/translation-types";

export interface PersonalPasswordFormTranslations {
  t: PasswordFormTranslator;
  tGen: PasswordGeneratorTranslator;
  tc: CommonTranslator;
}

interface BuildPersonalPasswordFormTranslationsInput {
  t: PasswordFormTranslator;
  tGen: PasswordGeneratorTranslator;
  tc: CommonTranslator;
}

export function buildPersonalPasswordFormTranslations({
  t,
  tGen,
  tc,
}: BuildPersonalPasswordFormTranslationsInput): PersonalPasswordFormTranslations {
  return { t, tGen, tc };
}
