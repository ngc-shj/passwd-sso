"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { TagData } from "@/components/tags/tag-input";
import { ArrowLeft } from "lucide-react";
import { SshKeyFields } from "@/components/entry-fields/ssh-key-fields";
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
import { parseSshPrivateKey } from "@/lib/ssh-key";

interface SshKeyFormProps {
  mode: "create" | "edit";
  initialData?: {
    id: string;
    title: string;
    privateKey: string | null;
    publicKey: string | null;
    keyType: string | null;
    keySize: number | null;
    fingerprint: string | null;
    passphrase: string | null;
    comment: string | null;
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

export function SshKeyForm({
  mode,
  initialData,
  variant = "page",
  onSaved,
  onCancel,
  defaultFolderId,
  defaultTags,
}: SshKeyFormProps) {
  const t = useTranslations("SshKeyForm");
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

  const [privateKey, setPrivateKey] = useState(initialData?.privateKey ?? "");
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [publicKey, setPublicKey] = useState(initialData?.publicKey ?? "");
  const [keyType, setKeyType] = useState(initialData?.keyType ?? "");
  const [keySize, setKeySize] = useState(initialData?.keySize ?? 0);
  const [fingerprint, setFingerprint] = useState(initialData?.fingerprint ?? "");
  const [passphrase, setPassphrase] = useState(initialData?.passphrase ?? "");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [comment, setComment] = useState(initialData?.comment ?? "");
  const [notes, setNotes] = useState(initialData?.notes ?? "");
  const [travelSafe, setTravelSafe] = useState(initialData?.travelSafe ?? true);

  // Auto-parse SSH key when private key changes
  const handlePrivateKeyChange = useCallback(async (pem: string) => {
    setPrivateKey(pem);
    if (!pem.trim()) {
      return;
    }
    try {
      const parsed = await parseSshPrivateKey(pem);
      if (parsed) {
        setPublicKey(parsed.publicKey);
        setKeyType(parsed.keyType);
        setKeySize(parsed.keySize);
        setFingerprint(parsed.fingerprint);
        if (parsed.comment) setComment(parsed.comment);
      }
    } catch {
      // Parse failed — user may still be pasting
    }
  }, []);

  // Parse on initial load if we have a private key
  useEffect(() => {
    if (initialData?.privateKey && !initialData?.fingerprint) {
      void handlePrivateKeyChange(initialData.privateKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const baselineSnapshot = useMemo(
    () =>
      JSON.stringify({
        title: initialData?.title ?? "",
        privateKey: initialData?.privateKey ?? "",
        publicKey: initialData?.publicKey ?? "",
        passphrase: initialData?.passphrase ?? "",
        comment: initialData?.comment ?? "",
        notes: initialData?.notes ?? "",
        selectedTagIds: (initialData?.tags ?? defaultTags ?? [])
          .map((tag) => tag.id)
          .sort(),
        folderId: initialData?.folderId ?? defaultFolderId ?? null,
        requireReprompt: initialData?.requireReprompt ?? false,
        travelSafe: initialData?.travelSafe ?? true,
        expiresAt: initialData?.expiresAt ?? null,
      }),
    [initialData, defaultFolderId, defaultTags],
  );

  const currentSnapshot = useMemo(
    () =>
      JSON.stringify({
        title: base.title,
        privateKey,
        publicKey,
        passphrase,
        comment,
        notes,
        selectedTagIds: base.selectedTags.map((tag) => tag.id).sort(),
        folderId: base.folderId,
        requireReprompt: base.requireReprompt,
        travelSafe,
        expiresAt: base.expiresAt,
      }),
    [
      base.title,
      privateKey,
      publicKey,
      passphrase,
      comment,
      notes,
      base.selectedTags,
      base.folderId,
      base.requireReprompt,
      travelSafe,
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

    await base.submitEntry({
      t: tPw,
      fullBlob: JSON.stringify({
        title: base.title,
        privateKey: privateKey || null,
        publicKey: publicKey || null,
        keyType: keyType || null,
        keySize: keySize || null,
        fingerprint: fingerprint || null,
        passphrase: passphrase || null,
        comment: comment || null,
        notes: notes || null,
        tags,
      }),
      overviewBlob: JSON.stringify({
        title: base.title,
        keyType: keyType || null,
        fingerprint: fingerprint || null,
        publicKey: publicKey || null,
        comment: comment || null,
        tags,
      }),
      entryType: ENTRY_TYPE.SSH_KEY,
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

        <SshKeyFields
          privateKey={privateKey}
          onPrivateKeyChange={handlePrivateKeyChange}
          privateKeyPlaceholder={t("privateKeyPlaceholder")}
          showPrivateKey={showPrivateKey}
          onTogglePrivateKey={() => setShowPrivateKey(!showPrivateKey)}
          publicKey={publicKey}
          onPublicKeyChange={setPublicKey}
          publicKeyPlaceholder={t("publicKeyPlaceholder")}
          keyType={keyType}
          fingerprint={fingerprint}
          keySize={keySize}
          passphrase={passphrase}
          onPassphraseChange={setPassphrase}
          passphrasePlaceholder={t("passphrasePlaceholder")}
          showPassphrase={showPassphrase}
          onTogglePassphrase={() => setShowPassphrase(!showPassphrase)}
          comment={comment}
          onCommentChange={setComment}
          commentPlaceholder={t("commentPlaceholder")}
          notesLabel={t("notes")}
          notes={notes}
          onNotesChange={setNotes}
          notesPlaceholder={t("notesPlaceholder")}
          autoDetectedLabel={t("autoDetected")}
          labels={{
            privateKey: t("privateKey"),
            publicKey: t("publicKey"),
            keyType: t("keyType"),
            keySize: t("keySize"),
            fingerprint: t("fingerprint"),
            passphrase: t("passphrase"),
            comment: t("comment"),
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
              {mode === "create" ? t("newSshKey") : t("editSshKey")}
            </CardTitle>
          </CardHeader>
          <CardContent>{formContent}</CardContent>
        </Card>
      </div>
    </div>
  );
}
