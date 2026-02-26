// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import type { GeneratorSettings } from "@/lib/generator-prefs";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator-prefs";
import { describe, expect, it, vi } from "vitest";
import { TeamEntrySpecificFields } from "@/components/team/team-entry-specific-fields";

vi.mock("@/components/passwords/entry-login-main-fields", () => ({
  EntryLoginMainFields: () => <div data-testid="org-login-fields" />,
}));
vi.mock("@/components/team/team-secure-note-fields", () => ({
  OrgSecureNoteFields: () => <div data-testid="org-secure-note-fields" />,
}));
vi.mock("@/components/team/team-credit-card-fields", () => ({
  OrgCreditCardFields: () => <div data-testid="org-credit-card-fields" />,
}));
vi.mock("@/components/team/team-identity-fields", () => ({
  OrgIdentityFields: () => <div data-testid="org-identity-fields" />,
}));
vi.mock("@/components/team/team-passkey-fields", () => ({
  OrgPasskeyFields: () => <div data-testid="org-passkey-fields" />,
}));

const baseGeneratorSettings: GeneratorSettings = {
  ...DEFAULT_GENERATOR_SETTINGS,
};

function renderSubject(entryKind: "password" | "secureNote" | "creditCard" | "identity" | "passkey") {
  return render(
    <TeamEntrySpecificFields
      entryKind={entryKind}
      notesLabel="notes"
      notesPlaceholder="notesPlaceholder"
      notes=""
      onNotesChange={vi.fn()}
      title="title"
      onTitleChange={vi.fn()}
      titleLabel="titleLabel"
      titlePlaceholder="titlePlaceholder"
      username="username"
      onUsernameChange={vi.fn()}
      usernameLabel="usernameLabel"
      usernamePlaceholder="usernamePlaceholder"
      password="password"
      onPasswordChange={vi.fn()}
      passwordLabel="passwordLabel"
      passwordPlaceholder="passwordPlaceholder"
      showPassword={false}
      onToggleShowPassword={vi.fn()}
      generatorSummary="summary"
      showGenerator={false}
      onToggleGenerator={vi.fn()}
      closeGeneratorLabel="close"
      openGeneratorLabel="open"
      generatorSettings={baseGeneratorSettings}
      onGeneratorUse={vi.fn()}
      url=""
      onUrlChange={vi.fn()}
      urlLabel="urlLabel"
      content=""
      onContentChange={vi.fn()}
      contentLabel="contentLabel"
      contentPlaceholder="contentPlaceholder"
      cardholderName=""
      onCardholderNameChange={vi.fn()}
      cardholderNamePlaceholder="cardholderNamePlaceholder"
      brand=""
      onBrandChange={vi.fn()}
      brandPlaceholder="brandPlaceholder"
      cardNumber=""
      onCardNumberChange={vi.fn()}
      cardNumberPlaceholder="cardNumberPlaceholder"
      showCardNumber={false}
      onToggleCardNumber={vi.fn()}
      maxInputLength={19}
      showLengthError={false}
      showLuhnError={false}
      hasBrandHint={false}
      lengthHintGenericLabel="lengthHintGenericLabel"
      lengthHintLabel="lengthHintLabel"
      invalidLengthLabel="invalidLengthLabel"
      invalidLuhnLabel="invalidLuhnLabel"
      creditCardLabels={{
        cardholderName: "cardholderName",
        brand: "brand",
        cardNumber: "cardNumber",
        expiry: "expiry",
        cvv: "cvv",
      }}
      expiryMonth=""
      onExpiryMonthChange={vi.fn()}
      expiryYear=""
      onExpiryYearChange={vi.fn()}
      expiryMonthPlaceholder="MM"
      expiryYearPlaceholder="YYYY"
      cvv=""
      onCvvChange={vi.fn()}
      cvvPlaceholder="cvvPlaceholder"
      showCvv={false}
      onToggleCvv={vi.fn()}
      fullName=""
      onFullNameChange={vi.fn()}
      fullNamePlaceholder="fullNamePlaceholder"
      address=""
      onAddressChange={vi.fn()}
      addressPlaceholder="addressPlaceholder"
      phone=""
      onPhoneChange={vi.fn()}
      phonePlaceholder="phonePlaceholder"
      email=""
      onEmailChange={vi.fn()}
      emailPlaceholder="emailPlaceholder"
      dateOfBirth=""
      onDateOfBirthChange={vi.fn()}
      nationality=""
      onNationalityChange={vi.fn()}
      nationalityPlaceholder="nationalityPlaceholder"
      idNumber=""
      onIdNumberChange={vi.fn()}
      idNumberPlaceholder="idNumberPlaceholder"
      showIdNumber={false}
      onToggleIdNumber={vi.fn()}
      issueDate=""
      onIssueDateChange={vi.fn()}
      expiryDate=""
      onExpiryDateChange={vi.fn()}
      dobError={null}
      expiryError={null}
      identityLabels={{
        fullName: "fullName",
        address: "address",
        phone: "phone",
        email: "email",
        dateOfBirth: "dateOfBirth",
        nationality: "nationality",
        idNumber: "idNumber",
        issueDate: "issueDate",
        expiryDate: "expiryDate",
      }}
      relyingPartyId=""
      onRelyingPartyIdChange={vi.fn()}
      relyingPartyIdPlaceholder="relyingPartyIdPlaceholder"
      relyingPartyName=""
      onRelyingPartyNameChange={vi.fn()}
      relyingPartyNamePlaceholder="relyingPartyNamePlaceholder"
      credentialId=""
      onCredentialIdChange={vi.fn()}
      credentialIdPlaceholder="credentialIdPlaceholder"
      showCredentialId={false}
      onToggleCredentialId={vi.fn()}
      creationDate=""
      onCreationDateChange={vi.fn()}
      deviceInfo=""
      onDeviceInfoChange={vi.fn()}
      deviceInfoPlaceholder="deviceInfoPlaceholder"
      passkeyLabels={{
        relyingPartyId: "relyingPartyId",
        relyingPartyName: "relyingPartyName",
        username: "username",
        credentialId: "credentialId",
        creationDate: "creationDate",
        deviceInfo: "deviceInfo",
      }}
    />,
  );
}

describe("TeamEntrySpecificFields", () => {
  it("renders login fields for password kind", () => {
    renderSubject("password");
    expect(screen.getByTestId("org-login-fields")).toBeTruthy();
  });

  it("renders passkey fields for passkey kind", () => {
    renderSubject("passkey");
    expect(screen.getByTestId("org-passkey-fields")).toBeTruthy();
  });
});
