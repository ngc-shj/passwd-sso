"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { TeamEntryDialogShell } from "@/components/team/forms/team-entry-dialog-shell";
import { TeamEditDialog } from "@/components/team/management/team-edit-dialog";
import type { TeamEntryFormEditData } from "@/components/team/forms/team-entry-form-types";
import type { TeamTagData } from "@/components/team/forms/team-tag-input";
import { apiPath } from "@/lib/constants";
import type { EntryCustomField, EntryTotp } from "@/lib/vault/entry-form-types";
import { buildTeamEntryAAD } from "@/lib/crypto/crypto-aad";
import { decryptData } from "@/lib/crypto/crypto-client";
import { useTeamVault } from "@/lib/team/team-vault-context";
import { fetchApi } from "@/lib/url-helpers";

interface TeamEditDialogLoaderProps {
  teamId: string;
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  defaultFolderId?: string | null;
  defaultTags?: TeamTagData[];
}

export function TeamEditDialogLoader({
  teamId,
  id,
  open,
  onOpenChange,
  onSaved,
  defaultFolderId,
  defaultTags,
}: TeamEditDialogLoaderProps) {
  const t = useTranslations("PasswordForm");
  const td = useTranslations("PasswordDetail");
  const { getEntryDecryptionKey } = useTeamVault();
  const [data, setData] = useState<TeamEntryFormEditData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setData(null);
      setError(null);
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        const res = await fetchApi(apiPath.teamPasswordById(teamId, id));
        if (!res.ok) throw new Error(td("notFound"));
        const raw = await res.json();

        const itemKeyVersion = (raw.itemKeyVersion as number) ?? 0;
        const decryptKey = await getEntryDecryptionKey(teamId, id, {
          itemKeyVersion,
          encryptedItemKey: raw.encryptedItemKey as string | undefined,
          itemKeyIv: raw.itemKeyIv as string | undefined,
          itemKeyAuthTag: raw.itemKeyAuthTag as string | undefined,
          teamKeyVersion: (raw.teamKeyVersion as number) ?? 1,
        });

        const aad = buildTeamEntryAAD(teamId, id, "blob", itemKeyVersion);
        const json = await decryptData(
          {
            ciphertext: raw.encryptedBlob as string,
            iv: raw.blobIv as string,
            authTag: raw.blobAuthTag as string,
          },
          decryptKey,
          aad,
        );
        const blob = JSON.parse(json) as Record<string, unknown>;

        if (cancelled) return;

        setData({
          id: raw.id,
          entryType: raw.entryType,
          title: (blob.title as string) ?? "",
          username: (blob.username as string) ?? null,
          password: (blob.password as string) ?? "",
          content: blob.content as string | undefined,
          url: (blob.url as string) ?? null,
          notes: (blob.notes as string) ?? null,
          tags: raw.tags,
          customFields: blob.customFields as EntryCustomField[] | undefined,
          totp: blob.totp as EntryTotp | null | undefined,
          cardholderName: blob.cardholderName as string | null | undefined,
          cardNumber: blob.cardNumber as string | null | undefined,
          brand: blob.brand as string | null | undefined,
          expiryMonth: blob.expiryMonth as string | null | undefined,
          expiryYear: blob.expiryYear as string | null | undefined,
          cvv: blob.cvv as string | null | undefined,
          fullName: blob.fullName as string | null | undefined,
          address: blob.address as string | null | undefined,
          phone: blob.phone as string | null | undefined,
          email: blob.email as string | null | undefined,
          dateOfBirth: blob.dateOfBirth as string | null | undefined,
          nationality: blob.nationality as string | null | undefined,
          idNumber: blob.idNumber as string | null | undefined,
          issueDate: blob.issueDate as string | null | undefined,
          expiryDate: blob.expiryDate as string | null | undefined,
          relyingPartyId: blob.relyingPartyId as string | null | undefined,
          relyingPartyName: blob.relyingPartyName as string | null | undefined,
          credentialId: blob.credentialId as string | null | undefined,
          creationDate: blob.creationDate as string | null | undefined,
          deviceInfo: blob.deviceInfo as string | null | undefined,
          bankName: blob.bankName as string | null | undefined,
          accountType: blob.accountType as string | null | undefined,
          accountHolderName: blob.accountHolderName as string | null | undefined,
          accountNumber: blob.accountNumber as string | null | undefined,
          routingNumber: blob.routingNumber as string | null | undefined,
          swiftBic: blob.swiftBic as string | null | undefined,
          iban: blob.iban as string | null | undefined,
          branchName: blob.branchName as string | null | undefined,
          softwareName: blob.softwareName as string | null | undefined,
          licenseKey: blob.licenseKey as string | null | undefined,
          version: blob.version as string | null | undefined,
          licensee: blob.licensee as string | null | undefined,
          purchaseDate: blob.purchaseDate as string | null | undefined,
          expirationDate: blob.expirationDate as string | null | undefined,
          privateKey: blob.privateKey as string | null | undefined,
          publicKey: blob.publicKey as string | null | undefined,
          keyType: blob.keyType as string | null | undefined,
          keySize: blob.keySize as number | null | undefined,
          fingerprint: blob.fingerprint as string | null | undefined,
          passphrase: blob.passphrase as string | null | undefined,
          sshComment: blob.comment as string | null | undefined,
          teamFolderId: (raw.teamFolderId as string) ?? null,
          requireReprompt: raw.requireReprompt ?? false,
          travelSafe: (blob.travelSafe as boolean | undefined) ?? true,
          expiresAt: raw.expiresAt ?? null,
          itemKeyVersion: raw.itemKeyVersion as number | undefined,
          teamKeyVersion: raw.teamKeyVersion as number | undefined,
          encryptedItemKey: raw.encryptedItemKey as string | undefined,
          itemKeyIv: raw.itemKeyIv as string | undefined,
          itemKeyAuthTag: raw.itemKeyAuthTag as string | undefined,
        });
        setError(null);
      } catch (e) {
        if (!cancelled) {
          setData(null);
          setError(e instanceof Error ? e.message : td("notFound"));
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [getEntryDecryptionKey, id, open, td, teamId]);

  if (!data) {
    return (
      <TeamEntryDialogShell open={open} onOpenChange={onOpenChange} title={t("editPassword")}>
        {error ? (
          <p className="py-8 text-center text-muted-foreground">{error}</p>
        ) : (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}
      </TeamEntryDialogShell>
    );
  }

  return (
    <TeamEditDialog
      teamId={teamId}
      open={open}
      onOpenChange={onOpenChange}
      onSaved={onSaved}
      editData={data}
      defaultFolderId={defaultFolderId}
      defaultTags={defaultTags}
    />
  );
}
