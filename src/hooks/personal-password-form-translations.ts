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

export function buildPersonalPasswordFormTranslations({
  t,
  tGen,
  tc,
}: PersonalPasswordFormTranslations): PersonalPasswordFormTranslations {
  return { t, tGen, tc };
}
