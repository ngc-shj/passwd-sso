"use client";

import { useState } from "react";
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
import { EntryTravelSafeSection } from "@/components/passwords/entry-travel-safe-section";
import { EntryExpirationSection } from "@/components/passwords/entry-expiration-section";
import { ENTRY_TYPE } from "@/lib/constants";
import { preventIMESubmit } from "@/lib/ime-guard";
import { toTagPayload } from "@/components/passwords/entry-form-tags";
import { buildPersonalFormSectionsProps } from "@/hooks/personal-form-sections-props";
import { usePersonalBaseFormModel } from "@/hooks/use-personal-base-form-model";
import { useBeforeUnloadGuard } from "@/hooks/use-before-unload-guard";
import { useEntryHasChanges } from "@/hooks/use-entry-has-changes";

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
    travelSafe?: boolean;
    expiresAt?: string | null;
    // Passkey provider fields — opaque, preserved on round-trip but not shown in UI
    passkeyPrivateKeyJwk?: string | null;
    passkeyPublicKeyCose?: string | null;
    passkeyUserHandle?: string | null;
    passkeyUserDisplayName?: string | null;
    passkeySignCount?: number | null;
    passkeyAlgorithm?: number | null;
    passkeyTransports?: string[] | null;
  };
  variant?: "page" | "dialog";
  onSaved?: () => void;
  onCancel?: () => void;
  defaultFolderId?: string | null;
  defaultTags?: TagData[];
}

export function PasskeyForm({
  mode,
  initialData,
  variant = "page",
  onSaved,
  onCancel,
  defaultFolderId,
  defaultTags,
}: PasskeyFormProps) {
  const t = useTranslations("PasskeyForm");
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
  const [travelSafe, setTravelSafe] = useState(initialData?.travelSafe ?? true);

  const hasChanges = useEntryHasChanges(
    () => ({
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
      travelSafe,
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

    // Preserve passkey provider fields on round-trip (never edited in UI)
    const providerFields: Record<string, unknown> = {};
    if (initialData?.passkeyPrivateKeyJwk != null) providerFields.passkeyPrivateKeyJwk = initialData.passkeyPrivateKeyJwk;
    if (initialData?.passkeyPublicKeyCose != null) providerFields.passkeyPublicKeyCose = initialData.passkeyPublicKeyCose;
    if (initialData?.passkeyUserHandle != null) providerFields.passkeyUserHandle = initialData.passkeyUserHandle;
    if (initialData?.passkeyUserDisplayName != null) providerFields.passkeyUserDisplayName = initialData.passkeyUserDisplayName;
    if (initialData?.passkeySignCount != null) providerFields.passkeySignCount = initialData.passkeySignCount;
    if (initialData?.passkeyAlgorithm != null) providerFields.passkeyAlgorithm = initialData.passkeyAlgorithm;
    if (initialData?.passkeyTransports != null) providerFields.passkeyTransports = initialData.passkeyTransports;

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
        travelSafe,
        ...providerFields,
      }),
      overviewBlob: JSON.stringify({
        title: base.title,
        relyingPartyId: relyingPartyId || null,
        username: username || null,
        tags,
        travelSafe,
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
            <CardTitle>{mode === "create" ? t("newPasskey") : t("editPasskey")}</CardTitle>
          </CardHeader>
          <CardContent>{formContent}</CardContent>
        </Card>
      </div>
    </div>
  );
}
