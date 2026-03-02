"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NotesField, TwoColumnFields, VisibilityToggleInput } from "@/components/entry-fields/form-fields";

interface PasskeyFieldsProps {
  relyingPartyId: string;
  onRelyingPartyIdChange: (value: string) => void;
  relyingPartyIdPlaceholder: string;
  relyingPartyName: string;
  onRelyingPartyNameChange: (value: string) => void;
  relyingPartyNamePlaceholder: string;
  username: string;
  onUsernameChange: (value: string) => void;
  usernamePlaceholder: string;
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
  notesLabel: string;
  notes: string;
  onNotesChange: (value: string) => void;
  notesPlaceholder: string;
  labels: {
    relyingPartyId: string;
    relyingPartyName: string;
    username: string;
    credentialId: string;
    creationDate: string;
    deviceInfo: string;
  };
  idPrefix?: string;
}

export function PasskeyFields({
  relyingPartyId,
  onRelyingPartyIdChange,
  relyingPartyIdPlaceholder,
  relyingPartyName,
  onRelyingPartyNameChange,
  relyingPartyNamePlaceholder,
  username,
  onUsernameChange,
  usernamePlaceholder,
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
  notesLabel,
  notes,
  onNotesChange,
  notesPlaceholder,
  labels,
  idPrefix = "",
}: PasskeyFieldsProps) {
  const relyingPartyIdId = `${idPrefix}relyingPartyId`;
  const relyingPartyNameId = `${idPrefix}relyingPartyName`;
  const usernameId = `${idPrefix}username`;
  const credentialIdId = `${idPrefix}credentialId`;
  const creationDateId = `${idPrefix}creationDate`;
  const deviceInfoId = `${idPrefix}deviceInfo`;

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={relyingPartyIdId}>{labels.relyingPartyId}</Label>
        <Input
          id={relyingPartyIdId}
          value={relyingPartyId}
          onChange={(e) => onRelyingPartyIdChange(e.target.value)}
          placeholder={relyingPartyIdPlaceholder}
          autoComplete="off"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={relyingPartyNameId}>{labels.relyingPartyName}</Label>
        <Input
          id={relyingPartyNameId}
          value={relyingPartyName}
          onChange={(e) => onRelyingPartyNameChange(e.target.value)}
          placeholder={relyingPartyNamePlaceholder}
          autoComplete="off"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={usernameId}>{labels.username}</Label>
        <Input
          id={usernameId}
          value={username}
          onChange={(e) => onUsernameChange(e.target.value)}
          placeholder={usernamePlaceholder}
          autoComplete="off"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={credentialIdId}>{labels.credentialId}</Label>
        <VisibilityToggleInput
          show={showCredentialId}
          onToggle={onToggleCredentialId}
          inputProps={{
            id: credentialIdId,
            value: credentialId,
            onChange: (e) => onCredentialIdChange(e.target.value),
            placeholder: credentialIdPlaceholder,
            autoComplete: "off",
          }}
        />
      </div>

      <TwoColumnFields
        left={(
          <>
            <Label htmlFor={creationDateId}>{labels.creationDate}</Label>
            <Input
              id={creationDateId}
              type="date"
              value={creationDate}
              onChange={(e) => onCreationDateChange(e.target.value)}
            />
          </>
        )}
        right={(
          <>
            <Label htmlFor={deviceInfoId}>{labels.deviceInfo}</Label>
            <Input
              id={deviceInfoId}
              value={deviceInfo}
              onChange={(e) => onDeviceInfoChange(e.target.value)}
              placeholder={deviceInfoPlaceholder}
              autoComplete="off"
            />
          </>
        )}
      />

      <NotesField
        label={notesLabel}
        value={notes}
        onChange={onNotesChange}
        placeholder={notesPlaceholder}
      />
    </>
  );
}
