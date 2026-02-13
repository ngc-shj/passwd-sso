"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { useVault } from "@/lib/vault-context";
import { encryptData } from "@/lib/crypto-client";
import { buildPersonalEntryAAD, AAD_VERSION } from "@/lib/crypto-aad";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TagInput, type TagData } from "@/components/tags/tag-input";
import { Loader2, ArrowLeft, Tags, BadgeCheck } from "lucide-react";
import { toast } from "sonner";
import { API_PATH, ENTRY_TYPE, apiPath } from "@/lib/constants";

interface SecureNoteFormProps {
  mode: "create" | "edit";
  initialData?: {
    id: string;
    title: string;
    content: string;
    tags: TagData[];
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

  const baselineSnapshot = useMemo(
    () =>
      JSON.stringify({
        title: initialData?.title ?? "",
        content: initialData?.content ?? "",
        selectedTagIds: (initialData?.tags ?? []).map((tag) => tag.id).sort(),
      }),
    [initialData]
  );

  const currentSnapshot = useMemo(
    () =>
      JSON.stringify({
        title,
        content,
        selectedTagIds: selectedTags.map((tag) => tag.id).sort(),
      }),
    [title, content, selectedTags]
  );

  const hasChanges = currentSnapshot !== baselineSnapshot;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!encryptionKey) return;
    setSubmitting(true);

    try {
      const tags = selectedTags.map((t) => ({
        name: t.name,
        color: t.color,
      }));

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

      const entryId = mode === "create" ? crypto.randomUUID() : initialData!.id;
      const aad = userId ? buildPersonalEntryAAD(userId, entryId) : undefined;

      const encryptedBlob = await encryptData(fullBlob, encryptionKey, aad);
      const encryptedOverview = await encryptData(overviewBlob, encryptionKey, aad);

      const body = {
        ...(mode === "create" ? { id: entryId } : {}),
        encryptedBlob,
        encryptedOverview,
        keyVersion: 1,
        aadVersion: aad ? AAD_VERSION : 0,
        tagIds: selectedTags.map((t) => t.id),
        entryType: ENTRY_TYPE.SECURE_NOTE,
      };

      const endpoint =
        mode === "create"
          ? API_PATH.PASSWORDS
          : apiPath.passwordById(initialData!.id);
      const method = mode === "create" ? "POST" : "PUT";

      const res = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="rounded-xl border bg-gradient-to-b from-muted/30 to-background p-4 space-y-4 transition-colors">
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
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </div>

      <div className="space-y-2 rounded-xl border bg-muted/20 p-4 transition-colors hover:bg-muted/30">
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
      </div>

      <div className="sticky bottom-0 z-10 -mx-1 rounded-lg border bg-background/90 px-3 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="flex items-center justify-between gap-3">
          <div
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] ${
              hasChanges
                ? "bg-amber-100 text-amber-800"
                : "bg-emerald-100 text-emerald-800"
            }`}
          >
            <BadgeCheck className="h-3.5 w-3.5" />
            {hasChanges ? tPw("statusUnsaved") : tPw("statusSaved")}
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={submitting}>
              {submitting && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              {mode === "create" ? tc("save") : tc("update")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleCancel}
            >
              {tc("cancel")}
            </Button>
          </div>
        </div>
      </div>
    </form>
  );

  if (variant === "dialog") {
    return formContent;
  }

  return (
    <div className="mx-auto max-w-2xl p-4 md:p-6">
      <Button
        variant="ghost"
        className="mb-4 gap-2"
        onClick={() => router.back()}
      >
        <ArrowLeft className="h-4 w-4" />
        {tc("back")}
      </Button>

      <Card>
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
  );
}
