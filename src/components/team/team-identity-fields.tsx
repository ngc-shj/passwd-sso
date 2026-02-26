"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NotesField, TwoColumnFields, VisibilityToggleInput } from "@/components/team/team-form-fields";

interface OrgIdentityFieldsProps {
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
}

export function OrgIdentityFields({
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
}: OrgIdentityFieldsProps) {
  return (
    <>
      <div className="space-y-2">
        <Label>{labels.fullName}</Label>
        <Input
          value={fullName}
          onChange={(e) => onFullNameChange(e.target.value)}
          placeholder={fullNamePlaceholder}
          autoComplete="off"
        />
      </div>

      <div className="space-y-2">
        <Label>{labels.address}</Label>
        <Textarea
          value={address}
          onChange={(e) => onAddressChange(e.target.value)}
          placeholder={addressPlaceholder}
          rows={2}
          autoComplete="off"
        />
      </div>

      <TwoColumnFields
        left={(
          <>
            <Label>{labels.phone}</Label>
            <Input
              type="tel"
              value={phone}
              onChange={(e) => onPhoneChange(e.target.value)}
              placeholder={phonePlaceholder}
              autoComplete="off"
            />
          </>
        )}
        right={(
          <>
            <Label>{labels.email}</Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => onEmailChange(e.target.value)}
              placeholder={emailPlaceholder}
              autoComplete="off"
            />
          </>
        )}
      />

      <TwoColumnFields
        left={(
          <>
            <Label>{labels.dateOfBirth}</Label>
            <Input
              type="date"
              value={dateOfBirth}
              onChange={(e) => onDateOfBirthChange(e.target.value)}
            />
          </>
        )}
        right={(
          <>
            <Label>{labels.nationality}</Label>
            <Input
              value={nationality}
              onChange={(e) => onNationalityChange(e.target.value)}
              placeholder={nationalityPlaceholder}
              autoComplete="off"
            />
          </>
        )}
      />
      {dobError && <p className="text-sm text-destructive">{dobError}</p>}

      <div className="space-y-2">
        <Label>{labels.idNumber}</Label>
        <VisibilityToggleInput
          show={showIdNumber}
          onToggle={onToggleIdNumber}
          inputProps={{
            value: idNumber,
            onChange: (e) => onIdNumberChange(e.target.value),
            placeholder: idNumberPlaceholder,
            autoComplete: "off",
          }}
        />
      </div>

      <TwoColumnFields
        left={(
          <>
            <Label>{labels.issueDate}</Label>
            <Input
              type="date"
              value={issueDate}
              onChange={(e) => onIssueDateChange(e.target.value)}
            />
          </>
        )}
        right={(
          <>
            <Label>{labels.expiryDate}</Label>
            <Input
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
