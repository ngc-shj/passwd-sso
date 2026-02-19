import type { useTranslations } from "next-intl";

export type PasswordFormTranslator = ReturnType<typeof useTranslations<"PasswordForm">>;
export type PasswordGeneratorTranslator = ReturnType<typeof useTranslations<"PasswordGenerator">>;
export type CommonTranslator = ReturnType<typeof useTranslations<"Common">>;
