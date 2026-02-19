"use client";

import type { ComponentProps } from "react";
import { OrgEntrySpecificFields } from "@/components/org/org-entry-specific-fields";
import type { GeneratorSettings } from "@/lib/generator-prefs";
import type { OrgPasswordFormTranslations } from "@/hooks/use-entry-form-translations";
import type {
  OrgPasswordFormValues,
  OrgPasswordFormSettersState,
} from "@/hooks/use-org-password-form-state";

export type OrgEntrySpecificFieldsProps = ComponentProps<typeof OrgEntrySpecificFields>;
type OrgEntrySpecificFieldTranslations = Pick<
  OrgPasswordFormTranslations,
  "t" | "tn" | "tcc" | "ti" | "tpk"
>;

type OrgEntrySpecificComputedProps =
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

export function buildOrgEntrySpecificFieldsProps({
  entryKind,
  entryCopy,
  translations,
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
  const { t, tn, tcc, ti, tpk } = translations;
  const closeGeneratorLabel = t("closeGenerator");
  const openGeneratorLabel = t("openGenerator");
  const urlLabel = t("url");
  const contentLabel = tn("content");
  const contentPlaceholder = tn("contentPlaceholder");

  const cardholderNamePlaceholder = tcc("cardholderNamePlaceholder");
  const brandPlaceholder = tcc("brandPlaceholder");
  const cardNumberPlaceholder = tcc("cardNumberPlaceholder");
  const lengthHintGenericLabel = tcc("cardNumberLengthHintGeneric");
  const lengthHintLabel = tcc("cardNumberLengthHint", { lengths: lengthHint });
  const invalidLengthLabel = tcc("cardNumberInvalidLength", { lengths: lengthHint });
  const invalidLuhnLabel = tcc("cardNumberInvalidLuhn");
  const expiryMonthPlaceholder = tcc("expiryMonth");
  const expiryYearPlaceholder = tcc("expiryYear");
  const cvvPlaceholder = tcc("cvvPlaceholder");
  const creditCardLabels = {
    cardholderName: tcc("cardholderName"),
    brand: tcc("brand"),
    cardNumber: tcc("cardNumber"),
    expiry: tcc("expiry"),
    cvv: tcc("cvv"),
  };

  const fullNamePlaceholder = ti("fullNamePlaceholder");
  const addressPlaceholder = ti("addressPlaceholder");
  const phonePlaceholder = ti("phonePlaceholder");
  const emailPlaceholder = ti("emailPlaceholder");
  const nationalityPlaceholder = ti("nationalityPlaceholder");
  const idNumberPlaceholder = ti("idNumberPlaceholder");
  const identityLabels = {
    fullName: ti("fullName"),
    address: ti("address"),
    phone: ti("phone"),
    email: ti("email"),
    dateOfBirth: ti("dateOfBirth"),
    nationality: ti("nationality"),
    idNumber: ti("idNumber"),
    issueDate: ti("issueDate"),
    expiryDate: ti("expiryDate"),
  };

  const relyingPartyIdPlaceholder = tpk("relyingPartyIdPlaceholder");
  const relyingPartyNamePlaceholder = tpk("relyingPartyNamePlaceholder");
  const credentialIdPlaceholder = tpk("credentialIdPlaceholder");
  const deviceInfoPlaceholder = tpk("deviceInfoPlaceholder");
  const passkeyLabels = {
    relyingPartyId: tpk("relyingPartyId"),
    relyingPartyName: tpk("relyingPartyName"),
    username: tpk("username"),
    credentialId: tpk("credentialId"),
    creationDate: tpk("creationDate"),
    deviceInfo: tpk("deviceInfo"),
  };

  return {
    entryKind,
    notesLabel: entryCopy.notesLabel,
    notesPlaceholder: entryCopy.notesPlaceholder,
    notes,
    onNotesChange,
    content,
    onContentChange,
    contentLabel,
    contentPlaceholder,
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
    closeGeneratorLabel,
    openGeneratorLabel,
    generatorSettings,
    onGeneratorUse,
    url,
    onUrlChange,
    urlLabel,
    cardholderName,
    onCardholderNameChange,
    cardholderNamePlaceholder,
    brand,
    onBrandChange,
    brandPlaceholder,
    cardNumber,
    onCardNumberChange,
    cardNumberPlaceholder,
    showCardNumber,
    onToggleCardNumber,
    maxInputLength,
    showLengthError,
    showLuhnError,
    detectedBrand,
    hasBrandHint,
    lengthHintGenericLabel,
    lengthHintLabel,
    invalidLengthLabel,
    invalidLuhnLabel,
    creditCardLabels,
    expiryMonth,
    onExpiryMonthChange,
    expiryYear,
    onExpiryYearChange,
    expiryMonthPlaceholder,
    expiryYearPlaceholder,
    cvv,
    onCvvChange,
    cvvPlaceholder,
    showCvv,
    onToggleCvv,
    fullName,
    onFullNameChange,
    fullNamePlaceholder,
    address,
    onAddressChange,
    addressPlaceholder,
    phone,
    onPhoneChange,
    phonePlaceholder,
    email,
    onEmailChange,
    emailPlaceholder,
    dateOfBirth,
    onDateOfBirthChange,
    nationality,
    onNationalityChange,
    nationalityPlaceholder,
    idNumber,
    onIdNumberChange,
    idNumberPlaceholder,
    showIdNumber,
    onToggleIdNumber,
    issueDate,
    onIssueDateChange,
    expiryDate,
    onExpiryDateChange,
    dobError,
    expiryError,
    identityLabels,
    relyingPartyId,
    onRelyingPartyIdChange,
    relyingPartyIdPlaceholder,
    relyingPartyName,
    onRelyingPartyNameChange,
    relyingPartyNamePlaceholder,
    credentialId,
    onCredentialIdChange,
    credentialIdPlaceholder,
    showCredentialId,
    onToggleCredentialId,
    creationDate,
    onCreationDateChange,
    deviceInfo,
    onDeviceInfoChange,
    deviceInfoPlaceholder,
    passkeyLabels,
  };
}

type UseOrgEntrySpecificFieldsPropsFromStateArgs = Pick<
  OrgEntrySpecificFieldsBuilderArgs,
  | "entryKind"
  | "entryCopy"
  | "translations"
  | "generatorSummary"
  | "maxInputLength"
  | "showLengthError"
  | "showLuhnError"
  | "detectedBrand"
  | "hasBrandHint"
  | "lengthHint"
  | "onCardNumberChange"
> & {
  values: OrgPasswordFormValues;
  setters: OrgPasswordFormSettersState;
};

function buildOrgEntrySpecificCallbacks(
  values: OrgPasswordFormValues,
  setters: OrgPasswordFormSettersState,
) {
  return {
    onNotesChange: setters.setNotes,
    onTitleChange: setters.setTitle,
    onUsernameChange: setters.setUsername,
    onPasswordChange: setters.setPassword,
    onToggleShowPassword: () => setters.setShowPassword(!values.showPassword),
    onToggleGenerator: () => setters.setShowGenerator(!values.showGenerator),
    onGeneratorUse: (pw: string, settings: GeneratorSettings) => {
      setters.setPassword(pw);
      setters.setShowPassword(true);
      setters.setGeneratorSettings(settings);
    },
    onUrlChange: setters.setUrl,
    onContentChange: setters.setContent,
    onCardholderNameChange: setters.setCardholderName,
    onBrandChange: (value: string) => {
      setters.setBrand(value);
      setters.setBrandSource("manual");
    },
    onToggleCardNumber: () => setters.setShowCardNumber(!values.showCardNumber),
    onExpiryMonthChange: setters.setExpiryMonth,
    onExpiryYearChange: setters.setExpiryYear,
    onCvvChange: setters.setCvv,
    onToggleCvv: () => setters.setShowCvv(!values.showCvv),
    onFullNameChange: setters.setFullName,
    onAddressChange: setters.setAddress,
    onPhoneChange: setters.setPhone,
    onEmailChange: setters.setEmail,
    onDateOfBirthChange: (value: string) => {
      setters.setDateOfBirth(value);
      setters.setDobError(null);
    },
    onNationalityChange: setters.setNationality,
    onIdNumberChange: setters.setIdNumber,
    onToggleIdNumber: () => setters.setShowIdNumber(!values.showIdNumber),
    onIssueDateChange: (value: string) => {
      setters.setIssueDate(value);
      setters.setExpiryError(null);
    },
    onExpiryDateChange: (value: string) => {
      setters.setExpiryDate(value);
      setters.setExpiryError(null);
    },
    onRelyingPartyIdChange: setters.setRelyingPartyId,
    onRelyingPartyNameChange: setters.setRelyingPartyName,
    onCredentialIdChange: setters.setCredentialId,
    onToggleCredentialId: () => setters.setShowCredentialId(!values.showCredentialId),
    onCreationDateChange: setters.setCreationDate,
    onDeviceInfoChange: setters.setDeviceInfo,
  };
}

export function useOrgEntrySpecificFieldsPropsFromState({
  entryKind,
  entryCopy,
  translations,
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

  return buildOrgEntrySpecificFieldsProps({
    entryKind,
    entryCopy,
    translations,
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
    generatorSettings: values.generatorSettings,
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
