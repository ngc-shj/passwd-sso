"use client";

import type { ComponentProps } from "react";
import { TeamEntrySpecificFields } from "@/components/team/team-entry-specific-fields";
import type { TeamPasswordFormTranslations } from "@/hooks/entry-form-translations";

export type TeamEntrySpecificFieldsProps = ComponentProps<typeof TeamEntrySpecificFields>;

export type TeamEntrySpecificFieldTranslations = Pick<
  TeamPasswordFormTranslations,
  "t" | "tn" | "tcc" | "ti" | "tpk"
>;

export type TeamEntrySpecificComputedProps =
  | "notesLabel"
  | "notesPlaceholder"
  | "titleLabel"
  | "titlePlaceholder"
  | "usernameLabel"
  | "usernamePlaceholder"
  | "passwordLabel"
  | "passwordPlaceholder"
  | "closeGeneratorLabel"
  | "openGeneratorLabel"
  | "urlLabel"
  | "contentLabel"
  | "contentPlaceholder"
  | "cardholderNamePlaceholder"
  | "brandPlaceholder"
  | "cardNumberPlaceholder"
  | "lengthHintGenericLabel"
  | "lengthHintLabel"
  | "invalidLengthLabel"
  | "invalidLuhnLabel"
  | "creditCardLabels"
  | "expiryMonthPlaceholder"
  | "expiryYearPlaceholder"
  | "cvvPlaceholder"
  | "fullNamePlaceholder"
  | "addressPlaceholder"
  | "phonePlaceholder"
  | "emailPlaceholder"
  | "nationalityPlaceholder"
  | "idNumberPlaceholder"
  | "identityLabels"
  | "relyingPartyIdPlaceholder"
  | "relyingPartyNamePlaceholder"
  | "credentialIdPlaceholder"
  | "deviceInfoPlaceholder"
  | "passkeyLabels";

export type TeamEntrySpecificFieldsBuilderArgs = Omit<
  TeamEntrySpecificFieldsProps,
  TeamEntrySpecificComputedProps
> & {
  entryCopy: {
    notesLabel: string;
    notesPlaceholder: string;
  };
  translations: TeamEntrySpecificFieldTranslations;
  lengthHint: string;
};
