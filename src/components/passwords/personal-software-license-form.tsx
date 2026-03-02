"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { TagData } from "@/components/tags/tag-input";
import { ArrowLeft } from "lucide-react";
import { SoftwareLicenseFields } from "@/components/entry-fields/software-license-fields";
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
import { buildPersonalFormSectionsProps } from "@/hooks/personal-form-sections-props";
import { usePersonalBaseFormModel } from "@/hooks/use-personal-base-form-model";

interface SoftwareLicenseFormProps {
  mode: "create" | "edit";
  initialData?: {
    id: string;
    title: string;
    softwareName: string | null;
    licenseKey: string | null;
    version: string | null;
    licensee: string | null;
    email: string | null;
    purchaseDate: string | null;
    expirationDate: string | null;
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

export function SoftwareLicenseForm({
  mode,
  initialData,
  variant = "page",
  onSaved,
  defaultFolderId,
  defaultTags,
}: SoftwareLicenseFormProps) {
  const t = useTranslations("SoftwareLicenseForm");
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
  const [showLicenseKey, setShowLicenseKey] = useState(false);
  const [expirationError, setExpirationError] = useState<string | null>(null);
  const [softwareName, setSoftwareName] = useState(
    initialData?.softwareName ?? "",
  );
  const [licenseKey, setLicenseKey] = useState(initialData?.licenseKey ?? "");
  const [version, setVersion] = useState(initialData?.version ?? "");
  const [licensee, setLicensee] = useState(initialData?.licensee ?? "");
  const [email, setEmail] = useState(initialData?.email ?? "");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [purchaseDate, setPurchaseDate] = useState(
    initialData?.purchaseDate ?? "",
  );
  const [expirationDate, setExpirationDate] = useState(
    initialData?.expirationDate ?? "",
  );
  const [notes, setNotes] = useState(initialData?.notes ?? "");

  const baselineSnapshot = useMemo(
    () =>
      JSON.stringify({
        title: initialData?.title ?? "",
        softwareName: initialData?.softwareName ?? "",
        licenseKey: initialData?.licenseKey ?? "",
        version: initialData?.version ?? "",
        licensee: initialData?.licensee ?? "",
        email: initialData?.email ?? "",
        purchaseDate: initialData?.purchaseDate ?? "",
        expirationDate: initialData?.expirationDate ?? "",
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
        softwareName,
        licenseKey,
        version,
        licensee,
        email,
        purchaseDate,
        expirationDate,
        notes,
        selectedTagIds: base.selectedTags.map((tag) => tag.id).sort(),
        folderId: base.folderId,
        requireReprompt: base.requireReprompt,
        expiresAt: base.expiresAt,
      }),
    [
      base.title,
      softwareName,
      licenseKey,
      version,
      licensee,
      email,
      purchaseDate,
      expirationDate,
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
  const {
    tagsAndFolderProps,
    repromptSectionProps,
    expirationSectionProps,
    actionBarProps,
  } = buildPersonalFormSectionsProps({
    tagsTitle: t("tags"),
    tagsHint: tPw("tagsHint"),
    folders: base.folders,
    sectionCardClass: dialogSectionClass,
    repromptTitle: tPw("requireReprompt"),
    repromptDescription: tPw("requireRepromptHelp"),
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
      expiresAt: base.expiresAt,
    },
    setters: {
      setSelectedTags: base.setSelectedTags,
      setFolderId: base.setFolderId,
      setCustomFields: () => {},
      setTotp: () => {},
      setShowTotpInput: () => {},
      setRequireReprompt: base.setRequireReprompt,
      setExpiresAt: base.setExpiresAt,
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setEmailError(t("invalidEmail"));
      return;
    }
    setEmailError(null);

    if (purchaseDate && expirationDate && purchaseDate >= expirationDate) {
      setExpirationError(t("expirationBeforePurchase"));
      return;
    }
    setExpirationError(null);

    const tags = toTagPayload(base.selectedTags);

    await base.submitEntry({
      t: tPw,
      fullBlob: JSON.stringify({
        title: base.title,
        softwareName: softwareName || null,
        licenseKey: licenseKey || null,
        version: version || null,
        licensee: licensee || null,
        email: email || null,
        purchaseDate: purchaseDate || null,
        expirationDate: expirationDate || null,
        notes: notes || null,
        tags,
      }),
      overviewBlob: JSON.stringify({
        title: base.title,
        softwareName: softwareName || null,
        licensee: licensee || null,
        tags,
      }),
      entryType: ENTRY_TYPE.SOFTWARE_LICENSE,
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

        <SoftwareLicenseFields
          softwareName={softwareName}
          onSoftwareNameChange={setSoftwareName}
          softwareNamePlaceholder={t("softwareNamePlaceholder")}
          licenseKey={licenseKey}
          onLicenseKeyChange={setLicenseKey}
          licenseKeyPlaceholder={t("licenseKeyPlaceholder")}
          showLicenseKey={showLicenseKey}
          onToggleLicenseKey={() => setShowLicenseKey(!showLicenseKey)}
          version={version}
          onVersionChange={setVersion}
          versionPlaceholder={t("versionPlaceholder")}
          licensee={licensee}
          onLicenseeChange={setLicensee}
          licenseePlaceholder={t("licenseePlaceholder")}
          purchaseDate={purchaseDate}
          onPurchaseDateChange={(v) => {
            setPurchaseDate(v);
            setExpirationError(null);
          }}
          expirationDate={expirationDate}
          onExpirationDateChange={(v) => {
            setExpirationDate(v);
            setExpirationError(null);
          }}
          expiryError={expirationError}
          notesLabel={t("notes")}
          notes={notes}
          onNotesChange={setNotes}
          notesPlaceholder={t("notesPlaceholder")}
          labels={{
            softwareName: t("softwareName"),
            licenseKey: t("licenseKey"),
            version: t("version"),
            licensee: t("licensee"),
            purchaseDate: t("purchaseDate"),
            expirationDate: t("expirationDate"),
          }}
        />

        <div className="space-y-2">
          <Label htmlFor="email">{t("email")}</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setEmailError(null);
            }}
            placeholder={t("emailPlaceholder")}
            autoComplete="off"
          />
          {emailError && <p className="text-destructive text-sm">{emailError}</p>}
        </div>
      </EntryPrimaryCard>

      <EntryTagsAndFolderSection {...tagsAndFolderProps} />
      <EntryRepromptSection {...repromptSectionProps} />
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
            <CardTitle>{mode === "create" ? t("newLicense") : t("editLicense")}</CardTitle>
          </CardHeader>
          <CardContent>{formContent}</CardContent>
        </Card>
      </div>
    </div>
  );
}
