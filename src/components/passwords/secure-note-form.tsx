"use client";

import { useState } from "react";
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
import { Loader2, ArrowLeft } from "lucide-react";
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
  const tc = useTranslations("Common");
  const router = useRouter();
  const { encryptionKey, userId } = useVault();
  const [submitting, setSubmitting] = useState(false);

  const [title, setTitle] = useState(initialData?.title ?? "");
  const [content, setContent] = useState(initialData?.content ?? "");
  const [selectedTags, setSelectedTags] = useState<TagData[]>(
    initialData?.tags ?? []
  );

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
    <form onSubmit={handleSubmit} className="space-y-4">
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

      <div className="space-y-2">
        <Label>{t("tags")}</Label>
        <TagInput
          selectedTags={selectedTags}
          onChange={setSelectedTags}
        />
      </div>

      <div className="flex gap-2 pt-4">
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
