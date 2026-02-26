"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NotesField, TwoColumnFields, VisibilityToggleInput } from "@/components/team/team-form-fields";

interface OrgPasskeyFieldsProps {
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
}

export function OrgPasskeyFields({
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
}: OrgPasskeyFieldsProps) {
  return (
    <>
      <div className="space-y-2">
        <Label>{labels.relyingPartyId}</Label>
        <Input
          value={relyingPartyId}
          onChange={(e) => onRelyingPartyIdChange(e.target.value)}
          placeholder={relyingPartyIdPlaceholder}
          autoComplete="off"
        />
      </div>

      <div className="space-y-2">
        <Label>{labels.relyingPartyName}</Label>
        <Input
          value={relyingPartyName}
          onChange={(e) => onRelyingPartyNameChange(e.target.value)}
          placeholder={relyingPartyNamePlaceholder}
          autoComplete="off"
        />
      </div>

      <div className="space-y-2">
        <Label>{labels.username}</Label>
        <Input
          value={username}
          onChange={(e) => onUsernameChange(e.target.value)}
          placeholder={usernamePlaceholder}
          autoComplete="off"
        />
      </div>

      <div className="space-y-2">
        <Label>{labels.credentialId}</Label>
        <VisibilityToggleInput
          show={showCredentialId}
          onToggle={onToggleCredentialId}
          inputProps={{
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
            <Label>{labels.creationDate}</Label>
            <Input
              type="date"
              value={creationDate}
              onChange={(e) => onCreationDateChange(e.target.value)}
            />
          </>
        )}
        right={(
          <>
            <Label>{labels.deviceInfo}</Label>
            <Input
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
