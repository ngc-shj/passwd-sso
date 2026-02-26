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
import { useVault } from "@/lib/vault-context";
import { generateOrgSymmetricKey, createOrgKeyEscrow } from "@/lib/crypto-team";

interface TeamCreateDialogProps {
  trigger: React.ReactNode;
  onCreated: () => void;
}

export function TeamCreateDialog({ trigger, onCreated }: TeamCreateDialogProps) {
  const t = useTranslations("Team");
  const { status, userId, getEcdhPublicKeyJwk } = useVault();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [slugError, setSlugError] = useState("");

  const vaultReady = status === "unlocked" && !!userId;

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
    if (!name.trim() || !slug.trim() || !vaultReady) return;
    setSaving(true);
    setSlugError("");

    try {
      const ecdhPublicKeyJwk = getEcdhPublicKeyJwk();
      if (!ecdhPublicKeyJwk) {
        throw new Error("ECDH key not available");
      }

      // Generate team ID client-side (needed for AAD in key escrow)
      const teamId = crypto.randomUUID();

      // Generate team symmetric key and wrap it for the owner
      const orgKey = generateOrgSymmetricKey();
      let escrow;
      try {
        escrow = await createOrgKeyEscrow(
          orgKey,
          ecdhPublicKeyJwk,
          teamId,
          userId!,
          1
        );
      } finally {
        orgKey.fill(0);
      }

      const res = await fetch(API_PATH.TEAMS, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: teamId,
          name: name.trim(),
          slug: slug.trim(),
          description: description.trim() || undefined,
          orgMemberKey: {
            encryptedOrgKey: escrow.encryptedOrgKey,
            orgKeyIv: escrow.orgKeyIv,
            orgKeyAuthTag: escrow.orgKeyAuthTag,
            ephemeralPublicKey: escrow.ephemeralPublicKey,
            hkdfSalt: escrow.hkdfSalt,
            keyVersion: escrow.keyVersion,
          },
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
      <DialogContent className="sm:max-w-2xl">
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
              <Label htmlFor="team-name">{t("orgName")}</Label>
              <Input
                id="team-name"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder={t("orgNamePlaceholder")}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="team-slug">{t("slug")}</Label>
              <Input
                id="team-slug"
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
            <Label htmlFor="team-desc">{t("description")}</Label>
            <Textarea
              id="team-desc"
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
            disabled={saving || !name.trim() || !slug.trim() || !vaultReady}
          >
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {t("createButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
