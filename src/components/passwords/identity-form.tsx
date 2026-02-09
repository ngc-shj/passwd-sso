"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { useVault } from "@/lib/vault-context";
import { encryptData } from "@/lib/crypto-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TagInput, type TagData } from "@/components/tags/tag-input";
import { Loader2, ArrowLeft, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";

interface IdentityFormProps {
  mode: "create" | "edit";
  initialData?: {
    id: string;
    title: string;
    fullName: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
    dateOfBirth: string | null;
    nationality: string | null;
    idNumber: string | null;
    issueDate: string | null;
    expiryDate: string | null;
    notes: string | null;
    tags: TagData[];
  };
  variant?: "page" | "dialog";
  onSaved?: () => void;
}

export function IdentityForm({ mode, initialData, variant = "page", onSaved }: IdentityFormProps) {
  const t = useTranslations("IdentityForm");
  const tc = useTranslations("Common");
  const router = useRouter();
  const { encryptionKey } = useVault();
  const [submitting, setSubmitting] = useState(false);
  const [showIdNumber, setShowIdNumber] = useState(false);

  const [title, setTitle] = useState(initialData?.title ?? "");
  const [fullName, setFullName] = useState(initialData?.fullName ?? "");
  const [address, setAddress] = useState(initialData?.address ?? "");
  const [phone, setPhone] = useState(initialData?.phone ?? "");
  const [email, setEmail] = useState(initialData?.email ?? "");
  const [dateOfBirth, setDateOfBirth] = useState(initialData?.dateOfBirth ?? "");
  const [nationality, setNationality] = useState(initialData?.nationality ?? "");
  const [idNumber, setIdNumber] = useState(initialData?.idNumber ?? "");
  const [issueDate, setIssueDate] = useState(initialData?.issueDate ?? "");
  const [expiryDate, setExpiryDate] = useState(initialData?.expiryDate ?? "");
  const [notes, setNotes] = useState(initialData?.notes ?? "");
  const [dobError, setDobError] = useState<string | null>(null);
  const [expiryError, setExpiryError] = useState<string | null>(null);
  const [selectedTags, setSelectedTags] = useState<TagData[]>(
    initialData?.tags ?? []
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!encryptionKey) return;

    let hasError = false;
    if (dateOfBirth && dateOfBirth > new Date().toISOString().slice(0, 10)) {
      setDobError(t("dobFuture"));
      hasError = true;
    } else {
      setDobError(null);
    }
    if (issueDate && expiryDate && issueDate >= expiryDate) {
      setExpiryError(t("expiryBeforeIssue"));
      hasError = true;
    } else {
      setExpiryError(null);
    }
    if (hasError) return;
    setSubmitting(true);

    try {
      const tags = selectedTags.map((t) => ({
        name: t.name,
        color: t.color,
      }));

      const idNumberLast4 = idNumber ? idNumber.slice(-4) : null;

      const fullBlob = JSON.stringify({
        title,
        fullName: fullName || null,
        address: address || null,
        phone: phone || null,
        email: email || null,
        dateOfBirth: dateOfBirth || null,
        nationality: nationality || null,
        idNumber: idNumber || null,
        issueDate: issueDate || null,
        expiryDate: expiryDate || null,
        notes: notes || null,
        tags,
      });

      const overviewBlob = JSON.stringify({
        title,
        fullName: fullName || null,
        idNumberLast4,
        tags,
      });

      const encryptedBlob = await encryptData(fullBlob, encryptionKey);
      const encryptedOverview = await encryptData(overviewBlob, encryptionKey);

      const body = {
        encryptedBlob,
        encryptedOverview,
        keyVersion: 1,
        tagIds: selectedTags.map((t) => t.id),
        entryType: "IDENTITY",
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
        <Label htmlFor="fullName">{t("fullName")}</Label>
        <Input
          id="fullName"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          placeholder={t("fullNamePlaceholder")}
          autoComplete="off"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="address">{t("address")}</Label>
        <Textarea
          id="address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder={t("addressPlaceholder")}
          rows={2}
          autoComplete="off"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="phone">{t("phone")}</Label>
          <Input
            id="phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={t("phonePlaceholder")}
            autoComplete="off"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="email">{t("email")}</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("emailPlaceholder")}
            autoComplete="off"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="dateOfBirth">{t("dateOfBirth")}</Label>
          <Input
            id="dateOfBirth"
            type="date"
            value={dateOfBirth}
            onChange={(e) => {
              setDateOfBirth(e.target.value);
              setDobError(null);
            }}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="nationality">{t("nationality")}</Label>
          <Input
            id="nationality"
            value={nationality}
            onChange={(e) => setNationality(e.target.value)}
            placeholder={t("nationalityPlaceholder")}
            autoComplete="off"
          />
        </div>
      </div>
      {dobError && (
        <p className="text-sm text-destructive">{dobError}</p>
      )}

      <div className="space-y-2">
        <Label htmlFor="idNumber">{t("idNumber")}</Label>
        <div className="relative">
          <Input
            id="idNumber"
            type={showIdNumber ? "text" : "password"}
            value={idNumber}
            onChange={(e) => setIdNumber(e.target.value)}
            placeholder={t("idNumberPlaceholder")}
            autoComplete="off"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
            onClick={() => setShowIdNumber(!showIdNumber)}
          >
            {showIdNumber ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="issueDate">{t("issueDate")}</Label>
          <Input
            id="issueDate"
            type="date"
            value={issueDate}
            onChange={(e) => {
              setIssueDate(e.target.value);
              setExpiryError(null);
            }}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="expiryDate">{t("expiryDate")}</Label>
          <Input
            id="expiryDate"
            type="date"
            value={expiryDate}
            onChange={(e) => {
              setExpiryDate(e.target.value);
              setExpiryError(null);
            }}
          />
        </div>
      </div>
      {expiryError && (
        <p className="text-sm text-destructive">{expiryError}</p>
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
            {mode === "create" ? t("newIdentity") : t("editIdentity")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {formContent}
        </CardContent>
      </Card>
    </div>
  );
}
