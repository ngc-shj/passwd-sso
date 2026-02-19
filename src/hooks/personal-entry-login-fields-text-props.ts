"use client";

import type { PasswordFormTranslator } from "@/lib/translation-types";
import type { PersonalEntryLoginFieldTextProps } from "@/hooks/personal-entry-login-fields-types";

export function buildPersonalEntryLoginFieldTextProps(
  t: PasswordFormTranslator,
): PersonalEntryLoginFieldTextProps {
  return {
    titleLabel: t("title"),
    titlePlaceholder: t("titlePlaceholder"),
    usernameLabel: t("usernameEmail"),
    usernamePlaceholder: t("usernamePlaceholder"),
    passwordLabel: t("password"),
    passwordPlaceholder: t("passwordPlaceholder"),
    closeGeneratorLabel: t("closeGenerator"),
    openGeneratorLabel: t("openGenerator"),
    urlLabel: t("url"),
    notesLabel: t("notes"),
    notesPlaceholder: t("notesPlaceholder"),
  };
}
