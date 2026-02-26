"use client";

import { CARD_BRANDS } from "@/lib/credit-card";
import type { GeneratorSettings } from "@/lib/generator-prefs";
import { OrgCreditCardFields } from "@/components/team/team-credit-card-fields";
import { OrgIdentityFields } from "@/components/team/team-identity-fields";
import { OrgPasskeyFields } from "@/components/team/team-passkey-fields";
import { OrgSecureNoteFields } from "@/components/team/team-secure-note-fields";
import type { TeamEntryKind } from "@/components/team/team-password-form-types";
import { EntryLoginMainFields } from "@/components/passwords/entry-login-main-fields";

interface TeamEntrySpecificFieldsProps {
  entryKind: TeamEntryKind;
  notesLabel: string;
  notesPlaceholder: string;
  notes: string;
  onNotesChange: (value: string) => void;
  // login
  title: string;
  onTitleChange: (value: string) => void;
  titleLabel: string;
  titlePlaceholder: string;
  username: string;
  onUsernameChange: (value: string) => void;
  usernameLabel: string;
  usernamePlaceholder: string;
  password: string;
  onPasswordChange: (value: string) => void;
  passwordLabel: string;
  passwordPlaceholder: string;
  showPassword: boolean;
  onToggleShowPassword: () => void;
  generatorSummary: string;
  showGenerator: boolean;
  onToggleGenerator: () => void;
  closeGeneratorLabel: string;
  openGeneratorLabel: string;
  generatorSettings: GeneratorSettings;
  onGeneratorUse: (password: string, settings: GeneratorSettings) => void;
  url: string;
  onUrlChange: (value: string) => void;
  urlLabel: string;
  // secure note
  content: string;
  onContentChange: (value: string) => void;
  contentLabel: string;
  contentPlaceholder: string;
  // credit card
  cardholderName: string;
  onCardholderNameChange: (value: string) => void;
  cardholderNamePlaceholder: string;
  brand: string;
  onBrandChange: (value: string) => void;
  brandPlaceholder: string;
  cardNumber: string;
  onCardNumberChange: (value: string) => void;
  cardNumberPlaceholder: string;
  showCardNumber: boolean;
  onToggleCardNumber: () => void;
  maxInputLength: number;
  showLengthError: boolean;
  showLuhnError: boolean;
  detectedBrand?: string;
  hasBrandHint: boolean;
  lengthHintGenericLabel: string;
  lengthHintLabel: string;
  invalidLengthLabel: string;
  invalidLuhnLabel: string;
  creditCardLabels: {
    cardholderName: string;
    brand: string;
    cardNumber: string;
    expiry: string;
    cvv: string;
  };
  expiryMonth: string;
  onExpiryMonthChange: (value: string) => void;
  expiryYear: string;
  onExpiryYearChange: (value: string) => void;
  expiryMonthPlaceholder: string;
  expiryYearPlaceholder: string;
  cvv: string;
  onCvvChange: (value: string) => void;
  cvvPlaceholder: string;
  showCvv: boolean;
  onToggleCvv: () => void;
  // identity
  fullName: string;
  onFullNameChange: (value: string) => void;
  fullNamePlaceholder: string;
  address: string;
  onAddressChange: (value: string) => void;
  addressPlaceholder: string;
  phone: string;
  onPhoneChange: (value: string) => void;
  phonePlaceholder: string;
  email: string;
  onEmailChange: (value: string) => void;
  emailPlaceholder: string;
  dateOfBirth: string;
  onDateOfBirthChange: (value: string) => void;
  nationality: string;
  onNationalityChange: (value: string) => void;
  nationalityPlaceholder: string;
  idNumber: string;
  onIdNumberChange: (value: string) => void;
  idNumberPlaceholder: string;
  showIdNumber: boolean;
  onToggleIdNumber: () => void;
  issueDate: string;
  onIssueDateChange: (value: string) => void;
  expiryDate: string;
  onExpiryDateChange: (value: string) => void;
  dobError: string | null;
  expiryError: string | null;
  identityLabels: {
    fullName: string;
    address: string;
    phone: string;
    email: string;
    dateOfBirth: string;
    nationality: string;
    idNumber: string;
    issueDate: string;
    expiryDate: string;
  };
  // passkey
  relyingPartyId: string;
  onRelyingPartyIdChange: (value: string) => void;
  relyingPartyIdPlaceholder: string;
  relyingPartyName: string;
  onRelyingPartyNameChange: (value: string) => void;
  relyingPartyNamePlaceholder: string;
  credentialId: string;
  onCredentialIdChange: (value: string) => void;
  credentialIdPlaceholder: string;
  showCredentialId: boolean;
  onToggleCredentialId: () => void;
  creationDate: string;
  onCreationDateChange: (value: string) => void;
  deviceInfo: string;
  onDeviceInfoChange: (value: string) => void;
  deviceInfoPlaceholder: string;
  passkeyLabels: {
    relyingPartyId: string;
    relyingPartyName: string;
    username: string;
    credentialId: string;
    creationDate: string;
    deviceInfo: string;
  };
}

export function TeamEntrySpecificFields({
  entryKind,
  notesLabel,
  notesPlaceholder,
  notes,
  onNotesChange,
  title,
  onTitleChange,
  titleLabel,
  titlePlaceholder,
  username,
  onUsernameChange,
  usernameLabel,
  usernamePlaceholder,
  password,
  onPasswordChange,
  passwordLabel,
  passwordPlaceholder,
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
  content,
  onContentChange,
  contentLabel,
  contentPlaceholder,
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
}: TeamEntrySpecificFieldsProps) {
  switch (entryKind) {
    case "passkey":
      return (
        <OrgPasskeyFields
          relyingPartyId={relyingPartyId}
          onRelyingPartyIdChange={onRelyingPartyIdChange}
          relyingPartyIdPlaceholder={relyingPartyIdPlaceholder}
          relyingPartyName={relyingPartyName}
          onRelyingPartyNameChange={onRelyingPartyNameChange}
          relyingPartyNamePlaceholder={relyingPartyNamePlaceholder}
          username={username}
          onUsernameChange={onUsernameChange}
          usernamePlaceholder={usernamePlaceholder}
          credentialId={credentialId}
          onCredentialIdChange={onCredentialIdChange}
          credentialIdPlaceholder={credentialIdPlaceholder}
          showCredentialId={showCredentialId}
          onToggleCredentialId={onToggleCredentialId}
          creationDate={creationDate}
          onCreationDateChange={onCreationDateChange}
          deviceInfo={deviceInfo}
          onDeviceInfoChange={onDeviceInfoChange}
          deviceInfoPlaceholder={deviceInfoPlaceholder}
          notesLabel={notesLabel}
          notes={notes}
          onNotesChange={onNotesChange}
          notesPlaceholder={notesPlaceholder}
          labels={passkeyLabels}
        />
      );
    case "identity":
      return (
        <OrgIdentityFields
          fullName={fullName}
          onFullNameChange={onFullNameChange}
          fullNamePlaceholder={fullNamePlaceholder}
          address={address}
          onAddressChange={onAddressChange}
          addressPlaceholder={addressPlaceholder}
          phone={phone}
          onPhoneChange={onPhoneChange}
          phonePlaceholder={phonePlaceholder}
          email={email}
          onEmailChange={onEmailChange}
          emailPlaceholder={emailPlaceholder}
          dateOfBirth={dateOfBirth}
          onDateOfBirthChange={onDateOfBirthChange}
          nationality={nationality}
          onNationalityChange={onNationalityChange}
          nationalityPlaceholder={nationalityPlaceholder}
          idNumber={idNumber}
          onIdNumberChange={onIdNumberChange}
          idNumberPlaceholder={idNumberPlaceholder}
          showIdNumber={showIdNumber}
          onToggleIdNumber={onToggleIdNumber}
          issueDate={issueDate}
          onIssueDateChange={onIssueDateChange}
          expiryDate={expiryDate}
          onExpiryDateChange={onExpiryDateChange}
          dobError={dobError}
          expiryError={expiryError}
          notesLabel={notesLabel}
          notes={notes}
          onNotesChange={onNotesChange}
          notesPlaceholder={notesPlaceholder}
          labels={identityLabels}
        />
      );
    case "creditCard":
      return (
        <OrgCreditCardFields
          cardholderName={cardholderName}
          onCardholderNameChange={onCardholderNameChange}
          cardholderNamePlaceholder={cardholderNamePlaceholder}
          brand={brand}
          onBrandChange={onBrandChange}
          brandPlaceholder={brandPlaceholder}
          brands={CARD_BRANDS}
          cardNumber={cardNumber}
          onCardNumberChange={onCardNumberChange}
          cardNumberPlaceholder={cardNumberPlaceholder}
          showCardNumber={showCardNumber}
          onToggleCardNumber={onToggleCardNumber}
          maxInputLength={maxInputLength}
          showLengthError={showLengthError}
          showLuhnError={showLuhnError}
          detectedBrand={detectedBrand}
          hasBrandHint={hasBrandHint}
          lengthHintGenericLabel={lengthHintGenericLabel}
          lengthHintLabel={lengthHintLabel}
          invalidLengthLabel={invalidLengthLabel}
          invalidLuhnLabel={invalidLuhnLabel}
          expiryMonth={expiryMonth}
          onExpiryMonthChange={onExpiryMonthChange}
          expiryYear={expiryYear}
          onExpiryYearChange={onExpiryYearChange}
          expiryMonthPlaceholder={expiryMonthPlaceholder}
          expiryYearPlaceholder={expiryYearPlaceholder}
          cvv={cvv}
          onCvvChange={onCvvChange}
          cvvPlaceholder={cvvPlaceholder}
          showCvv={showCvv}
          onToggleCvv={onToggleCvv}
          notesLabel={notesLabel}
          notes={notes}
          onNotesChange={onNotesChange}
          notesPlaceholder={notesPlaceholder}
          labels={creditCardLabels}
        />
      );
    case "secureNote":
      return (
        <OrgSecureNoteFields
          content={content}
          onContentChange={onContentChange}
          contentLabel={contentLabel}
          contentPlaceholder={contentPlaceholder}
        />
      );
    case "password":
    default:
      return (
        <EntryLoginMainFields
          idPrefix="org-"
          hideTitle
          title={title}
          onTitleChange={onTitleChange}
          titleLabel={titleLabel}
          titlePlaceholder={titlePlaceholder}
          username={username}
          onUsernameChange={onUsernameChange}
          usernameLabel={usernameLabel}
          usernamePlaceholder={usernamePlaceholder}
          password={password}
          onPasswordChange={onPasswordChange}
          passwordLabel={passwordLabel}
          passwordPlaceholder={passwordPlaceholder}
          showPassword={showPassword}
          onToggleShowPassword={onToggleShowPassword}
          generatorSummary={generatorSummary}
          showGenerator={showGenerator}
          onToggleGenerator={onToggleGenerator}
          closeGeneratorLabel={closeGeneratorLabel}
          openGeneratorLabel={openGeneratorLabel}
          generatorSettings={generatorSettings}
          onGeneratorUse={onGeneratorUse}
          url={url}
          onUrlChange={onUrlChange}
          urlLabel={urlLabel}
          notes={notes}
          onNotesChange={onNotesChange}
          notesLabel={notesLabel}
          notesPlaceholder={notesPlaceholder}
        />
      );
  }
}
