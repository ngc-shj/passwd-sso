"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SshKeyFields } from "@/components/entry-fields/ssh-key-fields";
import { TeamTagsAndFolderSection } from "@/components/team/forms/team-tags-and-folder-section";
import { EntryRepromptSection } from "@/components/passwords/entry/entry-reprompt-section";
import { EntryTravelSafeSection } from "@/components/passwords/entry/entry-travel-safe-section";
import { EntryExpirationSection } from "@/components/passwords/entry/entry-expiration-section";
import { TeamAttachmentSection } from "./team-attachment-section";
import {
  EntryActionBar,
  ENTRY_DIALOG_FLAT_SECTION_CLASS,
} from "@/components/passwords/entry/entry-form-ui";
import type { TeamEntryFormProps } from "@/components/team/forms/team-entry-form-types";
import { preventIMESubmit } from "@/lib/ui/ime-guard";
import { ENTRY_TYPE } from "@/lib/constants";
import { useTeamBaseFormModel } from "@/hooks/team/use-team-base-form-model";
import { buildTeamFormSectionsProps } from "@/hooks/team/team-form-sections-props";
import { useEntryHasChanges } from "@/hooks/form/use-entry-has-changes";
import { parseSshPrivateKey } from "@/lib/format/ssh-key";

export function TeamSshKeyForm({
  teamId,
  open,
  onOpenChange,
  onSaved,
  entryType,
  editData,
  defaultFolderId,
  defaultTags,
}: TeamEntryFormProps) {
  const tsk = useTranslations("SshKeyForm");
  const ttm = useTranslations("TravelMode");
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
  const [privateKey, setPrivateKey] = useState(editData?.privateKey ?? "");
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [publicKey, setPublicKey] = useState(editData?.publicKey ?? "");
  const [keyType, setKeyType] = useState(editData?.keyType ?? "");
  const [keySize, setKeySize] = useState(editData?.keySize ?? 0);
  const [fingerprint, setFingerprint] = useState(editData?.fingerprint ?? "");
  const [passphrase, setPassphrase] = useState(editData?.passphrase ?? "");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [sshComment, setSshComment] = useState(editData?.sshComment ?? "");
  const [privateKeyWarning, setPrivateKeyWarning] = useState("");

  // Auto-parse SSH key and show warning on failure
  const handlePrivateKeyChange = useCallback(async (pem: string) => {
    setPrivateKey(pem);
    if (!pem.trim()) {
      setPublicKey("");
      setKeyType("");
      setKeySize(0);
      setFingerprint("");
      setPrivateKeyWarning("");
      return;
    }
    try {
      const parsed = await parseSshPrivateKey(pem);
      if (parsed) {
        setPublicKey(parsed.publicKey);
        setKeyType(parsed.keyType);
        setKeySize(parsed.keySize);
        setFingerprint(parsed.fingerprint);
        if (parsed.comment) setSshComment(parsed.comment);
        setPrivateKeyWarning("");
      } else {
        setPrivateKeyWarning(tsk("privateKeyFormatWarning"));
      }
    } catch {
      setPrivateKeyWarning(tsk("privateKeyFormatWarning"));
    }
  }, [tsk]);

  // Parse on initial load
  useEffect(() => {
    if (editData?.privateKey) {
      void handlePrivateKeyChange(editData.privateKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasChanges = useEntryHasChanges(
    () => ({
      title: base.title,
      notes: base.notes,
      privateKey,
      publicKey,
      passphrase,
      sshComment,
      selectedTagIds: base.selectedTags.map((tag) => tag.id).sort(),
      teamFolderId: base.teamFolderId,
      requireReprompt: base.requireReprompt,
      travelSafe: base.travelSafe,
      expiresAt: base.expiresAt,
    }),
    [
      base.title,
      base.notes,
      privateKey,
      publicKey,
      passphrase,
      sshComment,
      base.selectedTags,
      base.teamFolderId,
      base.requireReprompt,
      base.travelSafe,
      base.expiresAt,
    ],
  );
  const submitDisabled = !base.title.trim();

  const dialogSectionClass = ENTRY_DIALOG_FLAT_SECTION_CLASS;

  const {
    tagsAndFolderProps,
    repromptSectionProps,
    travelSafeSectionProps,
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
    travelSafeTitle: ttm("travelSafe"),
    travelSafeDescription: ttm("travelSafeDescription"),
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
      travelSafe: base.travelSafe,
      expiresAt: base.expiresAt,
    },
    setters: {
      setSelectedTags: base.setSelectedTags,
      setTeamFolderId: base.setTeamFolderId,
      setCustomFields: () => {},
      setTotp: () => {},
      setShowTotpInput: () => {},
      setRequireReprompt: base.setRequireReprompt,
      setTravelSafe: base.setTravelSafe,
      setExpiresAt: base.setExpiresAt,
    },
  });

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitDisabled) return;

    const tagNames = base.selectedTags.map((tag) => ({
      name: tag.name,
      color: tag.color,
    }));

    await base.submitEntry({
      entryType: ENTRY_TYPE.SSH_KEY,
      title: base.title,
      notes: base.notes,
      tagNames,
      privateKey: privateKey || undefined,
      publicKey: publicKey || undefined,
      keyType: keyType || undefined,
      keySize: keySize || undefined,
      fingerprint: fingerprint || undefined,
      passphrase: passphrase || undefined,
      sshComment: sshComment || undefined,
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

          <SshKeyFields
            idPrefix="team-"
            privateKey={privateKey}
            onPrivateKeyChange={handlePrivateKeyChange}
            privateKeyPlaceholder={tsk("privateKeyPlaceholder")}
            showPrivateKey={showPrivateKey}
            onTogglePrivateKey={() => setShowPrivateKey(!showPrivateKey)}
            publicKey={publicKey}
            onPublicKeyChange={setPublicKey}
            publicKeyPlaceholder={tsk("publicKeyPlaceholder")}
            keyType={keyType}
            fingerprint={fingerprint}
            keySize={keySize}
            passphrase={passphrase}
            onPassphraseChange={setPassphrase}
            passphrasePlaceholder={tsk("passphrasePlaceholder")}
            showPassphrase={showPassphrase}
            onTogglePassphrase={() => setShowPassphrase(!showPassphrase)}
            comment={sshComment}
            onCommentChange={setSshComment}
            commentPlaceholder={tsk("commentPlaceholder")}
            notesLabel={base.entryCopy.notesLabel}
            notes={base.notes}
            onNotesChange={base.setNotes}
            notesPlaceholder={base.entryCopy.notesPlaceholder}
            autoDetectedLabel={tsk("autoDetected")}
            privateKeyWarning={privateKeyWarning}
            labels={{
              privateKey: tsk("privateKey"),
              publicKey: tsk("publicKey"),
              keyType: tsk("keyType"),
              keySize: tsk("keySize"),
              fingerprint: tsk("fingerprint"),
              passphrase: tsk("passphrase"),
              comment: tsk("comment"),
              show: tsk("show"),
              hide: tsk("hide"),
            }}
          />

          <TeamTagsAndFolderSection {...tagsAndFolderProps} />
          <EntryRepromptSection {...repromptSectionProps} />
          <EntryTravelSafeSection {...travelSafeSectionProps} />
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
