"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { RotateCcw, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  generateTeamSymmetricKey,
  createTeamKeyEscrow,
  encryptTeamEntry,
  decryptTeamEntry,
  wrapItemKey,
  unwrapItemKey,
  deriveTeamEncryptionKey,
} from "@/lib/crypto/crypto-team";
import { buildTeamEntryAAD, buildItemKeyWrapAAD } from "@/lib/crypto/crypto-aad";
import { fetchApi } from "@/lib/url-helpers";
import { apiPath } from "@/lib/constants";
import { useTeamVault } from "@/lib/team/team-vault-core";

// ─── Types ────────────────────────────────────────────────────

interface RotateKeyDataEntry {
  id: string;
  encryptedBlob: string;
  blobIv: string;
  blobAuthTag: string;
  encryptedOverview: string;
  overviewIv: string;
  overviewAuthTag: string;
  teamKeyVersion: number;
  itemKeyVersion: number;
  encryptedItemKey: string | null;
  itemKeyIv: string | null;
  itemKeyAuthTag: string | null;
  aadVersion: number;
}

interface RotateKeyDataMember {
  userId: string;
  ecdhPublicKey: string;
}

interface RotateKeyData {
  teamKeyVersion: number;
  entries: RotateKeyDataEntry[];
  members: RotateKeyDataMember[];
}

interface TeamRotateKeyButtonProps {
  teamId: string;
  onSuccess?: () => void;
}

// ─── Progress tracking ────────────────────────────────────────

type RotatePhase = "idle" | "fetching" | "encrypting" | "submitting";

function describeProgress(phase: RotatePhase, current: number, total: number): string {
  switch (phase) {
    case "fetching":
      return "...";
    case "encrypting":
      return total > 0 ? `${current}/${total}` : "...";
    case "submitting":
      return "...";
    default:
      return "";
  }
}

// ─── Component ───────────────────────────────────────────────

export function TeamRotateKeyButton({ teamId, onSuccess }: TeamRotateKeyButtonProps) {
  const t = useTranslations("Teams");
  const { getTeamKeyInfo, invalidateTeamKey } = useTeamVault();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<RotatePhase>("idle");
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [confirmInput, setConfirmInput] = useState("");

  const handleRotate = async () => {
    setLoading(true);
    setPhase("fetching");

    try {
      // 1. Get current team key info (to unwrap old entry data)
      const teamKeyInfo = await getTeamKeyInfo(teamId);
      if (!teamKeyInfo) {
        toast.error(t("rotateKeyVaultRequired"));
        return;
      }

      // 2. Fetch all entries + member public keys
      const dataRes = await fetchApi(apiPath.teamRotateKeyData(teamId));
      if (!dataRes.ok) {
        if (dataRes.status === 429) {
          toast.error(t("rotateKeyRateLimited"));
        } else {
          toast.error(t("rotateKeyFetchFailed"));
        }
        return;
      }
      const data: RotateKeyData = await dataRes.json();

      if (data.members.length === 0) {
        toast.error(t("rotateKeyNoMembers"));
        return;
      }

      const currentTeamKey = teamKeyInfo.key;
      const currentTeamKeyVersion = data.teamKeyVersion;
      const newTeamKeyVersion = currentTeamKeyVersion + 1;

      // 3. Generate new team symmetric key
      const newTeamKeyBytes = generateTeamSymmetricKey();
      const newTeamEncryptionKey = await deriveTeamEncryptionKey(newTeamKeyBytes);

      // 4. Re-encrypt entries
      setPhase("encrypting");
      setProgress({ current: 0, total: data.entries.length });

      const reencryptedEntries = [];

      for (let i = 0; i < data.entries.length; i++) {
        const entry = data.entries[i];
        setProgress({ current: i, total: data.entries.length });

        if (entry.itemKeyVersion >= 1 && entry.encryptedItemKey && entry.itemKeyIv && entry.itemKeyAuthTag) {
          // v1+: unwrap ItemKey with old TeamKey, re-wrap with new TeamKey
          const oldItemKeyAad = buildItemKeyWrapAAD(teamId, entry.id, entry.teamKeyVersion);
          const rawItemKey = await unwrapItemKey(
            {
              ciphertext: entry.encryptedItemKey,
              iv: entry.itemKeyIv,
              authTag: entry.itemKeyAuthTag,
            },
            currentTeamKey,
            oldItemKeyAad,
          );

          const newItemKeyAad = buildItemKeyWrapAAD(teamId, entry.id, newTeamKeyVersion);
          const newEncryptedItemKey = await wrapItemKey(rawItemKey, newTeamEncryptionKey, newItemKeyAad);
          rawItemKey.fill(0);

          reencryptedEntries.push({
            id: entry.id,
            itemKeyVersion: entry.itemKeyVersion,
            encryptedItemKey: newEncryptedItemKey,
            aadVersion: entry.aadVersion,
          });
        } else {
          // v0: decrypt blob+overview with old TeamKey, re-encrypt with new TeamKey
          const oldBlobAad = buildTeamEntryAAD(teamId, entry.id, "blob", entry.itemKeyVersion);
          const oldOverviewAad = buildTeamEntryAAD(teamId, entry.id, "overview", entry.itemKeyVersion);

          const decryptedBlob = await decryptTeamEntry(
            {
              ciphertext: entry.encryptedBlob,
              iv: entry.blobIv,
              authTag: entry.blobAuthTag,
            },
            currentTeamKey,
            oldBlobAad,
          );

          const decryptedOverview = await decryptTeamEntry(
            {
              ciphertext: entry.encryptedOverview,
              iv: entry.overviewIv,
              authTag: entry.overviewAuthTag,
            },
            currentTeamKey,
            oldOverviewAad,
          );

          // Re-encrypt with new key; aadVersion bumped to 1 (uses team entry AAD)
          const newAadVersion = 1;
          const newBlobAad = buildTeamEntryAAD(teamId, entry.id, "blob", 0);
          const newOverviewAad = buildTeamEntryAAD(teamId, entry.id, "overview", 0);

          const newBlob = await encryptTeamEntry(decryptedBlob, newTeamEncryptionKey, newBlobAad);
          const newOverview = await encryptTeamEntry(decryptedOverview, newTeamEncryptionKey, newOverviewAad);

          reencryptedEntries.push({
            id: entry.id,
            itemKeyVersion: 0,
            encryptedBlob: newBlob,
            encryptedOverview: newOverview,
            aadVersion: newAadVersion,
          });
        }
      }

      setProgress({ current: data.entries.length, total: data.entries.length });

      // 5. Re-wrap new TeamKey for each active member
      const memberKeys = await Promise.all(
        data.members.map(async (member) => {
          const escrow = await createTeamKeyEscrow(
            newTeamKeyBytes,
            member.ecdhPublicKey,
            teamId,
            member.userId,
            newTeamKeyVersion,
          );
          return {
            userId: member.userId,
            encryptedTeamKey: escrow.encryptedTeamKey,
            teamKeyIv: escrow.teamKeyIv,
            teamKeyAuthTag: escrow.teamKeyAuthTag,
            ephemeralPublicKey: escrow.ephemeralPublicKey,
            hkdfSalt: escrow.hkdfSalt,
            keyVersion: newTeamKeyVersion,
            wrapVersion: escrow.wrapVersion,
          };
        }),
      );

      // Zero-clear raw team key bytes
      newTeamKeyBytes.fill(0);

      // 6. POST rotation to server
      setPhase("submitting");

      const res = await fetchApi(apiPath.teamRotateKey(teamId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newTeamKeyVersion,
          entries: reencryptedEntries,
          memberKeys,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (res.status === 409) {
          toast.error(t("rotateKeyVersionConflict"));
        } else if (body?.error === "ENTRY_COUNT_MISMATCH") {
          toast.error(t("rotateKeyEntryMismatch"));
        } else {
          toast.error(t("rotateKeyFailed"));
        }
        return;
      }

      // 7. Invalidate cached team key so next access fetches the new one
      invalidateTeamKey(teamId);

      toast.success(t("rotateKeySuccess"));
      setOpen(false);
      setConfirmInput("");
      onSuccess?.();
    } catch (e) {
      console.error("[TeamRotateKeyButton] rotation failed:", e instanceof Error ? e.message : "unknown error");
      toast.error(t("rotateKeyFailed"));
    } finally {
      setLoading(false);
      setPhase("idle");
      setProgress({ current: 0, total: 0 });
    }
  };

  const progressLabel = describeProgress(phase, progress.current, progress.total);

  return (
    <AlertDialog open={open} onOpenChange={(v) => { if (!loading) { setOpen(v); if (!v) setConfirmInput(""); } }}>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm">
          <RotateCcw className="h-4 w-4 mr-2" />
          {t("rotateKeyButton")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("rotateKeyTitle")}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>{t("rotateKeyDescription")}</p>
              <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
                <li>{t("rotateKeyWarning1")}</li>
                <li>{t("rotateKeyWarning2")}</li>
                <li>{t("rotateKeyWarning3")}</li>
              </ul>
              <div className="space-y-1 pt-2">
                <p className="text-sm font-medium">{t("rotateKeyTypePrompt")}</p>
                <Input
                  value={confirmInput}
                  onChange={(e) => setConfirmInput(e.target.value)}
                  placeholder={t("rotateKeyTypePlaceholder")}
                  disabled={loading}
                  autoComplete="off"
                />
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>{t("rotateKeyCancel")}</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={handleRotate}
            disabled={loading || confirmInput !== "rotate"}
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {phase === "encrypting" && progressLabel
                  ? t("rotateKeyProgressEncrypting", { progress: progressLabel })
                  : t("rotateKeyInProgress")}
              </>
            ) : (
              t("rotateKeyConfirm")
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
