"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { useVault } from "@/lib/vault-context";
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
import { EntryExpirationSection } from "@/components/passwords/entry-expiration-section";
import { ENTRY_TYPE } from "@/lib/constants";
import { preventIMESubmit } from "@/lib/ime-guard";
import { usePersonalFolders } from "@/hooks/use-personal-folders";
import { executePersonalEntrySubmit } from "@/components/passwords/personal-entry-submit";
import { toTagIds, toTagPayload } from "@/components/passwords/entry-form-tags";
import { createFormNavigationHandlers } from "@/components/passwords/form-navigation";

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
    expiresAt?: string | null;
  };
  variant?: "page" | "dialog";
  onSaved?: () => void;
  defaultFolderId?: string | null;
  defaultTags?: TagData[];
}

function deriveAccountNumberLast4(accountNumber: string): string | null {
  const digits = accountNumber.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

export function BankAccountForm({ mode, initialData, variant = "page", onSaved, defaultFolderId, defaultTags }: BankAccountFormProps) {
  const t = useTranslations("BankAccountForm");
  const tPw = useTranslations("PasswordForm");
  const tc = useTranslations("Common");
  const router = useRouter();
  const { encryptionKey, userId } = useVault();
  const [submitting, setSubmitting] = useState(false);
  const [showAccountNumber, setShowAccountNumber] = useState(false);
  const [showRoutingNumber, setShowRoutingNumber] = useState(false);
  const [requireReprompt, setRequireReprompt] = useState(initialData?.requireReprompt ?? false);
  const [expiresAt, setExpiresAt] = useState<string | null>(initialData?.expiresAt ?? null);

  const [title, setTitle] = useState(initialData?.title ?? "");
  const [bankName, setBankName] = useState(initialData?.bankName ?? "");
  const [accountType, setAccountType] = useState(initialData?.accountType ?? "");
  const [accountHolderName, setAccountHolderName] = useState(initialData?.accountHolderName ?? "");
  const [accountNumber, setAccountNumber] = useState(initialData?.accountNumber ?? "");
  const [routingNumber, setRoutingNumber] = useState(initialData?.routingNumber ?? "");
  const [swiftBic, setSwiftBic] = useState(initialData?.swiftBic ?? "");
  const [iban, setIban] = useState(initialData?.iban ?? "");
  const [branchName, setBranchName] = useState(initialData?.branchName ?? "");
  const [notes, setNotes] = useState(initialData?.notes ?? "");
  const [selectedTags, setSelectedTags] = useState<TagData[]>(
    initialData?.tags ?? defaultTags ?? []
  );
  const [folderId, setFolderId] = useState<string | null>(initialData?.folderId ?? defaultFolderId ?? null);
  const { folders } = usePersonalFolders();

  const baselineSnapshot = useMemo(
    () =>
      JSON.stringify({
        title: initialData?.title ?? "",
        bankName: initialData?.bankName ?? "",
        accountType: initialData?.accountType ?? "",
        accountHolderName: initialData?.accountHolderName ?? "",
        accountNumber: initialData?.accountNumber ?? "",
        routingNumber: initialData?.routingNumber ?? "",
        swiftBic: initialData?.swiftBic ?? "",
        iban: initialData?.iban ?? "",
        branchName: initialData?.branchName ?? "",
        notes: initialData?.notes ?? "",
        selectedTagIds: (initialData?.tags ?? defaultTags ?? []).map((tag) => tag.id).sort(),
        folderId: initialData?.folderId ?? defaultFolderId ?? null,
        requireReprompt: initialData?.requireReprompt ?? false,
        expiresAt: initialData?.expiresAt ?? null,
      }),
    [initialData, defaultFolderId, defaultTags]
  );

  const currentSnapshot = useMemo(
    () =>
      JSON.stringify({
        title,
        bankName,
        accountType,
        accountHolderName,
        accountNumber,
        routingNumber,
        swiftBic,
        iban,
        branchName,
        notes,
        selectedTagIds: selectedTags.map((tag) => tag.id).sort(),
        folderId,
        requireReprompt,
        expiresAt,
      }),
    [
      title, bankName, accountType, accountHolderName,
      accountNumber, routingNumber, swiftBic, iban, branchName,
      notes, selectedTags, folderId, requireReprompt, expiresAt,
    ]
  );

  const hasChanges = currentSnapshot !== baselineSnapshot;
  const isDialogVariant = variant === "dialog";
  const primaryCardClass = isDialogVariant ? ENTRY_DIALOG_FLAT_PRIMARY_CARD_CLASS : "";
  const dialogSectionClass = isDialogVariant ? ENTRY_DIALOG_FLAT_SECTION_CLASS : "";
  const { handleCancel, handleBack } = createFormNavigationHandlers({ onSaved, router });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!encryptionKey) return;
    const tags = toTagPayload(selectedTags);
    const accountNumberLast4 = accountNumber ? deriveAccountNumberLast4(accountNumber) : null;

    const fullBlob = JSON.stringify({
      title,
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
    });

    const overviewBlob = JSON.stringify({
      title,
      bankName: bankName || null,
      accountNumberLast4,
      tags,
    });

    await executePersonalEntrySubmit({
      mode,
      initialId: initialData?.id,
      encryptionKey,
      userId: userId ?? undefined,
      fullBlob,
      overviewBlob,
      tagIds: toTagIds(selectedTags),
      folderId: folderId ?? null,
      entryType: ENTRY_TYPE.BANK_ACCOUNT,
      requireReprompt,
      expiresAt,
      setSubmitting,
      t,
      router,
      onSaved,
    });
  };

  const formContent = (
    <form onSubmit={handleSubmit} onKeyDown={preventIMESubmit} className="space-y-5">
      <EntryPrimaryCard className={primaryCardClass}>
      <div className="space-y-2">
        <Label htmlFor="title">{t("title")}</Label>
        <Input
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
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

      <EntryTagsAndFolderSection
        tagsTitle={t("tags")}
        tagsHint={tPw("tagsHint")}
        selectedTags={selectedTags}
        onTagsChange={setSelectedTags}
        folders={folders}
        folderId={folderId}
        onFolderChange={setFolderId}
        sectionCardClass={dialogSectionClass}
      />

      <EntryRepromptSection
        checked={requireReprompt}
        onCheckedChange={setRequireReprompt}
        title={tPw("requireReprompt")}
        description={tPw("requireRepromptHelp")}
        sectionCardClass={dialogSectionClass}
      />

      <EntryExpirationSection
        value={expiresAt}
        onChange={setExpiresAt}
        title={tPw("expirationTitle")}
        description={tPw("expirationDescription")}
        sectionCardClass={dialogSectionClass}
      />

      <EntryActionBar
        hasChanges={hasChanges}
        submitting={submitting}
        saveLabel={mode === "create" ? tc("save") : tc("update")}
        cancelLabel={tc("cancel")}
        statusUnsavedLabel={tPw("statusUnsaved")}
        statusSavedLabel={tPw("statusSaved")}
        onCancel={handleCancel}
      />
    </form>
  );

  if (variant === "dialog") {
    return formContent;
  }

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6">
      <div className="mx-auto max-w-4xl space-y-4">
      <Button
        variant="ghost"
        className="mb-4 gap-2"
        onClick={handleBack}
      >
        <ArrowLeft className="h-4 w-4" />
        {tc("back")}
      </Button>

      <Card className="rounded-xl border">
        <CardHeader>
          <CardTitle>
            {mode === "create" ? t("newBankAccount") : t("editBankAccount")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {formContent}
        </CardContent>
      </Card>
      </div>
    </div>
  );
}
