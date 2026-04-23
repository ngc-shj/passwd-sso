"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useVault } from "@/lib/vault/vault-context";
import { decryptData, type EncryptedData } from "@/lib/crypto/crypto-client";
import { buildPersonalEntryAAD } from "@/lib/crypto/crypto-aad";
import type { AttachmentMeta } from "./attachment-section";
import { PasswordEditDialog } from "./personal-password-edit-dialog";
import type { PersonalPasswordEditData } from "./personal-password-edit-dialog-types";
import type {
  EntryCustomField,
  EntryPasswordHistory,
  EntryTagNameColor,
  EntryTotp,
} from "@/lib/vault/entry-form-types";
import type { GeneratorSettings } from "@/lib/generator-prefs";
import type { TagData } from "@/components/tags/tag-input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import { API_PATH, ENTRY_TYPE, apiPath } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";

interface PasswordEditDialogLoaderProps {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

interface VaultEntryFull {
  title: string;
  username?: string | null;
  password?: string;
  content?: string;
  url?: string | null;
  notes?: string | null;
  tags: EntryTagNameColor[];
  generatorSettings?: GeneratorSettings;
  passwordHistory?: EntryPasswordHistory[];
  customFields?: EntryCustomField[];
  totp?: EntryTotp;
  cardholderName?: string | null;
  cardNumber?: string | null;
  brand?: string | null;
  expiryMonth?: string | null;
  expiryYear?: string | null;
  cvv?: string | null;
  fullName?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  dateOfBirth?: string | null;
  nationality?: string | null;
  idNumber?: string | null;
  issueDate?: string | null;
  expiryDate?: string | null;
  relyingPartyId?: string | null;
  relyingPartyName?: string | null;
  credentialId?: string | null;
  creationDate?: string | null;
  deviceInfo?: string | null;
  passkeyPrivateKeyJwk?: string | null;
  passkeyPublicKeyCose?: string | null;
  passkeyUserHandle?: string | null;
  passkeyUserDisplayName?: string | null;
  passkeySignCount?: number | null;
  passkeyAlgorithm?: number | null;
  passkeyTransports?: string[] | null;
  bankName?: string | null;
  accountType?: string | null;
  accountHolderName?: string | null;
  accountNumber?: string | null;
  routingNumber?: string | null;
  swiftBic?: string | null;
  iban?: string | null;
  branchName?: string | null;
  softwareName?: string | null;
  licenseKey?: string | null;
  version?: string | null;
  licensee?: string | null;
  purchaseDate?: string | null;
  expirationDate?: string | null;
  privateKey?: string | null;
  publicKey?: string | null;
  keyType?: string | null;
  keySize?: number | null;
  fingerprint?: string | null;
  passphrase?: string | null;
  comment?: string | null;
  travelSafe?: boolean;
}

export function PasswordEditDialogLoader({
  id,
  open,
  onOpenChange,
  onSaved,
}: PasswordEditDialogLoaderProps) {
  const t = useTranslations("PasswordForm");
  const td = useTranslations("PasswordDetail");
  const { encryptionKey, userId } = useVault();
  const [data, setData] = useState<PersonalPasswordEditData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<AttachmentMeta[]>([]);

  useEffect(() => {
    if (!open || !encryptionKey) {
      setData(null);
      setError(null);
      setAttachments([]);
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        const res = await fetchApi(apiPath.passwordById(id));
        if (!res.ok) throw new Error(td("notFound"));
        const raw = await res.json();

        const aad = raw.aadVersion >= 1 && userId
          ? buildPersonalEntryAAD(userId, id)
          : undefined;
        const plaintext = await decryptData(
          raw.encryptedBlob as EncryptedData,
          encryptionKey!,
          aad,
        );
        const entry: VaultEntryFull = JSON.parse(plaintext);

        const [tagsRes, attachRes] = await Promise.all([
          fetchApi(API_PATH.TAGS),
          fetchApi(apiPath.passwordAttachments(id)),
        ]);
        const allTags: TagData[] = tagsRes.ok ? await tagsRes.json() : [];
        const tagIdsSet = new Set<string>(raw.tagIds ?? []);
        const resolvedTags = allTags.filter((tag) => tagIdsSet.has(tag.id));

        if (attachRes.ok && !cancelled) {
          setAttachments(await attachRes.json());
        }

        if (cancelled) return;

        setData({
          id: raw.id,
          entryType: raw.entryType ?? ENTRY_TYPE.LOGIN,
          title: entry.title,
          username: entry.username ?? "",
          password: entry.password ?? "",
          content: entry.content ?? "",
          url: entry.url ?? "",
          notes: entry.notes ?? "",
          tags: resolvedTags,
          generatorSettings: entry.generatorSettings,
          passwordHistory: entry.passwordHistory,
          customFields: entry.customFields,
          totp: entry.totp,
          cardholderName: entry.cardholderName,
          cardNumber: entry.cardNumber,
          brand: entry.brand,
          expiryMonth: entry.expiryMonth,
          expiryYear: entry.expiryYear,
          cvv: entry.cvv,
          fullName: entry.fullName,
          address: entry.address,
          phone: entry.phone,
          email: entry.email,
          dateOfBirth: entry.dateOfBirth,
          nationality: entry.nationality,
          idNumber: entry.idNumber,
          issueDate: entry.issueDate,
          expiryDate: entry.expiryDate,
          relyingPartyId: entry.relyingPartyId,
          relyingPartyName: entry.relyingPartyName,
          credentialId: entry.credentialId,
          creationDate: entry.creationDate,
          deviceInfo: entry.deviceInfo,
          passkeyPrivateKeyJwk: entry.passkeyPrivateKeyJwk,
          passkeyPublicKeyCose: entry.passkeyPublicKeyCose,
          passkeyUserHandle: entry.passkeyUserHandle,
          passkeyUserDisplayName: entry.passkeyUserDisplayName,
          passkeySignCount: entry.passkeySignCount,
          passkeyAlgorithm: entry.passkeyAlgorithm,
          passkeyTransports: entry.passkeyTransports,
          bankName: entry.bankName,
          accountType: entry.accountType,
          accountHolderName: entry.accountHolderName,
          accountNumber: entry.accountNumber,
          routingNumber: entry.routingNumber,
          swiftBic: entry.swiftBic,
          iban: entry.iban,
          branchName: entry.branchName,
          softwareName: entry.softwareName,
          licenseKey: entry.licenseKey,
          version: entry.version,
          licensee: entry.licensee,
          purchaseDate: entry.purchaseDate,
          expirationDate: entry.expirationDate,
          privateKey: entry.privateKey,
          publicKey: entry.publicKey,
          keyType: entry.keyType,
          keySize: entry.keySize,
          fingerprint: entry.fingerprint,
          passphrase: entry.passphrase,
          sshComment: entry.comment,
          requireReprompt: raw.requireReprompt ?? false,
          travelSafe: entry.travelSafe ?? true,
          expiresAt: raw.expiresAt ?? null,
          folderId: raw.folderId ?? null,
        });
        setError(null);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : td("notFound"));
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [encryptionKey, id, open, td, userId]);

  if (!data) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("editPassword")}</DialogTitle>
          </DialogHeader>
          {error ? (
            <p className="py-8 text-center text-muted-foreground">{error}</p>
          ) : (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <PasswordEditDialog
      open={open}
      onOpenChange={onOpenChange}
      onSaved={onSaved}
      editData={data}
      attachments={attachments}
      onAttachmentsChange={setAttachments}
    />
  );
}
