"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NotesField, TwoColumnFields, VisibilityToggleInput } from "@/components/entry-fields/form-fields";
import { ENTRY_NAME_MAX, ENTRY_SHORT_MAX, ENTRY_SECRET_MAX, NAME_MAX_LENGTH } from "@/lib/validations";

interface IdentityFieldsProps {
  fullName: string;
  onFullNameChange: (value: string) => void;
  fullNamePlaceholder: string;
  address: string;
  onAddressChange: (value: string) => void;
  addressPlaceholder: string;
  // Structured name
  givenName: string;
  onGivenNameChange: (value: string) => void;
  givenNamePlaceholder: string;
  familyName: string;
  onFamilyNameChange: (value: string) => void;
  familyNamePlaceholder: string;
  middleName: string;
  onMiddleNameChange: (value: string) => void;
  middleNamePlaceholder: string;
  familyNameKana: string;
  onFamilyNameKanaChange: (value: string) => void;
  familyNameKanaPlaceholder: string;
  givenNameKana: string;
  onGivenNameKanaChange: (value: string) => void;
  givenNameKanaPlaceholder: string;
  // Structured address
  addressLine1: string;
  onAddressLine1Change: (value: string) => void;
  addressLine1Placeholder: string;
  addressLine2: string;
  onAddressLine2Change: (value: string) => void;
  addressLine2Placeholder: string;
  city: string;
  onCityChange: (value: string) => void;
  cityPlaceholder: string;
  state: string;
  onStateChange: (value: string) => void;
  statePlaceholder: string;
  postalCode: string;
  onPostalCodeChange: (value: string) => void;
  postalCodePlaceholder: string;
  country: string;
  onCountryChange: (value: string) => void;
  countryPlaceholder: string;
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
  notesLabel: string;
  notes: string;
  onNotesChange: (value: string) => void;
  notesPlaceholder: string;
  labels: {
    fullName: string;
    address: string;
    givenName: string;
    familyName: string;
    middleName: string;
    familyNameKana: string;
    givenNameKana: string;
    addressLine1: string;
    addressLine2: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    nameGroup: string;
    addressGroup: string;
    phone: string;
    email: string;
    dateOfBirth: string;
    nationality: string;
    idNumber: string;
    issueDate: string;
    expiryDate: string;
  };
  idPrefix?: string;
}

export function IdentityFields({
  fullName,
  onFullNameChange,
  fullNamePlaceholder,
  address,
  onAddressChange,
  addressPlaceholder,
  givenName,
  onGivenNameChange,
  givenNamePlaceholder,
  familyName,
  onFamilyNameChange,
  familyNamePlaceholder,
  middleName,
  onMiddleNameChange,
  middleNamePlaceholder,
  familyNameKana,
  onFamilyNameKanaChange,
  familyNameKanaPlaceholder,
  givenNameKana,
  onGivenNameKanaChange,
  givenNameKanaPlaceholder,
  addressLine1,
  onAddressLine1Change,
  addressLine1Placeholder,
  addressLine2,
  onAddressLine2Change,
  addressLine2Placeholder,
  city,
  onCityChange,
  cityPlaceholder,
  state,
  onStateChange,
  statePlaceholder,
  postalCode,
  onPostalCodeChange,
  postalCodePlaceholder,
  country,
  onCountryChange,
  countryPlaceholder,
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
  notesLabel,
  notes,
  onNotesChange,
  notesPlaceholder,
  labels,
  idPrefix = "",
}: IdentityFieldsProps) {
  const fullNameId = `${idPrefix}fullName`;
  const addressId = `${idPrefix}address`;
  const givenNameId = `${idPrefix}givenName`;
  const familyNameId = `${idPrefix}familyName`;
  const middleNameId = `${idPrefix}middleName`;
  const familyNameKanaId = `${idPrefix}familyNameKana`;
  const givenNameKanaId = `${idPrefix}givenNameKana`;
  const addressLine1Id = `${idPrefix}addressLine1`;
  const addressLine2Id = `${idPrefix}addressLine2`;
  const cityId = `${idPrefix}city`;
  const stateId = `${idPrefix}state`;
  const postalCodeId = `${idPrefix}postalCode`;
  const countryId = `${idPrefix}country`;
  const phoneId = `${idPrefix}phone`;
  const emailId = `${idPrefix}email`;
  const dateOfBirthId = `${idPrefix}dateOfBirth`;
  const nationalityId = `${idPrefix}nationality`;
  const idNumberId = `${idPrefix}idNumber`;
  const issueDateId = `${idPrefix}issueDate`;
  const expiryDateId = `${idPrefix}expiryDate`;

  return (
    <>
      {/* Structured name group */}
      <div className="text-sm font-medium text-muted-foreground">{labels.nameGroup}</div>
      <TwoColumnFields
        left={(
          <>
            <Label htmlFor={familyNameId}>{labels.familyName}</Label>
            <Input
              id={familyNameId}
              value={familyName}
              onChange={(e) => onFamilyNameChange(e.target.value)}
              placeholder={familyNamePlaceholder}
              maxLength={ENTRY_NAME_MAX}
              autoComplete="off"
            />
          </>
        )}
        right={(
          <>
            <Label htmlFor={givenNameId}>{labels.givenName}</Label>
            <Input
              id={givenNameId}
              value={givenName}
              onChange={(e) => onGivenNameChange(e.target.value)}
              placeholder={givenNamePlaceholder}
              maxLength={ENTRY_NAME_MAX}
              autoComplete="off"
            />
          </>
        )}
      />

      <div className="space-y-2">
        <Label htmlFor={middleNameId}>{labels.middleName}</Label>
        <Input
          id={middleNameId}
          value={middleName}
          onChange={(e) => onMiddleNameChange(e.target.value)}
          placeholder={middleNamePlaceholder}
          maxLength={ENTRY_NAME_MAX}
          autoComplete="off"
        />
      </div>

      <TwoColumnFields
        left={(
          <>
            <Label htmlFor={familyNameKanaId}>{labels.familyNameKana}</Label>
            <Input
              id={familyNameKanaId}
              value={familyNameKana}
              onChange={(e) => onFamilyNameKanaChange(e.target.value)}
              placeholder={familyNameKanaPlaceholder}
              maxLength={ENTRY_NAME_MAX}
              autoComplete="off"
            />
          </>
        )}
        right={(
          <>
            <Label htmlFor={givenNameKanaId}>{labels.givenNameKana}</Label>
            <Input
              id={givenNameKanaId}
              value={givenNameKana}
              onChange={(e) => onGivenNameKanaChange(e.target.value)}
              placeholder={givenNameKanaPlaceholder}
              maxLength={ENTRY_NAME_MAX}
              autoComplete="off"
            />
          </>
        )}
      />

      {/* Combined full name — retained for legacy entries / combined-form fill */}
      <div className="space-y-2">
        <Label htmlFor={fullNameId}>{labels.fullName}</Label>
        <Input
          id={fullNameId}
          value={fullName}
          onChange={(e) => onFullNameChange(e.target.value)}
          placeholder={fullNamePlaceholder}
          maxLength={ENTRY_NAME_MAX}
          autoComplete="off"
        />
      </div>

      {/* Structured address group */}
      <div className="text-sm font-medium text-muted-foreground">{labels.addressGroup}</div>
      <div className="space-y-2">
        <Label htmlFor={addressLine1Id}>{labels.addressLine1}</Label>
        <Input
          id={addressLine1Id}
          value={addressLine1}
          onChange={(e) => onAddressLine1Change(e.target.value)}
          placeholder={addressLine1Placeholder}
          maxLength={ENTRY_SECRET_MAX}
          autoComplete="off"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={addressLine2Id}>{labels.addressLine2}</Label>
        <Input
          id={addressLine2Id}
          value={addressLine2}
          onChange={(e) => onAddressLine2Change(e.target.value)}
          placeholder={addressLine2Placeholder}
          maxLength={ENTRY_SECRET_MAX}
          autoComplete="off"
        />
      </div>

      <TwoColumnFields
        left={(
          <>
            <Label htmlFor={cityId}>{labels.city}</Label>
            <Input
              id={cityId}
              value={city}
              onChange={(e) => onCityChange(e.target.value)}
              placeholder={cityPlaceholder}
              maxLength={ENTRY_SHORT_MAX}
              autoComplete="off"
            />
          </>
        )}
        right={(
          <>
            <Label htmlFor={stateId}>{labels.state}</Label>
            <Input
              id={stateId}
              value={state}
              onChange={(e) => onStateChange(e.target.value)}
              placeholder={statePlaceholder}
              maxLength={ENTRY_SHORT_MAX}
              autoComplete="off"
            />
          </>
        )}
      />

      <TwoColumnFields
        left={(
          <>
            <Label htmlFor={postalCodeId}>{labels.postalCode}</Label>
            <Input
              id={postalCodeId}
              value={postalCode}
              onChange={(e) => onPostalCodeChange(e.target.value)}
              placeholder={postalCodePlaceholder}
              maxLength={ENTRY_SHORT_MAX}
              autoComplete="off"
            />
          </>
        )}
        right={(
          <>
            <Label htmlFor={countryId}>{labels.country}</Label>
            <Input
              id={countryId}
              value={country}
              onChange={(e) => onCountryChange(e.target.value)}
              placeholder={countryPlaceholder}
              maxLength={ENTRY_SHORT_MAX}
              autoComplete="off"
            />
          </>
        )}
      />

      {/* Combined address — retained for legacy entries / combined-form fill */}
      <div className="space-y-2">
        <Label htmlFor={addressId}>{labels.address}</Label>
        <Textarea
          id={addressId}
          value={address}
          onChange={(e) => onAddressChange(e.target.value)}
          placeholder={addressPlaceholder}
          rows={2}
          maxLength={ENTRY_SECRET_MAX}
          autoComplete="off"
        />
      </div>

      <TwoColumnFields
        left={(
          <>
            <Label htmlFor={phoneId}>{labels.phone}</Label>
            <Input
              id={phoneId}
              type="tel"
              value={phone}
              onChange={(e) => onPhoneChange(e.target.value)}
              placeholder={phonePlaceholder}
              maxLength={ENTRY_SHORT_MAX}
              autoComplete="off"
            />
          </>
        )}
        right={(
          <>
            <Label htmlFor={emailId}>{labels.email}</Label>
            <Input
              id={emailId}
              type="email"
              value={email}
              onChange={(e) => onEmailChange(e.target.value)}
              placeholder={emailPlaceholder}
              maxLength={ENTRY_NAME_MAX}
              autoComplete="off"
            />
          </>
        )}
      />

      <TwoColumnFields
        left={(
          <>
            <Label htmlFor={dateOfBirthId}>{labels.dateOfBirth}</Label>
            <Input
              id={dateOfBirthId}
              type="date"
              value={dateOfBirth}
              onChange={(e) => onDateOfBirthChange(e.target.value)}
            />
          </>
        )}
        right={(
          <>
            <Label htmlFor={nationalityId}>{labels.nationality}</Label>
            <Input
              id={nationalityId}
              value={nationality}
              onChange={(e) => onNationalityChange(e.target.value)}
              placeholder={nationalityPlaceholder}
              maxLength={NAME_MAX_LENGTH}
              autoComplete="off"
            />
          </>
        )}
      />
      {dobError && <p className="text-sm text-destructive">{dobError}</p>}

      <div className="space-y-2">
        <Label htmlFor={idNumberId}>{labels.idNumber}</Label>
        <VisibilityToggleInput
          show={showIdNumber}
          onToggle={onToggleIdNumber}
          inputProps={{
            id: idNumberId,
            value: idNumber,
            onChange: (e) => onIdNumberChange(e.target.value),
            placeholder: idNumberPlaceholder,
            maxLength: NAME_MAX_LENGTH,
            autoComplete: "off",
          }}
        />
      </div>

      <TwoColumnFields
        left={(
          <>
            <Label htmlFor={issueDateId}>{labels.issueDate}</Label>
            <Input
              id={issueDateId}
              type="date"
              value={issueDate}
              onChange={(e) => onIssueDateChange(e.target.value)}
            />
          </>
        )}
        right={(
          <>
            <Label htmlFor={expiryDateId}>{labels.expiryDate}</Label>
            <Input
              id={expiryDateId}
              type="date"
              value={expiryDate}
              onChange={(e) => onExpiryDateChange(e.target.value)}
            />
          </>
        )}
      />
      {expiryError && <p className="text-sm text-destructive">{expiryError}</p>}

      <NotesField
        label={notesLabel}
        value={notes}
        onChange={onNotesChange}
        placeholder={notesPlaceholder}
      />
    </>
  );
}
