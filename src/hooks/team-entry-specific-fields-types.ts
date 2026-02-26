"use client";

import type { ComponentProps } from "react";
import { OrgEntrySpecificFields } from "@/components/team/team-entry-specific-fields";
import type { OrgPasswordFormTranslations } from "@/hooks/entry-form-translations";

export type OrgEntrySpecificFieldsProps = ComponentProps<typeof OrgEntrySpecificFields>;

export type OrgEntrySpecificFieldTranslations = Pick<
  OrgPasswordFormTranslations,
  "t" | "tn" | "tcc" | "ti" | "tpk"
>;

export type OrgEntrySpecificComputedProps =
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

export type OrgEntrySpecificFieldsBuilderArgs = Omit<
  OrgEntrySpecificFieldsProps,
  OrgEntrySpecificComputedProps
> & {
  entryCopy: {
    notesLabel: string;
    notesPlaceholder: string;
  };
  translations: OrgEntrySpecificFieldTranslations;
  lengthHint: string;
};
