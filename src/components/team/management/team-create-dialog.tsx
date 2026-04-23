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
import { Building2, Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import { API_PATH, VAULT_STATUS } from "@/lib/constants";
import { useVault, VaultUnlockError } from "@/lib/vault/vault-context";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { preventIMESubmit } from "@/lib/ui/ime-guard";
import { formatLockedUntil } from "@/components/vault/vault-lock-screen";
import { generateTeamSymmetricKey, createTeamKeyEscrow } from "@/lib/crypto/crypto-team";
import { fetchApi } from "@/lib/url-helpers";
import { slugRegex, SLUG_MIN_LENGTH, SLUG_MAX_LENGTH, NAME_MAX_LENGTH, DESCRIPTION_MAX_LENGTH } from "@/lib/validations";

interface TeamCreateDialogProps {
  trigger: React.ReactNode;
  onCreated: () => void;
}

export function TeamCreateDialog({ trigger, onCreated }: TeamCreateDialogProps) {
  const t = useTranslations("Team");
  const tVault = useTranslations("Vault");
  const { status, userId, unlock, getEcdhPublicKeyJwk } = useVault();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [slugError, setSlugError] = useState("");

  // Inline vault unlock state
  const [passphrase, setPassphrase] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState("");

  const isLoading = status === VAULT_STATUS.LOADING;
  const needsSetup = status === VAULT_STATUS.SETUP_REQUIRED;
  const vaultReady = status === VAULT_STATUS.UNLOCKED && !!userId;

  const reset = () => {
    setName("");
    setSlug("");
    setDescription("");
    setSlugError("");
    setSaving(false);
    setPassphrase("");
    setUnlocking(false);
    setUnlockError("");
  };

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passphrase) return;
    setUnlocking(true);
    setUnlockError("");
    try {
      const success = await unlock(passphrase);
      if (!success) {
        setUnlockError(tVault("wrongPassphrase"));
        setPassphrase("");
      }
    } catch (err) {
      if (err instanceof VaultUnlockError) {
        switch (err.code) {
          case API_ERROR.UNAUTHORIZED:
            setOpen(false);
            toast.error(tVault("sessionExpired"));
            break;
          case API_ERROR.ACCOUNT_LOCKED:
            setUnlockError(formatLockedUntil(err.lockedUntil, tVault));
            break;
          case API_ERROR.RATE_LIMIT_EXCEEDED:
            setUnlockError(tVault("rateLimited"));
            break;
          case API_ERROR.SERVICE_UNAVAILABLE:
            setUnlockError(tVault("retryLater"));
            break;
          default:
            setUnlockError(tVault("unlockError"));
        }
      } else {
        setUnlockError(tVault("unlockError"));
      }
      setPassphrase("");
    } finally {
      setUnlocking(false);
    }
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

  const validateSlug = (value: string): string | null => {
    const trimmed = value.trim();
    if (trimmed.length < SLUG_MIN_LENGTH) return t("slugTooShort");
    if (trimmed.length > SLUG_MAX_LENGTH) return t("slugTooLong");
    if (!slugRegex.test(trimmed)) return t("slugInvalidFormat");
    return null;
  };

  const handleSubmit = async () => {
    if (!name.trim() || !slug.trim() || !vaultReady) return;

    const slugValidationError = validateSlug(slug);
    if (slugValidationError) {
      setSlugError(slugValidationError);
      return;
    }

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
      const teamKey = generateTeamSymmetricKey();
      let escrow;
      try {
        escrow = await createTeamKeyEscrow(
          teamKey,
          ecdhPublicKeyJwk,
          teamId,
          userId!,
          1
        );
      } finally {
        teamKey.fill(0);
      }

      const res = await fetchApi(API_PATH.TEAMS, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: teamId,
          name: name.trim(),
          slug: slug.trim(),
          description: description.trim() || undefined,
          teamMemberKey: {
            encryptedTeamKey: escrow.encryptedTeamKey,
            teamKeyIv: escrow.teamKeyIv,
            teamKeyAuthTag: escrow.teamKeyAuthTag,
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

      if (res.status === 400) {
        const data = await res.json().catch(() => null);
        if (data?.details?.properties?.slug?.errors?.length) {
          setSlugError(t("slugInvalidFormat"));
        } else {
          toast.error(t("validationError"));
        }
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
            {t("createTeam")}
          </DialogTitle>
          <DialogDescription>{t("createTeamDescription")}</DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : needsSetup ? (
          <div className="space-y-4 rounded-lg border bg-muted/20 p-6">
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                <Lock className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground">{tVault("setupDescription")}</p>
            </div>
          </div>
        ) : !vaultReady ? (
          <div className="space-y-4 rounded-lg border bg-muted/20 p-6">
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                <Lock className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground">{tVault("lockedDescription")}</p>
            </div>
            <form onSubmit={handleUnlock} onKeyDown={preventIMESubmit} className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="unlock-passphrase">{tVault("passphrase")}</Label>
                <Input
                  id="unlock-passphrase"
                  type="password"
                  value={passphrase}
                  onChange={(e) => { setPassphrase(e.target.value); setUnlockError(""); }}
                  placeholder={tVault("enterPassphrase")}
                  autoComplete="current-password"
                  autoFocus
                />
              </div>
              {unlockError && (
                <p className="text-sm text-destructive text-center">{unlockError}</p>
              )}
              <Button type="submit" className="w-full" disabled={!passphrase || unlocking}>
                {unlocking && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {tVault("unlock")}
              </Button>
            </form>
          </div>
        ) : (
          <>
            <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="team-name">{t("teamName")}</Label>
                  <Input
                    id="team-name"
                    value={name}
                    onChange={(e) => handleNameChange(e.target.value)}
                    placeholder={t("teamNamePlaceholder")}
                    maxLength={NAME_MAX_LENGTH}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="team-slug">{t("slug")}</Label>
                  <Input
                    id="team-slug"
                    value={slug}
                    onChange={(e) => {
                      const normalized = e.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9-]/g, "");
                      setSlug(normalized);
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
                  maxLength={DESCRIPTION_MAX_LENGTH}
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
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
