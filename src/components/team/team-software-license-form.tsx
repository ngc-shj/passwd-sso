"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SoftwareLicenseFields } from "@/components/entry-fields/software-license-fields";
import { TeamTagsAndFolderSection } from "@/components/team/team-tags-and-folder-section";
import { EntryRepromptSection } from "@/components/passwords/entry-reprompt-section";
import { EntryExpirationSection } from "@/components/passwords/entry-expiration-section";
import { TeamAttachmentSection } from "./team-attachment-section";
import {
  EntryActionBar,
  ENTRY_DIALOG_FLAT_SECTION_CLASS,
} from "@/components/passwords/entry-form-ui";
import type { TeamEntryFormProps } from "@/components/team/team-entry-form-types";
import { preventIMESubmit } from "@/lib/ime-guard";
import { ENTRY_TYPE } from "@/lib/constants";
import { useTeamBaseFormModel } from "@/hooks/use-team-base-form-model";
import { buildTeamFormSectionsProps } from "@/hooks/team-form-sections-props";

export function TeamSoftwareLicenseForm({
  teamId,
  open,
  onOpenChange,
  onSaved,
  entryType,
  editData,
  defaultFolderId,
  defaultTags,
}: TeamEntryFormProps) {
  const tsl = useTranslations("SoftwareLicenseForm");
  const base = useTeamBaseFormModel({
    teamId,
    open,
    onOpenChange,
    onSaved,
    entryType,
    editData,
    defaultFolderId,
    defaultTags,
  });

  // Entry-specific state
  const [softwareName, setSoftwareName] = useState(editData?.softwareName ?? "");
  const [licenseKey, setLicenseKey] = useState(editData?.licenseKey ?? "");
  const [showLicenseKey, setShowLicenseKey] = useState(false);
  const [version, setVersion] = useState(editData?.version ?? "");
  const [licensee, setLicensee] = useState(editData?.licensee ?? "");
  const [email, setEmail] = useState(editData?.email ?? "");
  const [purchaseDate, setPurchaseDate] = useState(editData?.purchaseDate ?? "");
  const [expirationDate, setExpirationDate] = useState(editData?.expirationDate ?? "");
  const [expiryError, setExpiryError] = useState<string | null>(null);

  // hasChanges
  const baselineSnapshot = useMemo(
    () =>
      JSON.stringify({
        title: editData?.title ?? "",
        notes: editData?.notes ?? "",
        softwareName: editData?.softwareName ?? "",
        licenseKey: editData?.licenseKey ?? "",
        version: editData?.version ?? "",
        licensee: editData?.licensee ?? "",
        email: editData?.email ?? "",
        purchaseDate: editData?.purchaseDate ?? "",
        expirationDate: editData?.expirationDate ?? "",
        selectedTagIds: (editData?.tags ?? defaultTags ?? [])
          .map((tag) => tag.id)
          .sort(),
        teamFolderId: editData?.teamFolderId ?? defaultFolderId ?? null,
        requireReprompt: editData?.requireReprompt ?? false,
        expiresAt: editData?.expiresAt ?? null,
      }),
    [editData, defaultFolderId, defaultTags],
  );

  const currentSnapshot = useMemo(
    () =>
      JSON.stringify({
        title: base.title,
        notes: base.notes,
        softwareName,
        licenseKey,
        version,
        licensee,
        email,
        purchaseDate,
        expirationDate,
        selectedTagIds: base.selectedTags.map((tag) => tag.id).sort(),
        teamFolderId: base.teamFolderId,
        requireReprompt: base.requireReprompt,
        expiresAt: base.expiresAt,
      }),
    [
      base.title,
      base.notes,
      softwareName,
      licenseKey,
      version,
      licensee,
      email,
      purchaseDate,
      expirationDate,
      base.selectedTags,
      base.teamFolderId,
      base.requireReprompt,
      base.expiresAt,
    ],
  );

  const hasChanges = currentSnapshot !== baselineSnapshot;
  const submitDisabled = !base.title.trim();

  const dialogSectionClass = ENTRY_DIALOG_FLAT_SECTION_CLASS;

  const {
    tagsAndFolderProps,
    repromptSectionProps,
    expirationSectionProps,
    actionBarProps,
  } = buildTeamFormSectionsProps({
    teamId,
    tagsTitle: base.entryCopy.tagsTitle,
    tagsHint: base.t("tagsHint"),
    folders: base.teamFolders,
    sectionCardClass: dialogSectionClass,
    isLoginEntry: false,
    hasChanges,
    saving: base.saving,
    submitDisabled,
    saveLabel: base.isEdit ? base.tc("update") : base.tc("save"),
    cancelLabel: base.tc("cancel"),
    statusUnsavedLabel: base.t("statusUnsaved"),
    statusSavedLabel: base.t("statusSaved"),
    repromptTitle: base.t("requireReprompt"),
    repromptDescription: base.t("requireRepromptHelp"),
    repromptPolicyForced: base.teamPolicy?.requireRepromptForAll,
    repromptPolicyForcedLabel: base.teamPolicy?.requireRepromptForAll
      ? base.t("requireRepromptPolicyForced")
      : undefined,
    expirationTitle: base.t("expirationTitle"),
    expirationDescription: base.t("expirationDescription"),
    onCancel: () => base.handleOpenChange(false),
    values: {
      selectedTags: base.selectedTags,
      teamFolderId: base.teamFolderId,
      customFields: [],
      totp: null,
      showTotpInput: false,
      requireReprompt: base.requireReprompt,
      expiresAt: base.expiresAt,
    },
    setters: {
      setSelectedTags: base.setSelectedTags,
      setTeamFolderId: base.setTeamFolderId,
      setCustomFields: () => {},
      setTotp: () => {},
      setShowTotpInput: () => {},
      setRequireReprompt: base.setRequireReprompt,
      setExpiresAt: base.setExpiresAt,
    },
  });

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitDisabled) return;

    if (purchaseDate && expirationDate && purchaseDate >= expirationDate) {
      setExpiryError(tsl("expirationBeforePurchase"));
      return;
    }
    setExpiryError(null);

    const tagNames = base.selectedTags.map((tag) => ({
      name: tag.name,
      color: tag.color,
    }));

    await base.submitEntry({
      entryType: ENTRY_TYPE.SOFTWARE_LICENSE,
      title: base.title,
      notes: base.notes,
      tagNames,
      softwareName,
      licenseKey,
      version,
      licensee,
      email,
      purchaseDate,
      expirationDate,
    });
  };

  return (
    <>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleFormSubmit(e);
          }}
          onKeyDown={preventIMESubmit}
          className="space-y-5"
        >
          <div className="space-y-2">
            <Label>{base.entryCopy.titleLabel}</Label>
            <Input
              value={base.title}
              onChange={(e) => base.setTitle(e.target.value)}
              placeholder={base.entryCopy.titlePlaceholder}
            />
          </div>

          <SoftwareLicenseFields
            idPrefix="team-"
            softwareName={softwareName}
            onSoftwareNameChange={setSoftwareName}
            softwareNamePlaceholder={tsl("softwareNamePlaceholder")}
            licenseKey={licenseKey}
            onLicenseKeyChange={setLicenseKey}
            licenseKeyPlaceholder={tsl("licenseKeyPlaceholder")}
            showLicenseKey={showLicenseKey}
            onToggleLicenseKey={() => setShowLicenseKey(!showLicenseKey)}
            version={version}
            onVersionChange={setVersion}
            versionPlaceholder={tsl("versionPlaceholder")}
            licensee={licensee}
            onLicenseeChange={setLicensee}
            licenseePlaceholder={tsl("licenseePlaceholder")}
            purchaseDate={purchaseDate}
            onPurchaseDateChange={(v) => {
              setPurchaseDate(v);
              setExpiryError(null);
            }}
            expirationDate={expirationDate}
            onExpirationDateChange={(v) => {
              setExpirationDate(v);
              setExpiryError(null);
            }}
            expiryError={expiryError}
            notesLabel={base.entryCopy.notesLabel}
            notes={base.notes}
            onNotesChange={base.setNotes}
            notesPlaceholder={base.entryCopy.notesPlaceholder}
            labels={{
              softwareName: tsl("softwareName"),
              licenseKey: tsl("licenseKey"),
              version: tsl("version"),
              licensee: tsl("licensee"),
              purchaseDate: tsl("purchaseDate"),
              expirationDate: tsl("expirationDate"),
            }}
          />

          <div className="space-y-2">
            <Label htmlFor="team-email">{tsl("email")}</Label>
            <Input
              id="team-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={tsl("emailPlaceholder")}
              autoComplete="off"
            />
          </div>

          <TeamTagsAndFolderSection {...tagsAndFolderProps} />
          <EntryRepromptSection {...repromptSectionProps} />
          <EntryExpirationSection {...expirationSectionProps} />
          <EntryActionBar {...actionBarProps} />
        </form>

        {base.isEdit && editData && (
          <div className="border-t pt-4">
            <TeamAttachmentSection
              teamId={teamId}
              entryId={editData.id}
              attachments={base.attachments}
              onAttachmentsChange={base.setAttachments}
            />
          </div>
        )}
    </>
  );
}
