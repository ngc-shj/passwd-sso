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

interface PasskeyFormProps {
  mode: "create" | "edit";
  initialData?: {
    id: string;
    title: string;
    relyingPartyId: string | null;
    relyingPartyName: string | null;
    username: string | null;
    credentialId: string | null;
    creationDate: string | null;
    deviceInfo: string | null;
    notes: string | null;
    tags: TagData[];
    folderId?: string | null;
    requireReprompt?: boolean;
    expiresAt?: string | null;
  };
  variant?: "page" | "dialog";
  onSaved?: () => void;
}

export function PasskeyForm({ mode, initialData, variant = "page", onSaved }: PasskeyFormProps) {
  const t = useTranslations("PasskeyForm");
  const tPw = useTranslations("PasswordForm");
  const tc = useTranslations("Common");
  const router = useRouter();
  const { encryptionKey, userId } = useVault();
  const [submitting, setSubmitting] = useState(false);
  const [showCredentialId, setShowCredentialId] = useState(false);
  const [requireReprompt, setRequireReprompt] = useState(initialData?.requireReprompt ?? false);
  const [expiresAt, setExpiresAt] = useState<string | null>(initialData?.expiresAt ?? null);

  const [title, setTitle] = useState(initialData?.title ?? "");
  const [relyingPartyId, setRelyingPartyId] = useState(initialData?.relyingPartyId ?? "");
  const [relyingPartyName, setRelyingPartyName] = useState(initialData?.relyingPartyName ?? "");
  const [username, setUsername] = useState(initialData?.username ?? "");
  const [credentialId, setCredentialId] = useState(initialData?.credentialId ?? "");
  const [creationDate, setCreationDate] = useState(initialData?.creationDate ?? "");
  const [deviceInfo, setDeviceInfo] = useState(initialData?.deviceInfo ?? "");
  const [notes, setNotes] = useState(initialData?.notes ?? "");
  const [selectedTags, setSelectedTags] = useState<TagData[]>(
    initialData?.tags ?? []
  );
  const [folderId, setFolderId] = useState<string | null>(initialData?.folderId ?? null);
  const { folders } = usePersonalFolders();

  const baselineSnapshot = useMemo(
    () =>
      JSON.stringify({
        title: initialData?.title ?? "",
        relyingPartyId: initialData?.relyingPartyId ?? "",
        relyingPartyName: initialData?.relyingPartyName ?? "",
        username: initialData?.username ?? "",
        credentialId: initialData?.credentialId ?? "",
        creationDate: initialData?.creationDate ?? "",
        deviceInfo: initialData?.deviceInfo ?? "",
        notes: initialData?.notes ?? "",
        selectedTagIds: (initialData?.tags ?? []).map((tag) => tag.id).sort(),
        folderId: initialData?.folderId ?? null,
        requireReprompt: initialData?.requireReprompt ?? false,
        expiresAt: initialData?.expiresAt ?? null,
      }),
    [initialData]
  );

  const currentSnapshot = useMemo(
    () =>
      JSON.stringify({
        title,
        relyingPartyId,
        relyingPartyName,
        username,
        credentialId,
        creationDate,
        deviceInfo,
        notes,
        selectedTagIds: selectedTags.map((tag) => tag.id).sort(),
        folderId,
        requireReprompt,
        expiresAt,
      }),
    [
      title,
      relyingPartyId,
      relyingPartyName,
      username,
      credentialId,
      creationDate,
      deviceInfo,
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
    const tags = toTagPayload(selectedTags);
    const fullBlob = JSON.stringify({
      title,
      relyingPartyId: relyingPartyId || null,
      relyingPartyName: relyingPartyName || null,
      username: username || null,
      credentialId: credentialId || null,
      creationDate: creationDate || null,
      deviceInfo: deviceInfo || null,
      notes: notes || null,
      tags,
    });
    const overviewBlob = JSON.stringify({
      title,
      relyingPartyId: relyingPartyId || null,
      username: username || null,
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
      entryType: ENTRY_TYPE.PASSKEY,
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
        <Label htmlFor="relyingPartyId">{t("relyingPartyId")}</Label>
        <Input
          id="relyingPartyId"
          value={relyingPartyId}
          onChange={(e) => setRelyingPartyId(e.target.value)}
          placeholder={t("relyingPartyIdPlaceholder")}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="relyingPartyName">{t("relyingPartyName")}</Label>
        <Input
          id="relyingPartyName"
          value={relyingPartyName}
          onChange={(e) => setRelyingPartyName(e.target.value)}
          placeholder={t("relyingPartyNamePlaceholder")}
          autoComplete="off"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="username">{t("username")}</Label>
        <Input
          id="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={t("usernamePlaceholder")}
          autoComplete="off"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="credentialId">{t("credentialId")}</Label>
        <div className="relative">
          <Input
            id="credentialId"
            type={showCredentialId ? "text" : "password"}
            value={credentialId}
            onChange={(e) => setCredentialId(e.target.value)}
            placeholder={t("credentialIdPlaceholder")}
            className="font-mono"
            autoComplete="off"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
            onClick={() => setShowCredentialId(!showCredentialId)}
          >
            {showCredentialId ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="creationDate">{t("creationDate")}</Label>
          <Input
            id="creationDate"
            type="date"
            value={creationDate}
            onChange={(e) => setCreationDate(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="deviceInfo">{t("deviceInfo")}</Label>
          <Input
            id="deviceInfo"
            value={deviceInfo}
            onChange={(e) => setDeviceInfo(e.target.value)}
            placeholder={t("deviceInfoPlaceholder")}
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
            {mode === "create" ? t("newPasskey") : t("editPasskey")}
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
