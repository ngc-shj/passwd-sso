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

export function SoftwareLicenseForm({ mode, initialData, variant = "page", onSaved, defaultFolderId, defaultTags }: SoftwareLicenseFormProps) {
  const t = useTranslations("SoftwareLicenseForm");
  const tPw = useTranslations("PasswordForm");
  const tc = useTranslations("Common");
  const router = useRouter();
  const { encryptionKey, userId } = useVault();
  const [submitting, setSubmitting] = useState(false);
  const [showLicenseKey, setShowLicenseKey] = useState(false);
  const [expirationError, setExpirationError] = useState<string | null>(null);
  const [requireReprompt, setRequireReprompt] = useState(initialData?.requireReprompt ?? false);
  const [expiresAt, setExpiresAt] = useState<string | null>(initialData?.expiresAt ?? null);

  const [title, setTitle] = useState(initialData?.title ?? "");
  const [softwareName, setSoftwareName] = useState(initialData?.softwareName ?? "");
  const [licenseKey, setLicenseKey] = useState(initialData?.licenseKey ?? "");
  const [version, setVersion] = useState(initialData?.version ?? "");
  const [licensee, setLicensee] = useState(initialData?.licensee ?? "");
  const [email, setEmail] = useState(initialData?.email ?? "");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [purchaseDate, setPurchaseDate] = useState(initialData?.purchaseDate ?? "");
  const [expirationDate, setExpirationDate] = useState(initialData?.expirationDate ?? "");
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
        softwareName: initialData?.softwareName ?? "",
        licenseKey: initialData?.licenseKey ?? "",
        version: initialData?.version ?? "",
        licensee: initialData?.licensee ?? "",
        email: initialData?.email ?? "",
        purchaseDate: initialData?.purchaseDate ?? "",
        expirationDate: initialData?.expirationDate ?? "",
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
        softwareName,
        licenseKey,
        version,
        licensee,
        email,
        purchaseDate,
        expirationDate,
        notes,
        selectedTagIds: selectedTags.map((tag) => tag.id).sort(),
        folderId,
        requireReprompt,
        expiresAt,
      }),
    [
      title, softwareName, licenseKey, version, licensee, email,
      purchaseDate, expirationDate, notes, selectedTags, folderId,
      requireReprompt, expiresAt,
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

    const tags = toTagPayload(selectedTags);
    const fullBlob = JSON.stringify({
      title,
      softwareName: softwareName || null,
      licenseKey: licenseKey || null,
      version: version || null,
      licensee: licensee || null,
      email: email || null,
      purchaseDate: purchaseDate || null,
      expirationDate: expirationDate || null,
      notes: notes || null,
      tags,
    });

    const overviewBlob = JSON.stringify({
      title,
      softwareName: softwareName || null,
      licensee: licensee || null,
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
      entryType: ENTRY_TYPE.SOFTWARE_LICENSE,
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
        <Label htmlFor="softwareName">{t("softwareName")}</Label>
        <Input
          id="softwareName"
          value={softwareName}
          onChange={(e) => setSoftwareName(e.target.value)}
          placeholder={t("softwareNamePlaceholder")}
          autoComplete="off"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="licenseKey">{t("licenseKey")}</Label>
        <div className="relative">
          <Input
            id="licenseKey"
            type={showLicenseKey ? "text" : "password"}
            value={licenseKey}
            onChange={(e) => setLicenseKey(e.target.value)}
            placeholder={t("licenseKeyPlaceholder")}
            autoComplete="off"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
            onClick={() => setShowLicenseKey(!showLicenseKey)}
          >
            {showLicenseKey ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="version">{t("version")}</Label>
          <Input
            id="version"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder={t("versionPlaceholder")}
            autoComplete="off"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="licensee">{t("licensee")}</Label>
          <Input
            id="licensee"
            value={licensee}
            onChange={(e) => setLicensee(e.target.value)}
            placeholder={t("licenseePlaceholder")}
            autoComplete="off"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">{t("email")}</Label>
        <Input
          id="email"
          type="email"
          value={email}
          onChange={(e) => { setEmail(e.target.value); setEmailError(null); }}
          placeholder={t("emailPlaceholder")}
          autoComplete="off"
        />
        {emailError && <p className="text-destructive text-sm">{emailError}</p>}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="purchaseDate">{t("purchaseDate")}</Label>
          <Input
            id="purchaseDate"
            type="date"
            value={purchaseDate}
            onChange={(e) => {
              setPurchaseDate(e.target.value);
              setExpirationError(null);
            }}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="expirationDate">{t("expirationDate")}</Label>
          <Input
            id="expirationDate"
            type="date"
            value={expirationDate}
            onChange={(e) => {
              setExpirationDate(e.target.value);
              setExpirationError(null);
            }}
          />
        </div>
      </div>
      {expirationError && (
        <p className="text-sm text-destructive">{expirationError}</p>
      )}

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
            {mode === "create" ? t("newLicense") : t("editLicense")}
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
