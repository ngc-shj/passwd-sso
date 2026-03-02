"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { TagData } from "@/components/tags/tag-input";
import { ArrowLeft } from "lucide-react";
import { PasskeyFields } from "@/components/entry-fields/passkey-fields";
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
import { toTagPayload } from "@/components/passwords/entry-form-tags";
import { usePersonalBaseFormModel } from "@/hooks/use-personal-base-form-model";

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
  defaultFolderId?: string | null;
  defaultTags?: TagData[];
}

export function PasskeyForm({
  mode,
  initialData,
  variant = "page",
  onSaved,
  defaultFolderId,
  defaultTags,
}: PasskeyFormProps) {
  const t = useTranslations("PasskeyForm");
  const tPw = useTranslations("PasswordForm");
  const tc = useTranslations("Common");
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
  });
  const [showCredentialId, setShowCredentialId] = useState(false);
  const [relyingPartyId, setRelyingPartyId] = useState(
    initialData?.relyingPartyId ?? "",
  );
  const [relyingPartyName, setRelyingPartyName] = useState(
    initialData?.relyingPartyName ?? "",
  );
  const [username, setUsername] = useState(initialData?.username ?? "");
  const [credentialId, setCredentialId] = useState(
    initialData?.credentialId ?? "",
  );
  const [creationDate, setCreationDate] = useState(
    initialData?.creationDate ?? "",
  );
  const [deviceInfo, setDeviceInfo] = useState(initialData?.deviceInfo ?? "");
  const [notes, setNotes] = useState(initialData?.notes ?? "");

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
        selectedTagIds: (initialData?.tags ?? defaultTags ?? [])
          .map((tag) => tag.id)
          .sort(),
        folderId: initialData?.folderId ?? defaultFolderId ?? null,
        requireReprompt: initialData?.requireReprompt ?? false,
        expiresAt: initialData?.expiresAt ?? null,
      }),
    [initialData, defaultFolderId, defaultTags],
  );

  const currentSnapshot = useMemo(
    () =>
      JSON.stringify({
        title: base.title,
        relyingPartyId,
        relyingPartyName,
        username,
        credentialId,
        creationDate,
        deviceInfo,
        notes,
        selectedTagIds: base.selectedTags.map((tag) => tag.id).sort(),
        folderId: base.folderId,
        requireReprompt: base.requireReprompt,
        expiresAt: base.expiresAt,
      }),
    [
      base.title,
      relyingPartyId,
      relyingPartyName,
      username,
      credentialId,
      creationDate,
      deviceInfo,
      notes,
      base.selectedTags,
      base.folderId,
      base.requireReprompt,
      base.expiresAt,
    ],
  );

  const hasChanges = currentSnapshot !== baselineSnapshot;
  const primaryCardClass = base.isDialogVariant
    ? ENTRY_DIALOG_FLAT_PRIMARY_CARD_CLASS
    : "";
  const dialogSectionClass = base.isDialogVariant
    ? ENTRY_DIALOG_FLAT_SECTION_CLASS
    : "";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const tags = toTagPayload(base.selectedTags);

    await base.submitEntry({
      t: tPw,
      fullBlob: JSON.stringify({
        title: base.title,
        relyingPartyId: relyingPartyId || null,
        relyingPartyName: relyingPartyName || null,
        username: username || null,
        credentialId: credentialId || null,
        creationDate: creationDate || null,
        deviceInfo: deviceInfo || null,
        notes: notes || null,
        tags,
      }),
      overviewBlob: JSON.stringify({
        title: base.title,
        relyingPartyId: relyingPartyId || null,
        username: username || null,
        tags,
      }),
      entryType: ENTRY_TYPE.PASSKEY,
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

        <PasskeyFields
          relyingPartyId={relyingPartyId}
          onRelyingPartyIdChange={setRelyingPartyId}
          relyingPartyIdPlaceholder={t("relyingPartyIdPlaceholder")}
          relyingPartyName={relyingPartyName}
          onRelyingPartyNameChange={setRelyingPartyName}
          relyingPartyNamePlaceholder={t("relyingPartyNamePlaceholder")}
          username={username}
          onUsernameChange={setUsername}
          usernamePlaceholder={t("usernamePlaceholder")}
          credentialId={credentialId}
          onCredentialIdChange={setCredentialId}
          credentialIdPlaceholder={t("credentialIdPlaceholder")}
          showCredentialId={showCredentialId}
          onToggleCredentialId={() => setShowCredentialId(!showCredentialId)}
          creationDate={creationDate}
          onCreationDateChange={setCreationDate}
          deviceInfo={deviceInfo}
          onDeviceInfoChange={setDeviceInfo}
          deviceInfoPlaceholder={t("deviceInfoPlaceholder")}
          notesLabel={t("notes")}
          notes={notes}
          onNotesChange={setNotes}
          notesPlaceholder={t("notesPlaceholder")}
          labels={{
            relyingPartyId: t("relyingPartyId"),
            relyingPartyName: t("relyingPartyName"),
            username: t("username"),
            credentialId: t("credentialId"),
            creationDate: t("creationDate"),
            deviceInfo: t("deviceInfo"),
          }}
        />
      </EntryPrimaryCard>

      <EntryTagsAndFolderSection
        tagsTitle={t("tags")}
        tagsHint={tPw("tagsHint")}
        selectedTags={base.selectedTags}
        onTagsChange={base.setSelectedTags}
        folders={base.folders}
        folderId={base.folderId}
        onFolderChange={base.setFolderId}
        sectionCardClass={dialogSectionClass}
      />

      <EntryRepromptSection
        checked={base.requireReprompt}
        onCheckedChange={base.setRequireReprompt}
        title={tPw("requireReprompt")}
        description={tPw("requireRepromptHelp")}
        sectionCardClass={dialogSectionClass}
      />

      <EntryExpirationSection
        value={base.expiresAt}
        onChange={base.setExpiresAt}
        title={tPw("expirationTitle")}
        description={tPw("expirationDescription")}
        sectionCardClass={dialogSectionClass}
      />

      <EntryActionBar
        hasChanges={hasChanges}
        submitting={base.submitting}
        saveLabel={mode === "create" ? tc("save") : tc("update")}
        cancelLabel={tc("cancel")}
        statusUnsavedLabel={tPw("statusUnsaved")}
        statusSavedLabel={tPw("statusSaved")}
        onCancel={base.handleCancel}
      />
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
            <CardTitle>{mode === "create" ? t("newPasskey") : t("editPasskey")}</CardTitle>
          </CardHeader>
          <CardContent>{formContent}</CardContent>
        </Card>
      </div>
    </div>
  );
}
