"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { NotesField, TwoColumnFields, VisibilityToggleInput } from "@/components/team/team-form-fields";

interface TeamBankAccountFieldsProps {
  bankName: string;
  onBankNameChange: (value: string) => void;
  bankNamePlaceholder: string;
  accountType: string;
  onAccountTypeChange: (value: string) => void;
  accountTypePlaceholder: string;
  accountTypeCheckingLabel: string;
  accountTypeSavingsLabel: string;
  accountTypeOtherLabel: string;
  accountHolderName: string;
  onAccountHolderNameChange: (value: string) => void;
  accountHolderNamePlaceholder: string;
  accountNumber: string;
  onAccountNumberChange: (value: string) => void;
  accountNumberPlaceholder: string;
  showAccountNumber: boolean;
  onToggleAccountNumber: () => void;
  routingNumber: string;
  onRoutingNumberChange: (value: string) => void;
  routingNumberPlaceholder: string;
  showRoutingNumber: boolean;
  onToggleRoutingNumber: () => void;
  swiftBic: string;
  onSwiftBicChange: (value: string) => void;
  swiftBicPlaceholder: string;
  iban: string;
  onIbanChange: (value: string) => void;
  ibanPlaceholder: string;
  branchName: string;
  onBranchNameChange: (value: string) => void;
  branchNamePlaceholder: string;
  notesLabel: string;
  notes: string;
  onNotesChange: (value: string) => void;
  notesPlaceholder: string;
  labels: {
    bankName: string;
    accountType: string;
    accountHolderName: string;
    accountNumber: string;
    routingNumber: string;
    swiftBic: string;
    iban: string;
    branchName: string;
  };
}

export function TeamBankAccountFields({
  bankName,
  onBankNameChange,
  bankNamePlaceholder,
  accountType,
  onAccountTypeChange,
  accountTypePlaceholder,
  accountTypeCheckingLabel,
  accountTypeSavingsLabel,
  accountTypeOtherLabel,
  accountHolderName,
  onAccountHolderNameChange,
  accountHolderNamePlaceholder,
  accountNumber,
  onAccountNumberChange,
  accountNumberPlaceholder,
  showAccountNumber,
  onToggleAccountNumber,
  routingNumber,
  onRoutingNumberChange,
  routingNumberPlaceholder,
  showRoutingNumber,
  onToggleRoutingNumber,
  swiftBic,
  onSwiftBicChange,
  swiftBicPlaceholder,
  iban,
  onIbanChange,
  ibanPlaceholder,
  branchName,
  onBranchNameChange,
  branchNamePlaceholder,
  notesLabel,
  notes,
  onNotesChange,
  notesPlaceholder,
  labels,
}: TeamBankAccountFieldsProps) {
  return (
    <>
      <div className="space-y-2">
        <Label>{labels.bankName}</Label>
        <Input
          value={bankName}
          onChange={(e) => onBankNameChange(e.target.value)}
          placeholder={bankNamePlaceholder}
          autoComplete="off"
        />
      </div>

      <TwoColumnFields
        left={(
          <>
            <Label>{labels.accountType}</Label>
            <Select value={accountType} onValueChange={onAccountTypeChange}>
              <SelectTrigger>
                <SelectValue placeholder={accountTypePlaceholder} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="checking">{accountTypeCheckingLabel}</SelectItem>
                <SelectItem value="savings">{accountTypeSavingsLabel}</SelectItem>
                <SelectItem value="other">{accountTypeOtherLabel}</SelectItem>
              </SelectContent>
            </Select>
          </>
        )}
        right={(
          <>
            <Label>{labels.accountHolderName}</Label>
            <Input
              value={accountHolderName}
              onChange={(e) => onAccountHolderNameChange(e.target.value)}
              placeholder={accountHolderNamePlaceholder}
              autoComplete="off"
            />
          </>
        )}
      />

      <div className="space-y-2">
        <Label>{labels.accountNumber}</Label>
        <VisibilityToggleInput
          show={showAccountNumber}
          onToggle={onToggleAccountNumber}
          inputProps={{
            value: accountNumber,
            onChange: (e) => onAccountNumberChange(e.target.value),
            placeholder: accountNumberPlaceholder,
            autoComplete: "off",
          }}
        />
      </div>

      <TwoColumnFields
        left={(
          <>
            <Label>{labels.routingNumber}</Label>
            <VisibilityToggleInput
              show={showRoutingNumber}
              onToggle={onToggleRoutingNumber}
              inputProps={{
                value: routingNumber,
                onChange: (e) => onRoutingNumberChange(e.target.value),
                placeholder: routingNumberPlaceholder,
                autoComplete: "off",
              }}
            />
          </>
        )}
        right={(
          <>
            <Label>{labels.branchName}</Label>
            <Input
              value={branchName}
              onChange={(e) => onBranchNameChange(e.target.value)}
              placeholder={branchNamePlaceholder}
              autoComplete="off"
            />
          </>
        )}
      />

      <TwoColumnFields
        left={(
          <>
            <Label>{labels.swiftBic}</Label>
            <Input
              value={swiftBic}
              onChange={(e) => onSwiftBicChange(e.target.value)}
              placeholder={swiftBicPlaceholder}
              autoComplete="off"
            />
          </>
        )}
        right={(
          <>
            <Label>{labels.iban}</Label>
            <Input
              value={iban}
              onChange={(e) => onIbanChange(e.target.value)}
              placeholder={ibanPlaceholder}
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
