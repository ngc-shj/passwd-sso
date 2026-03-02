"use client";

import type { PasswordFormTranslator } from "@/lib/translation-types";
import type { PersonalLoginFieldTextProps } from "@/hooks/personal-login-fields-types";

export function buildPersonalLoginFieldTextProps(
  t: PasswordFormTranslator,
): PersonalLoginFieldTextProps {
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
