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
import { IdentityFields } from "@/components/entry-fields/identity-fields";
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

interface IdentityFormProps {
  mode: "create" | "edit";
  initialData?: {
    id: string;
    title: string;
    fullName: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
    dateOfBirth: string | null;
    nationality: string | null;
    idNumber: string | null;
    issueDate: string | null;
    expiryDate: string | null;
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

export function IdentityForm({ mode, initialData, variant = "page", onSaved, defaultFolderId, defaultTags }: IdentityFormProps) {
  const t = useTranslations("IdentityForm");
  const tPw = useTranslations("PasswordForm");
  const tc = useTranslations("Common");
  const router = useRouter();
  const { encryptionKey, userId } = useVault();
  const [submitting, setSubmitting] = useState(false);
  const [showIdNumber, setShowIdNumber] = useState(false);
  const [requireReprompt, setRequireReprompt] = useState(initialData?.requireReprompt ?? false);
  const [expiresAt, setExpiresAt] = useState<string | null>(initialData?.expiresAt ?? null);

  const [title, setTitle] = useState(initialData?.title ?? "");
  const [fullName, setFullName] = useState(initialData?.fullName ?? "");
  const [address, setAddress] = useState(initialData?.address ?? "");
  const [phone, setPhone] = useState(initialData?.phone ?? "");
  const [email, setEmail] = useState(initialData?.email ?? "");
  const [dateOfBirth, setDateOfBirth] = useState(initialData?.dateOfBirth ?? "");
  const [nationality, setNationality] = useState(initialData?.nationality ?? "");
  const [idNumber, setIdNumber] = useState(initialData?.idNumber ?? "");
  const [issueDate, setIssueDate] = useState(initialData?.issueDate ?? "");
  const [expiryDate, setExpiryDate] = useState(initialData?.expiryDate ?? "");
  const [notes, setNotes] = useState(initialData?.notes ?? "");
  const [dobError, setDobError] = useState<string | null>(null);
  const [expiryError, setExpiryError] = useState<string | null>(null);
  const [selectedTags, setSelectedTags] = useState<TagData[]>(
    initialData?.tags ?? defaultTags ?? []
  );
  const [folderId, setFolderId] = useState<string | null>(initialData?.folderId ?? defaultFolderId ?? null);
  const { folders } = usePersonalFolders();

  const baselineSnapshot = useMemo(
    () =>
      JSON.stringify({
        title: initialData?.title ?? "",
        fullName: initialData?.fullName ?? "",
        address: initialData?.address ?? "",
        phone: initialData?.phone ?? "",
        email: initialData?.email ?? "",
        dateOfBirth: initialData?.dateOfBirth ?? "",
        nationality: initialData?.nationality ?? "",
        idNumber: initialData?.idNumber ?? "",
        issueDate: initialData?.issueDate ?? "",
        expiryDate: initialData?.expiryDate ?? "",
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
        fullName,
        address,
        phone,
        email,
        dateOfBirth,
        nationality,
        idNumber,
        issueDate,
        expiryDate,
        notes,
        selectedTagIds: selectedTags.map((tag) => tag.id).sort(),
        folderId,
        requireReprompt,
        expiresAt,
      }),
    [
      title,
      fullName,
      address,
      phone,
      email,
      dateOfBirth,
      nationality,
      idNumber,
      issueDate,
      expiryDate,
      notes,
      selectedTags,
      folderId,
      requireReprompt,
      expiresAt,
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

    let hasError = false;
    if (dateOfBirth && dateOfBirth > new Date().toISOString().slice(0, 10)) {
      setDobError(t("dobFuture"));
      hasError = true;
    } else {
      setDobError(null);
    }
    if (issueDate && expiryDate && issueDate >= expiryDate) {
      setExpiryError(t("expiryBeforeIssue"));
      hasError = true;
    } else {
      setExpiryError(null);
    }
    if (hasError) return;
    const tags = toTagPayload(selectedTags);
    const idNumberLast4 = idNumber ? idNumber.slice(-4) : null;
    const fullBlob = JSON.stringify({
      title,
      fullName: fullName || null,
      address: address || null,
      phone: phone || null,
      email: email || null,
      dateOfBirth: dateOfBirth || null,
      nationality: nationality || null,
      idNumber: idNumber || null,
      issueDate: issueDate || null,
      expiryDate: expiryDate || null,
      notes: notes || null,
      tags,
    });
    const overviewBlob = JSON.stringify({
      title,
      fullName: fullName || null,
      idNumberLast4,
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
      entryType: ENTRY_TYPE.IDENTITY,
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

      <IdentityFields
        fullName={fullName}
        onFullNameChange={setFullName}
        fullNamePlaceholder={t("fullNamePlaceholder")}
        address={address}
        onAddressChange={setAddress}
        addressPlaceholder={t("addressPlaceholder")}
        phone={phone}
        onPhoneChange={setPhone}
        phonePlaceholder={t("phonePlaceholder")}
        email={email}
        onEmailChange={setEmail}
        emailPlaceholder={t("emailPlaceholder")}
        dateOfBirth={dateOfBirth}
        onDateOfBirthChange={(v) => { setDateOfBirth(v); setDobError(null); }}
        nationality={nationality}
        onNationalityChange={setNationality}
        nationalityPlaceholder={t("nationalityPlaceholder")}
        idNumber={idNumber}
        onIdNumberChange={setIdNumber}
        idNumberPlaceholder={t("idNumberPlaceholder")}
        showIdNumber={showIdNumber}
        onToggleIdNumber={() => setShowIdNumber(!showIdNumber)}
        issueDate={issueDate}
        onIssueDateChange={(v) => { setIssueDate(v); setExpiryError(null); }}
        expiryDate={expiryDate}
        onExpiryDateChange={(v) => { setExpiryDate(v); setExpiryError(null); }}
        dobError={dobError}
        expiryError={expiryError}
        notesLabel={t("notes")}
        notes={notes}
        onNotesChange={setNotes}
        notesPlaceholder={t("notesPlaceholder")}
        labels={{
          fullName: t("fullName"),
          address: t("address"),
          phone: t("phone"),
          email: t("email"),
          dateOfBirth: t("dateOfBirth"),
          nationality: t("nationality"),
          idNumber: t("idNumber"),
          issueDate: t("issueDate"),
          expiryDate: t("expiryDate"),
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
            {mode === "create" ? t("newIdentity") : t("editIdentity")}
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
