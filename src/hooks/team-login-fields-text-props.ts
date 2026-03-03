"use client";

import type { PasswordFormTranslator } from "@/lib/translation-types";
import type { useTeamPolicy } from "@/hooks/use-team-policy";
import type { TeamLoginFieldTextProps } from "@/hooks/team-login-fields-types";

type TeamPolicy = ReturnType<typeof useTeamPolicy>["policy"];

export function buildTeamLoginFieldTextProps(
  t: PasswordFormTranslator,
  teamPolicy: TeamPolicy,
): TeamLoginFieldTextProps {
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
    teamPolicy,
  };
}
