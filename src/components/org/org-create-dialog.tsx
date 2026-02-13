"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Building2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { API_PATH } from "@/lib/constants";

interface OrgCreateDialogProps {
  trigger: React.ReactNode;
  onCreated: () => void;
}

export function OrgCreateDialog({ trigger, onCreated }: OrgCreateDialogProps) {
  const t = useTranslations("Org");
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [slugError, setSlugError] = useState("");

  const reset = () => {
    setName("");
    setSlug("");
    setDescription("");
    setSlugError("");
    setSaving(false);
  };

  const handleNameChange = (value: string) => {
    setName(value);
    // Auto-generate slug from name
    const autoSlug = value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    setSlug(autoSlug);
    setSlugError("");
  };

  const handleSubmit = async () => {
    if (!name.trim() || !slug.trim()) return;
    setSaving(true);
    setSlugError("");

    try {
      const res = await fetch(API_PATH.ORGS, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          slug: slug.trim(),
          description: description.trim() || undefined,
        }),
      });

      if (res.status === 409) {
        setSlugError(t("slugTaken"));
        setSaving(false);
        return;
      }

      if (!res.ok) {
        throw new Error("Failed to create");
      }

      toast.success(t("created"));
      setOpen(false);
      reset();
      onCreated();
    } catch {
      toast.error(t("createFailed"));
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="h-4 w-4" />
            {t("createOrg")}
          </DialogTitle>
          <DialogDescription>{t("createOrgDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="org-name">{t("orgName")}</Label>
              <Input
                id="org-name"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder={t("orgNamePlaceholder")}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="org-slug">{t("slug")}</Label>
              <Input
                id="org-slug"
                value={slug}
                onChange={(e) => {
                  setSlug(e.target.value);
                  setSlugError("");
                }}
                placeholder={t("slugPlaceholder")}
              />
              <p className="text-xs text-muted-foreground">{t("slugHelp")}</p>
              {slugError && (
                <p className="text-sm text-destructive">{slugError}</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="org-desc">{t("description")}</Label>
            <Textarea
              id="org-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("descriptionPlaceholder")}
              rows={3}
            />
          </div>
        </div>

        <DialogFooter className="border-t pt-4">
          <Button
            onClick={handleSubmit}
            disabled={saving || !name.trim() || !slug.trim()}
          >
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {t("createButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
