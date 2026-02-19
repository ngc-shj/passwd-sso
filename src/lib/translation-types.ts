import type { useTranslations } from "next-intl";

export type PasswordFormTranslator = ReturnType<typeof useTranslations<"PasswordForm">>;
export type PasswordGeneratorTranslator = ReturnType<typeof useTranslations<"PasswordGenerator">>;
export type CommonTranslator = ReturnType<typeof useTranslations<"Common">>;
export type SecureNoteFormTranslator = ReturnType<typeof useTranslations<"SecureNoteForm">>;
export type CreditCardFormTranslator = ReturnType<typeof useTranslations<"CreditCardForm">>;
export type IdentityFormTranslator = ReturnType<typeof useTranslations<"IdentityForm">>;
export type PasskeyFormTranslator = ReturnType<typeof useTranslations<"PasskeyForm">>;
