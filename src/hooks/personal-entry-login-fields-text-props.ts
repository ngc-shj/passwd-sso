"use client";

import type { PasswordFormTranslator } from "@/lib/translation-types";

type TextProps = {
  titleLabel: string;
  titlePlaceholder: string;
  usernameLabel: string;
  usernamePlaceholder: string;
  passwordLabel: string;
  passwordPlaceholder: string;
  closeGeneratorLabel: string;
  openGeneratorLabel: string;
  urlLabel: string;
  notesLabel: string;
  notesPlaceholder: string;
};

export function buildPersonalEntryLoginFieldTextProps(
  t: PasswordFormTranslator,
): TextProps {
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
