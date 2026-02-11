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
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TagInput, type TagData } from "@/components/tags/tag-input";
import { Loader2, ArrowLeft, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";

interface PasskeyFormProps {
  mode: "create" | "edit";
  initialData?: {
    id: string;
    title: string;
    relyingPartyId: string | null;
    relyingPartyName: string | null;
    username: string | null;
    credentialId: string | null;
    creationDate: string | null;
    deviceInfo: string | null;
    notes: string | null;
    tags: TagData[];
  };
  variant?: "page" | "dialog";
  onSaved?: () => void;
}

export function PasskeyForm({ mode, initialData, variant = "page", onSaved }: PasskeyFormProps) {
  const t = useTranslations("PasskeyForm");
  const tc = useTranslations("Common");
  const router = useRouter();
  const { encryptionKey, userId } = useVault();
  const [submitting, setSubmitting] = useState(false);
  const [showCredentialId, setShowCredentialId] = useState(false);

  const [title, setTitle] = useState(initialData?.title ?? "");
  const [relyingPartyId, setRelyingPartyId] = useState(initialData?.relyingPartyId ?? "");
  const [relyingPartyName, setRelyingPartyName] = useState(initialData?.relyingPartyName ?? "");
  const [username, setUsername] = useState(initialData?.username ?? "");
  const [credentialId, setCredentialId] = useState(initialData?.credentialId ?? "");
  const [creationDate, setCreationDate] = useState(initialData?.creationDate ?? "");
  const [deviceInfo, setDeviceInfo] = useState(initialData?.deviceInfo ?? "");
  const [notes, setNotes] = useState(initialData?.notes ?? "");
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

      const fullBlob = JSON.stringify({
        title,
        relyingPartyId: relyingPartyId || null,
        relyingPartyName: relyingPartyName || null,
        username: username || null,
        credentialId: credentialId || null,
        creationDate: creationDate || null,
        deviceInfo: deviceInfo || null,
        notes: notes || null,
        tags,
      });

      const overviewBlob = JSON.stringify({
        title,
        relyingPartyId: relyingPartyId || null,
        username: username || null,
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
        entryType: "PASSKEY",
      };

      const endpoint =
        mode === "create"
          ? "/api/passwords"
          : `/api/passwords/${initialData!.id}`;
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
        <Label htmlFor="relyingPartyId">{t("relyingPartyId")}</Label>
        <Input
          id="relyingPartyId"
          value={relyingPartyId}
          onChange={(e) => setRelyingPartyId(e.target.value)}
          placeholder={t("relyingPartyIdPlaceholder")}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="relyingPartyName">{t("relyingPartyName")}</Label>
        <Input
          id="relyingPartyName"
          value={relyingPartyName}
          onChange={(e) => setRelyingPartyName(e.target.value)}
          placeholder={t("relyingPartyNamePlaceholder")}
          autoComplete="off"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="username">{t("username")}</Label>
        <Input
          id="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={t("usernamePlaceholder")}
          autoComplete="off"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="credentialId">{t("credentialId")}</Label>
        <div className="relative">
          <Input
            id="credentialId"
            type={showCredentialId ? "text" : "password"}
            value={credentialId}
            onChange={(e) => setCredentialId(e.target.value)}
            placeholder={t("credentialIdPlaceholder")}
            className="font-mono"
            autoComplete="off"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
            onClick={() => setShowCredentialId(!showCredentialId)}
          >
            {showCredentialId ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="creationDate">{t("creationDate")}</Label>
          <Input
            id="creationDate"
            type="date"
            value={creationDate}
            onChange={(e) => setCreationDate(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="deviceInfo">{t("deviceInfo")}</Label>
          <Input
            id="deviceInfo"
            value={deviceInfo}
            onChange={(e) => setDeviceInfo(e.target.value)}
            placeholder={t("deviceInfoPlaceholder")}
            autoComplete="off"
          />
        </div>
      </div>

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
            {mode === "create" ? t("newPasskey") : t("editPasskey")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {formContent}
        </CardContent>
      </Card>
    </div>
  );
}
