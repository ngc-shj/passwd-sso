"use client";

import { useMemo } from "react";
import type { GeneratorSettings } from "@/lib/generator-prefs";
import {
  buildOrgEntrySpecificFieldsProps,
  type OrgEntrySpecificFieldsProps,
  type OrgFieldTranslator,
} from "@/hooks/org-entry-specific-fields-builder";
import { buildOrgEntrySpecificCallbacks } from "@/hooks/org-entry-specific-fields-callbacks";
import type {
  OrgPasswordFormValues,
  OrgPasswordFormSettersState,
} from "@/hooks/use-org-password-form-state";

interface UseOrgEntrySpecificFieldsPropsArgs {
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

interface UseOrgEntrySpecificFieldsPropsFromStateArgs {
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
  values: OrgPasswordFormValues;
  setters: OrgPasswordFormSettersState;
  generatorSummary: string;
  onCardNumberChange: (value: string) => void;
  maxInputLength: number;
  showLengthError: boolean;
  showLuhnError: boolean;
  detectedBrand?: string;
  hasBrandHint: boolean;
  lengthHint: string;
}

export function useOrgEntrySpecificFieldsProps(
  args: UseOrgEntrySpecificFieldsPropsArgs,
): OrgEntrySpecificFieldsProps {
  return useMemo(() => buildOrgEntrySpecificFieldsProps(args), [args]);
}

export function useOrgEntrySpecificFieldsPropsFromState({
  entryKind,
  entryCopy,
  t,
  tn,
  tcc,
  ti,
  tpk,
  values,
  setters,
  generatorSummary,
  onCardNumberChange,
  maxInputLength,
  showLengthError,
  showLuhnError,
  detectedBrand,
  hasBrandHint,
  lengthHint,
}: UseOrgEntrySpecificFieldsPropsFromStateArgs): OrgEntrySpecificFieldsProps {
  const callbacks = buildOrgEntrySpecificCallbacks(values, setters);

  return useOrgEntrySpecificFieldsProps({
    entryKind,
    entryCopy,
    t,
    tn,
    tcc,
    ti,
    tpk,
    notes: values.notes,
    onNotesChange: callbacks.onNotesChange,
    title: values.title,
    onTitleChange: callbacks.onTitleChange,
    username: values.username,
    onUsernameChange: callbacks.onUsernameChange,
    password: values.password,
    onPasswordChange: callbacks.onPasswordChange,
    showPassword: values.showPassword,
    onToggleShowPassword: callbacks.onToggleShowPassword,
    generatorSummary,
    showGenerator: values.showGenerator,
    onToggleGenerator: callbacks.onToggleGenerator,
    generatorSettings: values.generatorSettings as GeneratorSettings,
    onGeneratorUse: callbacks.onGeneratorUse,
    url: values.url,
    onUrlChange: callbacks.onUrlChange,
    content: values.content,
    onContentChange: callbacks.onContentChange,
    cardholderName: values.cardholderName,
    onCardholderNameChange: callbacks.onCardholderNameChange,
    brand: values.brand,
    onBrandChange: callbacks.onBrandChange,
    cardNumber: values.cardNumber,
    onCardNumberChange,
    showCardNumber: values.showCardNumber,
    onToggleCardNumber: callbacks.onToggleCardNumber,
    maxInputLength,
    showLengthError,
    showLuhnError,
    detectedBrand,
    hasBrandHint,
    lengthHint,
    expiryMonth: values.expiryMonth,
    onExpiryMonthChange: callbacks.onExpiryMonthChange,
    expiryYear: values.expiryYear,
    onExpiryYearChange: callbacks.onExpiryYearChange,
    cvv: values.cvv,
    onCvvChange: callbacks.onCvvChange,
    showCvv: values.showCvv,
    onToggleCvv: callbacks.onToggleCvv,
    fullName: values.fullName,
    onFullNameChange: callbacks.onFullNameChange,
    address: values.address,
    onAddressChange: callbacks.onAddressChange,
    phone: values.phone,
    onPhoneChange: callbacks.onPhoneChange,
    email: values.email,
    onEmailChange: callbacks.onEmailChange,
    dateOfBirth: values.dateOfBirth,
    onDateOfBirthChange: callbacks.onDateOfBirthChange,
    nationality: values.nationality,
    onNationalityChange: callbacks.onNationalityChange,
    idNumber: values.idNumber,
    onIdNumberChange: callbacks.onIdNumberChange,
    showIdNumber: values.showIdNumber,
    onToggleIdNumber: callbacks.onToggleIdNumber,
    issueDate: values.issueDate,
    onIssueDateChange: callbacks.onIssueDateChange,
    expiryDate: values.expiryDate,
    onExpiryDateChange: callbacks.onExpiryDateChange,
    dobError: values.dobError,
    expiryError: values.expiryError,
    relyingPartyId: values.relyingPartyId,
    onRelyingPartyIdChange: callbacks.onRelyingPartyIdChange,
    relyingPartyName: values.relyingPartyName,
    onRelyingPartyNameChange: callbacks.onRelyingPartyNameChange,
    credentialId: values.credentialId,
    onCredentialIdChange: callbacks.onCredentialIdChange,
    showCredentialId: values.showCredentialId,
    onToggleCredentialId: callbacks.onToggleCredentialId,
    creationDate: values.creationDate,
    onCreationDateChange: callbacks.onCreationDateChange,
    deviceInfo: values.deviceInfo,
    onDeviceInfoChange: callbacks.onDeviceInfoChange,
  });
}
