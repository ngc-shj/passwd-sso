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
  const phoneId = `${idPrefix}phone`;
  const emailId = `${idPrefix}email`;
  const dateOfBirthId = `${idPrefix}dateOfBirth`;
  const nationalityId = `${idPrefix}nationality`;
  const idNumberId = `${idPrefix}idNumber`;
  const issueDateId = `${idPrefix}issueDate`;
  const expiryDateId = `${idPrefix}expiryDate`;

  return (
    <>
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
