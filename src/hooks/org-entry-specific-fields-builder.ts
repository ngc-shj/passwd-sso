"use client";

import type { ComponentProps } from "react";
import { OrgEntrySpecificFields } from "@/components/org/org-entry-specific-fields";
import type { GeneratorSettings } from "@/lib/generator-prefs";

export type OrgEntrySpecificFieldsProps = ComponentProps<typeof OrgEntrySpecificFields>;
export type OrgFieldTranslator = (key: string, values?: Record<string, string | number | Date>) => string;

export interface OrgEntrySpecificFieldsBuilderArgs {
  entryKind: OrgEntrySpecificFieldsProps["entryKind"];
  entryCopy: {
    notesLabel: string;
    notesPlaceholder: string;
  };
  t: OrgFieldTranslator;
  tn: OrgFieldTranslator;
  tcc: OrgFieldTranslator;
  ti: OrgFieldTranslator;
  tpk: OrgFieldTranslator;
  notes: string;
  onNotesChange: (value: string) => void;
  title: string;
  onTitleChange: (value: string) => void;
  username: string;
  onUsernameChange: (value: string) => void;
  password: string;
  onPasswordChange: (value: string) => void;
  showPassword: boolean;
  onToggleShowPassword: () => void;
  generatorSummary: string;
  showGenerator: boolean;
  onToggleGenerator: () => void;
  generatorSettings: GeneratorSettings;
  onGeneratorUse: (password: string, settings: GeneratorSettings) => void;
  url: string;
  onUrlChange: (value: string) => void;
  content: string;
  onContentChange: (value: string) => void;
  cardholderName: string;
  onCardholderNameChange: (value: string) => void;
  brand: string;
  onBrandChange: (value: string) => void;
  cardNumber: string;
  onCardNumberChange: (value: string) => void;
  showCardNumber: boolean;
  onToggleCardNumber: () => void;
  maxInputLength: number;
  showLengthError: boolean;
  showLuhnError: boolean;
  detectedBrand?: string;
  hasBrandHint: boolean;
  lengthHint: string;
  expiryMonth: string;
  onExpiryMonthChange: (value: string) => void;
  expiryYear: string;
  onExpiryYearChange: (value: string) => void;
  cvv: string;
  onCvvChange: (value: string) => void;
  showCvv: boolean;
  onToggleCvv: () => void;
  fullName: string;
  onFullNameChange: (value: string) => void;
  address: string;
  onAddressChange: (value: string) => void;
  phone: string;
  onPhoneChange: (value: string) => void;
  email: string;
  onEmailChange: (value: string) => void;
  dateOfBirth: string;
  onDateOfBirthChange: (value: string) => void;
  nationality: string;
  onNationalityChange: (value: string) => void;
  idNumber: string;
  onIdNumberChange: (value: string) => void;
  showIdNumber: boolean;
  onToggleIdNumber: () => void;
  issueDate: string;
  onIssueDateChange: (value: string) => void;
  expiryDate: string;
  onExpiryDateChange: (value: string) => void;
  dobError: string | null;
  expiryError: string | null;
  relyingPartyId: string;
  onRelyingPartyIdChange: (value: string) => void;
  relyingPartyName: string;
  onRelyingPartyNameChange: (value: string) => void;
  credentialId: string;
  onCredentialIdChange: (value: string) => void;
  showCredentialId: boolean;
  onToggleCredentialId: () => void;
  creationDate: string;
  onCreationDateChange: (value: string) => void;
  deviceInfo: string;
  onDeviceInfoChange: (value: string) => void;
}

export function buildOrgEntrySpecificFieldsProps({
  entryKind,
  entryCopy,
  t,
  tn,
  tcc,
  ti,
  tpk,
  notes,
  onNotesChange,
  title,
  onTitleChange,
  username,
  onUsernameChange,
  password,
  onPasswordChange,
  showPassword,
  onToggleShowPassword,
  generatorSummary,
  showGenerator,
  onToggleGenerator,
  generatorSettings,
  onGeneratorUse,
  url,
  onUrlChange,
  content,
  onContentChange,
  cardholderName,
  onCardholderNameChange,
  brand,
  onBrandChange,
  cardNumber,
  onCardNumberChange,
  showCardNumber,
  onToggleCardNumber,
  maxInputLength,
  showLengthError,
  showLuhnError,
  detectedBrand,
  hasBrandHint,
  lengthHint,
  expiryMonth,
  onExpiryMonthChange,
  expiryYear,
  onExpiryYearChange,
  cvv,
  onCvvChange,
  showCvv,
  onToggleCvv,
  fullName,
  onFullNameChange,
  address,
  onAddressChange,
  phone,
  onPhoneChange,
  email,
  onEmailChange,
  dateOfBirth,
  onDateOfBirthChange,
  nationality,
  onNationalityChange,
  idNumber,
  onIdNumberChange,
  showIdNumber,
  onToggleIdNumber,
  issueDate,
  onIssueDateChange,
  expiryDate,
  onExpiryDateChange,
  dobError,
  expiryError,
  relyingPartyId,
  onRelyingPartyIdChange,
  relyingPartyName,
  onRelyingPartyNameChange,
  credentialId,
  onCredentialIdChange,
  showCredentialId,
  onToggleCredentialId,
  creationDate,
  onCreationDateChange,
  deviceInfo,
  onDeviceInfoChange,
}: OrgEntrySpecificFieldsBuilderArgs): OrgEntrySpecificFieldsProps {
  return {
    entryKind,
    notesLabel: entryCopy.notesLabel,
    notesPlaceholder: entryCopy.notesPlaceholder,
    notes,
    onNotesChange,
    content,
    onContentChange,
    contentLabel: tn("content"),
    contentPlaceholder: tn("contentPlaceholder"),
    title,
    onTitleChange,
    titleLabel: t("title"),
    titlePlaceholder: t("titlePlaceholder"),
    username,
    onUsernameChange,
    usernameLabel: t("usernameEmail"),
    usernamePlaceholder: t("usernamePlaceholder"),
    password,
    onPasswordChange,
    passwordLabel: t("password"),
    passwordPlaceholder: t("passwordPlaceholder"),
    showPassword,
    onToggleShowPassword,
    generatorSummary,
    showGenerator,
    onToggleGenerator,
    closeGeneratorLabel: t("closeGenerator"),
    openGeneratorLabel: t("openGenerator"),
    generatorSettings,
    onGeneratorUse,
    url,
    onUrlChange,
    urlLabel: t("url"),
    cardholderName,
    onCardholderNameChange,
    cardholderNamePlaceholder: tcc("cardholderNamePlaceholder"),
    brand,
    onBrandChange,
    brandPlaceholder: tcc("brandPlaceholder"),
    cardNumber,
    onCardNumberChange,
    cardNumberPlaceholder: tcc("cardNumberPlaceholder"),
    showCardNumber,
    onToggleCardNumber,
    maxInputLength,
    showLengthError,
    showLuhnError,
    detectedBrand,
    hasBrandHint,
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
    expiryMonth,
    onExpiryMonthChange,
    expiryYear,
    onExpiryYearChange,
    expiryMonthPlaceholder: tcc("expiryMonth"),
    expiryYearPlaceholder: tcc("expiryYear"),
    cvv,
    onCvvChange,
    cvvPlaceholder: tcc("cvvPlaceholder"),
    showCvv,
    onToggleCvv,
    fullName,
    onFullNameChange,
    fullNamePlaceholder: ti("fullNamePlaceholder"),
    address,
    onAddressChange,
    addressPlaceholder: ti("addressPlaceholder"),
    phone,
    onPhoneChange,
    phonePlaceholder: ti("phonePlaceholder"),
    email,
    onEmailChange,
    emailPlaceholder: ti("emailPlaceholder"),
    dateOfBirth,
    onDateOfBirthChange,
    nationality,
    onNationalityChange,
    nationalityPlaceholder: ti("nationalityPlaceholder"),
    idNumber,
    onIdNumberChange,
    idNumberPlaceholder: ti("idNumberPlaceholder"),
    showIdNumber,
    onToggleIdNumber,
    issueDate,
    onIssueDateChange,
    expiryDate,
    onExpiryDateChange,
    dobError,
    expiryError,
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
    relyingPartyId,
    onRelyingPartyIdChange,
    relyingPartyIdPlaceholder: tpk("relyingPartyIdPlaceholder"),
    relyingPartyName,
    onRelyingPartyNameChange,
    relyingPartyNamePlaceholder: tpk("relyingPartyNamePlaceholder"),
    credentialId,
    onCredentialIdChange,
    credentialIdPlaceholder: tpk("credentialIdPlaceholder"),
    showCredentialId,
    onToggleCredentialId,
    creationDate,
    onCreationDateChange,
    deviceInfo,
    onDeviceInfoChange,
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
