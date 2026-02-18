"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { useVault } from "@/lib/vault-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TagInput, type TagData } from "@/components/tags/tag-input";
import { ArrowLeft, Tags } from "lucide-react";
import { EntryActionBar, EntryPrimaryCard, EntrySectionCard } from "@/components/passwords/entry-form-ui";
import { EntryFolderSelectSection } from "@/components/passwords/entry-folder-select-section";
import { toast } from "sonner";
import { ENTRY_TYPE } from "@/lib/constants";
import { preventIMESubmit } from "@/lib/ime-guard";
import { usePersonalFolders } from "@/hooks/use-personal-folders";
import { savePersonalEntry } from "@/lib/personal-entry-save";
import { toTagIds, toTagPayload } from "@/components/passwords/entry-form-tags";

interface SecureNoteFormProps {
  mode: "create" | "edit";
  initialData?: {
    id: string;
    title: string;
    content: string;
    tags: TagData[];
    folderId?: string | null;
  };
  variant?: "page" | "dialog";
  onSaved?: () => void;
}

export function SecureNoteForm({ mode, initialData, variant = "page", onSaved }: SecureNoteFormProps) {
  const t = useTranslations("SecureNoteForm");
  const tPw = useTranslations("PasswordForm");
  const tc = useTranslations("Common");
  const router = useRouter();
  const { encryptionKey, userId } = useVault();
  const [submitting, setSubmitting] = useState(false);

  const [title, setTitle] = useState(initialData?.title ?? "");
  const [content, setContent] = useState(initialData?.content ?? "");
  const [selectedTags, setSelectedTags] = useState<TagData[]>(
    initialData?.tags ?? []
  );
  const [folderId, setFolderId] = useState<string | null>(initialData?.folderId ?? null);
  const folders = usePersonalFolders();

  const baselineSnapshot = useMemo(
    () =>
      JSON.stringify({
        title: initialData?.title ?? "",
        content: initialData?.content ?? "",
        selectedTagIds: (initialData?.tags ?? []).map((tag) => tag.id).sort(),
        folderId: initialData?.folderId ?? null,
      }),
    [initialData]
  );

  const currentSnapshot = useMemo(
    () =>
      JSON.stringify({
        title,
        content,
        selectedTagIds: selectedTags.map((tag) => tag.id).sort(),
        folderId,
      }),
    [title, content, selectedTags, folderId]
  );

  const hasChanges = currentSnapshot !== baselineSnapshot;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!encryptionKey) return;
    setSubmitting(true);

    try {
      const tags = toTagPayload(selectedTags);

      const snippet = content.slice(0, 100);

      const fullBlob = JSON.stringify({
        title,
        content,
        tags,
      });

      const overviewBlob = JSON.stringify({
        title,
        snippet,
        tags,
      });

      const res = await savePersonalEntry({
        mode,
        initialId: initialData?.id,
        encryptionKey,
        userId: userId ?? undefined,
        fullBlob,
        overviewBlob,
        tagIds: toTagIds(selectedTags),
        folderId: folderId ?? null,
        entryType: ENTRY_TYPE.SECURE_NOTE,
      });

      if (res.ok) {
        toast.success(mode === "create" ? t("saved") : t("updated"));
        if (onSaved) {
          onSaved();
        } else {
          router.push("/dashboard");
          router.refresh();
        }
      } else {
        toast.error(t("failedToSave"));
      }
    } catch {
      toast.error(t("networkError"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    if (onSaved) {
      onSaved();
    } else {
      router.back();
    }
  };

  const formContent = (
    <form onSubmit={handleSubmit} onKeyDown={preventIMESubmit} className="space-y-5">
      <EntryPrimaryCard>
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
          <Label htmlFor="content">{t("content")}</Label>
          <textarea
            id="content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={t("contentPlaceholder")}
            rows={10}
            maxLength={50000}
            required
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </EntryPrimaryCard>

      <EntrySectionCard>
        <div className="space-y-1">
          <Label className="flex items-center gap-2">
            <Tags className="h-3.5 w-3.5" />
            {t("tags")}
          </Label>
          <p className="text-xs text-muted-foreground">{tPw("tagsHint")}</p>
        </div>
        <TagInput
          selectedTags={selectedTags}
          onChange={setSelectedTags}
        />
      </EntrySectionCard>

      <EntryFolderSelectSection
        folders={folders}
        value={folderId}
        onChange={setFolderId}
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
        onClick={() => router.back()}
      >
        <ArrowLeft className="h-4 w-4" />
        {tc("back")}
      </Button>

      <Card className="rounded-xl border">
        <CardHeader>
          <CardTitle>
            {mode === "create" ? t("newNote") : t("editNote")}
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
