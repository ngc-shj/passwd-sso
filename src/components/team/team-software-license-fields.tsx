"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NotesField, TwoColumnFields, VisibilityToggleInput } from "@/components/team/team-form-fields";

interface TeamSoftwareLicenseFieldsProps {
  softwareName: string;
  onSoftwareNameChange: (value: string) => void;
  softwareNamePlaceholder: string;
  licenseKey: string;
  onLicenseKeyChange: (value: string) => void;
  licenseKeyPlaceholder: string;
  showLicenseKey: boolean;
  onToggleLicenseKey: () => void;
  version: string;
  onVersionChange: (value: string) => void;
  versionPlaceholder: string;
  licensee: string;
  onLicenseeChange: (value: string) => void;
  licenseePlaceholder: string;
  purchaseDate: string;
  onPurchaseDateChange: (value: string) => void;
  expirationDate: string;
  onExpirationDateChange: (value: string) => void;
  expiryError: string | null;
  notesLabel: string;
  notes: string;
  onNotesChange: (value: string) => void;
  notesPlaceholder: string;
  labels: {
    softwareName: string;
    licenseKey: string;
    version: string;
    licensee: string;
    purchaseDate: string;
    expirationDate: string;
  };
}

export function TeamSoftwareLicenseFields({
  softwareName,
  onSoftwareNameChange,
  softwareNamePlaceholder,
  licenseKey,
  onLicenseKeyChange,
  licenseKeyPlaceholder,
  showLicenseKey,
  onToggleLicenseKey,
  version,
  onVersionChange,
  versionPlaceholder,
  licensee,
  onLicenseeChange,
  licenseePlaceholder,
  purchaseDate,
  onPurchaseDateChange,
  expirationDate,
  onExpirationDateChange,
  expiryError,
  notesLabel,
  notes,
  onNotesChange,
  notesPlaceholder,
  labels,
}: TeamSoftwareLicenseFieldsProps) {
  return (
    <>
      <div className="space-y-2">
        <Label>{labels.softwareName}</Label>
        <Input
          value={softwareName}
          onChange={(e) => onSoftwareNameChange(e.target.value)}
          placeholder={softwareNamePlaceholder}
          autoComplete="off"
        />
      </div>

      <div className="space-y-2">
        <Label>{labels.licenseKey}</Label>
        <VisibilityToggleInput
          show={showLicenseKey}
          onToggle={onToggleLicenseKey}
          inputProps={{
            value: licenseKey,
            onChange: (e) => onLicenseKeyChange(e.target.value),
            placeholder: licenseKeyPlaceholder,
            autoComplete: "off",
          }}
        />
      </div>

      <TwoColumnFields
        left={(
          <>
            <Label>{labels.version}</Label>
            <Input
              value={version}
              onChange={(e) => onVersionChange(e.target.value)}
              placeholder={versionPlaceholder}
              autoComplete="off"
            />
          </>
        )}
        right={(
          <>
            <Label>{labels.licensee}</Label>
            <Input
              value={licensee}
              onChange={(e) => onLicenseeChange(e.target.value)}
              placeholder={licenseePlaceholder}
              autoComplete="off"
            />
          </>
        )}
      />

      <TwoColumnFields
        left={(
          <>
            <Label>{labels.purchaseDate}</Label>
            <Input
              type="date"
              value={purchaseDate}
              onChange={(e) => onPurchaseDateChange(e.target.value)}
            />
          </>
        )}
        right={(
          <>
            <Label>{labels.expirationDate}</Label>
            <Input
              type="date"
              value={expirationDate}
              onChange={(e) => onExpirationDateChange(e.target.value)}
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
