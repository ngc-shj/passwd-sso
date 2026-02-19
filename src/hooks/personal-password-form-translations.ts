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
