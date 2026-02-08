"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

interface OrgPasswordFormProps {
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  editData?: {
    id: string;
    title: string;
    username: string | null;
    password: string;
    url: string | null;
    notes: string | null;
  } | null;
}

export function OrgPasswordForm({
  orgId,
  open,
  onOpenChange,
  onSaved,
  editData,
}: OrgPasswordFormProps) {
  const t = useTranslations("PasswordForm");
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState(editData?.title ?? "");
  const [username, setUsername] = useState(editData?.username ?? "");
  const [password, setPassword] = useState(editData?.password ?? "");
  const [url, setUrl] = useState(editData?.url ?? "");
  const [notes, setNotes] = useState(editData?.notes ?? "");

  const isEdit = !!editData;

  const handleOpenChange = (v: boolean) => {
    if (!v) {
      setTitle("");
      setUsername("");
      setPassword("");
      setUrl("");
      setNotes("");
      setSaving(false);
    } else if (editData) {
      setTitle(editData.title);
      setUsername(editData.username ?? "");
      setPassword(editData.password);
      setUrl(editData.url ?? "");
      setNotes(editData.notes ?? "");
    }
    onOpenChange(v);
  };

  const handleSubmit = async () => {
    if (!title.trim() || !password) return;
    setSaving(true);

    try {
      const endpoint = isEdit
        ? `/api/orgs/${orgId}/passwords/${editData.id}`
        : `/api/orgs/${orgId}/passwords`;

      const res = await fetch(endpoint, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          username: username.trim() || undefined,
          password,
          url: url.trim() || undefined,
          notes: notes.trim() || undefined,
        }),
      });

      if (!res.ok) throw new Error("Failed");

      toast.success(isEdit ? t("updated") : t("saved"));
      handleOpenChange(false);
      onSaved();
    } catch {
      toast.error(t("failedToSave"));
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t("editPassword") : t("newPassword")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t("title")}</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("titlePlaceholder")}
            />
          </div>

          <div className="space-y-2">
            <Label>{t("usernameEmail")}</Label>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t("usernamePlaceholder")}
            />
          </div>

          <div className="space-y-2">
            <Label>{t("password")}</Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("passwordPlaceholder")}
            />
          </div>

          <div className="space-y-2">
            <Label>{t("url")}</Label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://..."
            />
          </div>

          <div className="space-y-2">
            <Label>{t("notes")}</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("notesPlaceholder")}
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            onClick={handleSubmit}
            disabled={saving || !title.trim() || !password}
          >
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {isEdit ? t("editPassword") : t("newPassword")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
