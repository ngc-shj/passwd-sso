"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { useVault } from "@/lib/vault-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { TagData } from "@/components/tags/tag-input";
import { ArrowLeft, Eye, EyeOff } from "lucide-react";
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
    [initialData]
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

      <div className="space-y-2">
        <Label htmlFor="bankName">{t("bankName")}</Label>
        <Input
          id="bankName"
          value={bankName}
          onChange={(e) => setBankName(e.target.value)}
          placeholder={t("bankNamePlaceholder")}
          autoComplete="off"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>{t("accountType")}</Label>
          <Select value={accountType} onValueChange={setAccountType}>
            <SelectTrigger>
              <SelectValue placeholder={t("accountTypePlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="checking">{t("accountTypeChecking")}</SelectItem>
              <SelectItem value="savings">{t("accountTypeSavings")}</SelectItem>
              <SelectItem value="other">{t("accountTypeOther")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="accountHolderName">{t("accountHolderName")}</Label>
          <Input
            id="accountHolderName"
            value={accountHolderName}
            onChange={(e) => setAccountHolderName(e.target.value)}
            placeholder={t("accountHolderNamePlaceholder")}
            autoComplete="off"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="accountNumber">{t("accountNumber")}</Label>
        <div className="relative">
          <Input
            id="accountNumber"
            type={showAccountNumber ? "text" : "password"}
            value={accountNumber}
            onChange={(e) => setAccountNumber(e.target.value)}
            placeholder={t("accountNumberPlaceholder")}
            autoComplete="off"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
            onClick={() => setShowAccountNumber(!showAccountNumber)}
          >
            {showAccountNumber ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="routingNumber">{t("routingNumber")}</Label>
          <div className="relative">
            <Input
              id="routingNumber"
              type={showRoutingNumber ? "text" : "password"}
              value={routingNumber}
              onChange={(e) => setRoutingNumber(e.target.value)}
              placeholder={t("routingNumberPlaceholder")}
              autoComplete="off"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
              onClick={() => setShowRoutingNumber(!showRoutingNumber)}
            >
              {showRoutingNumber ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="branchName">{t("branchName")}</Label>
          <Input
            id="branchName"
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            placeholder={t("branchNamePlaceholder")}
            autoComplete="off"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="swiftBic">{t("swiftBic")}</Label>
          <Input
            id="swiftBic"
            value={swiftBic}
            onChange={(e) => setSwiftBic(e.target.value)}
            placeholder={t("swiftBicPlaceholder")}
            autoComplete="off"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="iban">{t("iban")}</Label>
          <Input
            id="iban"
            value={iban}
            onChange={(e) => setIban(e.target.value)}
            placeholder={t("ibanPlaceholder")}
            autoComplete="off"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="notes">{t("notes")}</Label>
        <Textarea
          id="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t("notesPlaceholder")}
          rows={3}
        />
      </div>

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
