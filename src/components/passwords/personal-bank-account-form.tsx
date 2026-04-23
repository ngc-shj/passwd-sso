"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { TagData } from "@/components/tags/tag-input";
import { ArrowLeft } from "lucide-react";
import { BankAccountFields } from "@/components/entry-fields/bank-account-fields";
import {
  EntryActionBar,
  EntryPrimaryCard,
  ENTRY_DIALOG_FLAT_PRIMARY_CARD_CLASS,
  ENTRY_DIALOG_FLAT_SECTION_CLASS,
} from "@/components/passwords/entry-form-ui";
import { EntryTagsAndFolderSection } from "@/components/passwords/entry-tags-and-folder-section";
import { EntryRepromptSection } from "@/components/passwords/entry-reprompt-section";
import { EntryTravelSafeSection } from "@/components/passwords/entry-travel-safe-section";
import { EntryExpirationSection } from "@/components/passwords/entry-expiration-section";
import { ENTRY_TYPE } from "@/lib/constants";
import { preventIMESubmit } from "@/lib/ime-guard";
import { toTagPayload } from "@/components/passwords/entry-form-tags";
import { buildPersonalFormSectionsProps } from "@/hooks/personal/personal-form-sections-props";
import { usePersonalBaseFormModel } from "@/hooks/personal/use-personal-base-form-model";
import { useBeforeUnloadGuard } from "@/hooks/use-before-unload-guard";
import { useEntryHasChanges } from "@/hooks/use-entry-has-changes";

interface BankAccountFormProps {
  mode: "create" | "edit";
  initialData?: {
    id: string;
    title: string;
    bankName: string | null;
    accountType: string | null;
    accountHolderName: string | null;
    accountNumber: string | null;
    routingNumber: string | null;
    swiftBic: string | null;
    iban: string | null;
    branchName: string | null;
    notes: string | null;
    tags: TagData[];
    folderId?: string | null;
    requireReprompt?: boolean;
    travelSafe?: boolean;
    expiresAt?: string | null;
  };
  variant?: "page" | "dialog";
  onSaved?: () => void;
  onCancel?: () => void;
  defaultFolderId?: string | null;
  defaultTags?: TagData[];
}

function deriveAccountNumberLast4(accountNumber: string): string | null {
  const digits = accountNumber.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

export function BankAccountForm({
  mode,
  initialData,
  variant = "page",
  onSaved,
  onCancel,
  defaultFolderId,
  defaultTags,
}: BankAccountFormProps) {
  const t = useTranslations("BankAccountForm");
  const tPw = useTranslations("PasswordForm");
  const tc = useTranslations("Common");
  const ttm = useTranslations("TravelMode");
  const base = usePersonalBaseFormModel({
    mode,
    initialId: initialData?.id,
    initialTitle: initialData?.title,
    initialTags: initialData?.tags,
    initialFolderId: initialData?.folderId,
    initialRequireReprompt: initialData?.requireReprompt,
    initialExpiresAt: initialData?.expiresAt,
    defaultFolderId,
    defaultTags,
    variant,
    onSaved,
    onCancel,
  });
  const [showAccountNumber, setShowAccountNumber] = useState(false);
  const [showRoutingNumber, setShowRoutingNumber] = useState(false);
  const [bankName, setBankName] = useState(initialData?.bankName ?? "");
  const [accountType, setAccountType] = useState(initialData?.accountType ?? "");
  const [accountHolderName, setAccountHolderName] = useState(
    initialData?.accountHolderName ?? "",
  );
  const [accountNumber, setAccountNumber] = useState(
    initialData?.accountNumber ?? "",
  );
  const [routingNumber, setRoutingNumber] = useState(
    initialData?.routingNumber ?? "",
  );
  const [swiftBic, setSwiftBic] = useState(initialData?.swiftBic ?? "");
  const [iban, setIban] = useState(initialData?.iban ?? "");
  const [branchName, setBranchName] = useState(initialData?.branchName ?? "");
  const [notes, setNotes] = useState(initialData?.notes ?? "");
  const [travelSafe, setTravelSafe] = useState(initialData?.travelSafe ?? true);

  const hasChanges = useEntryHasChanges(
    () => ({
      title: base.title,
      bankName,
      accountType,
      accountHolderName,
      accountNumber,
      routingNumber,
      swiftBic,
      iban,
      branchName,
      notes,
      selectedTagIds: base.selectedTags.map((tag) => tag.id).sort(),
      folderId: base.folderId,
      requireReprompt: base.requireReprompt,
      travelSafe,
      expiresAt: base.expiresAt,
    }),
    [
      base.title,
      bankName,
      accountType,
      accountHolderName,
      accountNumber,
      routingNumber,
      swiftBic,
      iban,
      branchName,
      notes,
      base.selectedTags,
      base.folderId,
      base.requireReprompt,
      travelSafe,
      base.expiresAt,
    ],
  );
  useBeforeUnloadGuard(!base.isDialogVariant && hasChanges);
  const primaryCardClass = base.isDialogVariant
    ? ENTRY_DIALOG_FLAT_PRIMARY_CARD_CLASS
    : "";
  const dialogSectionClass = base.isDialogVariant
    ? ENTRY_DIALOG_FLAT_SECTION_CLASS
    : "";
  const {
    tagsAndFolderProps,
    repromptSectionProps,
    travelSafeSectionProps,
    expirationSectionProps,
    actionBarProps,
  } = buildPersonalFormSectionsProps({
    tagsTitle: t("tags"),
    tagsHint: tPw("tagsHint"),
    folders: base.folders,
    sectionCardClass: dialogSectionClass,
    repromptTitle: tPw("requireReprompt"),
    repromptDescription: tPw("requireRepromptHelp"),
    travelSafeTitle: ttm("travelSafe"),
    travelSafeDescription: ttm("travelSafeDescription"),
    expirationTitle: tPw("expirationTitle"),
    expirationDescription: tPw("expirationDescription"),
    hasChanges,
    submitting: base.submitting,
    saveLabel: mode === "create" ? tc("save") : tc("update"),
    cancelLabel: tc("cancel"),
    statusUnsavedLabel: tPw("statusUnsaved"),
    statusSavedLabel: tPw("statusSaved"),
    onCancel: base.handleCancel,
    values: {
      selectedTags: base.selectedTags,
      folderId: base.folderId,
      customFields: [],
      totp: null,
      showTotpInput: false,
      requireReprompt: base.requireReprompt,
      travelSafe,
      expiresAt: base.expiresAt,
    },
    setters: {
      setSelectedTags: base.setSelectedTags,
      setFolderId: base.setFolderId,
      setCustomFields: () => {},
      setTotp: () => {},
      setShowTotpInput: () => {},
      setRequireReprompt: base.setRequireReprompt,
      setTravelSafe,
      setExpiresAt: base.setExpiresAt,
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const tags = toTagPayload(base.selectedTags);
    const accountNumberLast4 = accountNumber
      ? deriveAccountNumberLast4(accountNumber)
      : null;

    await base.submitEntry({
      t: tPw,
      fullBlob: JSON.stringify({
        title: base.title,
        bankName: bankName || null,
        accountType: accountType || null,
        accountHolderName: accountHolderName || null,
        accountNumber: accountNumber || null,
        routingNumber: routingNumber || null,
        swiftBic: swiftBic || null,
        iban: iban || null,
        branchName: branchName || null,
        notes: notes || null,
        tags,
        travelSafe,
      }),
      overviewBlob: JSON.stringify({
        title: base.title,
        bankName: bankName || null,
        accountNumberLast4,
        tags,
        travelSafe,
      }),
      entryType: ENTRY_TYPE.BANK_ACCOUNT,
    });
  };

  const formContent = (
    <form onSubmit={handleSubmit} onKeyDown={preventIMESubmit} className="space-y-5">
      <EntryPrimaryCard className={primaryCardClass}>
        <div className="space-y-2">
          <Label htmlFor="title">{t("title")}</Label>
          <Input
            id="title"
            value={base.title}
            onChange={(e) => base.setTitle(e.target.value)}
            placeholder={t("titlePlaceholder")}
            required
          />
        </div>

        <BankAccountFields
          bankName={bankName}
          onBankNameChange={setBankName}
          bankNamePlaceholder={t("bankNamePlaceholder")}
          accountType={accountType}
          onAccountTypeChange={setAccountType}
          accountTypePlaceholder={t("accountTypePlaceholder")}
          accountTypeCheckingLabel={t("accountTypeChecking")}
          accountTypeSavingsLabel={t("accountTypeSavings")}
          accountTypeOtherLabel={t("accountTypeOther")}
          accountHolderName={accountHolderName}
          onAccountHolderNameChange={setAccountHolderName}
          accountHolderNamePlaceholder={t("accountHolderNamePlaceholder")}
          accountNumber={accountNumber}
          onAccountNumberChange={setAccountNumber}
          accountNumberPlaceholder={t("accountNumberPlaceholder")}
          showAccountNumber={showAccountNumber}
          onToggleAccountNumber={() => setShowAccountNumber(!showAccountNumber)}
          routingNumber={routingNumber}
          onRoutingNumberChange={setRoutingNumber}
          routingNumberPlaceholder={t("routingNumberPlaceholder")}
          showRoutingNumber={showRoutingNumber}
          onToggleRoutingNumber={() => setShowRoutingNumber(!showRoutingNumber)}
          swiftBic={swiftBic}
          onSwiftBicChange={setSwiftBic}
          swiftBicPlaceholder={t("swiftBicPlaceholder")}
          iban={iban}
          onIbanChange={setIban}
          ibanPlaceholder={t("ibanPlaceholder")}
          branchName={branchName}
          onBranchNameChange={setBranchName}
          branchNamePlaceholder={t("branchNamePlaceholder")}
          notesLabel={t("notes")}
          notes={notes}
          onNotesChange={setNotes}
          notesPlaceholder={t("notesPlaceholder")}
          labels={{
            bankName: t("bankName"),
            accountType: t("accountType"),
            accountHolderName: t("accountHolderName"),
            accountNumber: t("accountNumber"),
            routingNumber: t("routingNumber"),
            swiftBic: t("swiftBic"),
            iban: t("iban"),
            branchName: t("branchName"),
          }}
        />
      </EntryPrimaryCard>

      <EntryTagsAndFolderSection {...tagsAndFolderProps} />
      <EntryRepromptSection {...repromptSectionProps} />
      <EntryTravelSafeSection {...travelSafeSectionProps} />
      <EntryExpirationSection {...expirationSectionProps} />
      <EntryActionBar {...actionBarProps} />
    </form>
  );

  if (base.isDialogVariant) {
    return formContent;
  }

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6">
      <div className="mx-auto max-w-4xl space-y-4">
        <Button variant="ghost" className="mb-4 gap-2" onClick={base.handleBack}>
          <ArrowLeft className="h-4 w-4" />
          {tc("back")}
        </Button>

        <Card className="rounded-xl border">
          <CardHeader>
            <CardTitle>
              {mode === "create" ? t("newBankAccount") : t("editBankAccount")}
            </CardTitle>
          </CardHeader>
          <CardContent>{formContent}</CardContent>
        </Card>
      </div>
    </div>
  );
}
