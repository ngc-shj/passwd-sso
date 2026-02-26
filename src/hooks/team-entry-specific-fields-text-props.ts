"use client";

import type {
  TeamEntrySpecificComputedProps,
  TeamEntrySpecificFieldTranslations,
  TeamEntrySpecificFieldsProps,
} from "@/hooks/team-entry-specific-fields-types";

interface EntryCopyText {
  notesLabel: string;
  notesPlaceholder: string;
}

export function buildTeamEntrySpecificTextProps(
  translations: TeamEntrySpecificFieldTranslations,
  entryCopy: EntryCopyText,
  lengthHint: string,
): Pick<TeamEntrySpecificFieldsProps, TeamEntrySpecificComputedProps> {
  const { t, tn, tcc, ti, tpk } = translations;

  return {
    notesLabel: entryCopy.notesLabel,
    notesPlaceholder: entryCopy.notesPlaceholder,
    titleLabel: t("title"),
    titlePlaceholder: t("titlePlaceholder"),
    usernameLabel: t("usernameEmail"),
    usernamePlaceholder: t("usernamePlaceholder"),
    passwordLabel: t("password"),
    passwordPlaceholder: t("passwordPlaceholder"),
    closeGeneratorLabel: t("closeGenerator"),
    openGeneratorLabel: t("openGenerator"),
    urlLabel: t("url"),
    contentLabel: tn("content"),
    contentPlaceholder: tn("contentPlaceholder"),
    cardholderNamePlaceholder: tcc("cardholderNamePlaceholder"),
    brandPlaceholder: tcc("brandPlaceholder"),
    cardNumberPlaceholder: tcc("cardNumberPlaceholder"),
    lengthHintGenericLabel: tcc("cardNumberLengthHintGeneric"),
    lengthHintLabel: tcc("cardNumberLengthHint", { lengths: lengthHint }),
    invalidLengthLabel: tcc("cardNumberInvalidLength", { lengths: lengthHint }),
    invalidLuhnLabel: tcc("cardNumberInvalidLuhn"),
    creditCardLabels: {
      cardholderName: tcc("cardholderName"),
      brand: tcc("brand"),
      cardNumber: tcc("cardNumber"),
      expiry: tcc("expiry"),
      cvv: tcc("cvv"),
    },
    expiryMonthPlaceholder: tcc("expiryMonth"),
    expiryYearPlaceholder: tcc("expiryYear"),
    cvvPlaceholder: tcc("cvvPlaceholder"),
    fullNamePlaceholder: ti("fullNamePlaceholder"),
    addressPlaceholder: ti("addressPlaceholder"),
    phonePlaceholder: ti("phonePlaceholder"),
    emailPlaceholder: ti("emailPlaceholder"),
    nationalityPlaceholder: ti("nationalityPlaceholder"),
    idNumberPlaceholder: ti("idNumberPlaceholder"),
    identityLabels: {
      fullName: ti("fullName"),
      address: ti("address"),
      phone: ti("phone"),
      email: ti("email"),
      dateOfBirth: ti("dateOfBirth"),
      nationality: ti("nationality"),
      idNumber: ti("idNumber"),
      issueDate: ti("issueDate"),
      expiryDate: ti("expiryDate"),
    },
    relyingPartyIdPlaceholder: tpk("relyingPartyIdPlaceholder"),
    relyingPartyNamePlaceholder: tpk("relyingPartyNamePlaceholder"),
    credentialIdPlaceholder: tpk("credentialIdPlaceholder"),
    deviceInfoPlaceholder: tpk("deviceInfoPlaceholder"),
    passkeyLabels: {
      relyingPartyId: tpk("relyingPartyId"),
      relyingPartyName: tpk("relyingPartyName"),
      username: tpk("username"),
      credentialId: tpk("credentialId"),
      creationDate: tpk("creationDate"),
      deviceInfo: tpk("deviceInfo"),
    },
  };
}
