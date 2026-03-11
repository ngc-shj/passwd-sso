"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { TagData } from "@/components/tags/tag-input";
import { ArrowLeft } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ENTRY_TYPE } from "@/lib/constants";
import { SECURE_NOTE_TEMPLATES } from "@/lib/secure-note-templates";
import { SecureNoteFields } from "@/components/entry-fields/secure-note-fields";
import { preventIMESubmit } from "@/lib/ime-guard";
import { toTagPayload } from "@/components/passwords/entry-form-tags";
import { buildPersonalFormSectionsProps } from "@/hooks/personal-form-sections-props";
import { usePersonalBaseFormModel } from "@/hooks/use-personal-base-form-model";
import { useBeforeUnloadGuard } from "@/hooks/use-before-unload-guard";

interface SecureNoteFormProps {
  mode: "create" | "edit";
  initialData?: {
    id: string;
    title: string;
    content: string;
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

export function SecureNoteForm({
  mode,
  initialData,
  variant = "page",
  onSaved,
  onCancel,
  defaultFolderId,
  defaultTags,
}: SecureNoteFormProps) {
  const t = useTranslations("SecureNoteForm");
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
  const [content, setContent] = useState(initialData?.content ?? "");
  const [travelSafe, setTravelSafe] = useState(initialData?.travelSafe ?? true);

  const baselineSnapshot = useMemo(
    () =>
      JSON.stringify({
        title: initialData?.title ?? "",
        content: initialData?.content ?? "",
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
        content,
        selectedTagIds: base.selectedTags.map((tag) => tag.id).sort(),
        folderId: base.folderId,
        requireReprompt: base.requireReprompt,
        travelSafe,
        expiresAt: base.expiresAt,
      }),
    [
      base.title,
      content,
      base.selectedTags,
      base.folderId,
      base.requireReprompt,
      travelSafe,
      base.expiresAt,
    ],
  );

  const hasChanges = currentSnapshot !== baselineSnapshot;
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
    const snippet = content.slice(0, 100);

    await base.submitEntry({
      t: tPw,
      fullBlob: JSON.stringify({
        title: base.title,
        content,
        tags,
        isMarkdown: true,
        travelSafe,
      }),
      overviewBlob: JSON.stringify({
        title: base.title,
        snippet,
        tags,
        travelSafe,
      }),
      entryType: ENTRY_TYPE.SECURE_NOTE,
    });
  };

  const formContent = (
    <form onSubmit={handleSubmit} onKeyDown={preventIMESubmit} className="space-y-5">
      <EntryPrimaryCard className={primaryCardClass}>
        {mode === "create" && (
          <div className="space-y-2">
            <Label>{t("templateLabel")}</Label>
            <Select
              defaultValue="blank"
              onValueChange={(templateId) => {
                const tmpl = SECURE_NOTE_TEMPLATES.find((tp) => tp.id === templateId);
                if (!tmpl) return;
                if (tmpl.id === "blank") {
                  base.setTitle("");
                  setContent("");
                  return;
                }
                base.setTitle(t(tmpl.titleKey));
                setContent(tmpl.contentTemplate);
              }}
            >
              <SelectTrigger className="w-full max-w-[300px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SECURE_NOTE_TEMPLATES.map((tmpl) => (
                  <SelectItem key={tmpl.id} value={tmpl.id}>
                    {t(tmpl.titleKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

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

        <SecureNoteFields
          content={content}
          onContentChange={setContent}
          contentLabel={t("content")}
          contentPlaceholder={t("contentPlaceholder")}
          editTabLabel={t("editTab")}
          previewTabLabel={t("previewTab")}
          markdownHint={t("markdownHint")}
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
            <CardTitle>{mode === "create" ? t("newNote") : t("editNote")}</CardTitle>
          </CardHeader>
          <CardContent>{formContent}</CardContent>
        </Card>
      </div>
    </div>
  );
}
