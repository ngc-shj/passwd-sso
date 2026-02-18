"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useVault } from "@/lib/vault-context";
import { decryptData, type EncryptedData } from "@/lib/crypto-client";
import { buildPersonalEntryAAD } from "@/lib/crypto-aad";
import { PasswordForm } from "./password-form";
import type {
  EntryCustomField,
  EntryPasswordHistory,
  EntryTotp,
} from "@/lib/entry-form-types";
import { SecureNoteForm } from "./secure-note-form";
import { CreditCardForm } from "./credit-card-form";
import { IdentityForm } from "./identity-form";
import { PasskeyForm } from "./passkey-form";
import { AttachmentSection, type AttachmentMeta } from "./attachment-section";
import type { TagData } from "@/components/tags/tag-input";
import type { GeneratorSettings } from "@/lib/generator-prefs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import { ENTRY_TYPE, apiPath, API_PATH } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";

interface VaultEntryFull {
  title: string;
  username?: string | null;
  password?: string;
  content?: string;
  url?: string | null;
  notes?: string | null;
  tags: Array<{ name: string; color: string | null }>;
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
}

interface FormData {
  id: string;
  entryType: EntryTypeValue;
  title: string;
  username: string;
  password: string;
  content: string;
  url: string;
  notes: string;
  tags: TagData[];
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
  requireReprompt?: boolean;
  folderId?: string | null;
}

interface PasswordEditDialogProps {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function PasswordEditDialog({
  id,
  open,
  onOpenChange,
  onSaved,
}: PasswordEditDialogProps) {
  const t = useTranslations("PasswordForm");
  const tn = useTranslations("SecureNoteForm");
  const tcc = useTranslations("CreditCardForm");
  const ti = useTranslations("IdentityForm");
  const tpk = useTranslations("PasskeyForm");
  const td = useTranslations("PasswordDetail");
  const { encryptionKey, userId } = useVault();
  const [data, setData] = useState<FormData | null>(null);
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
        const res = await fetch(apiPath.passwordById(id));
        if (!res.ok) throw new Error(td("notFound"));
        const raw = await res.json();

        const aad = raw.aadVersion >= 1 && userId
          ? buildPersonalEntryAAD(userId, id)
          : undefined;
        const plaintext = await decryptData(
          raw.encryptedBlob as EncryptedData,
          encryptionKey!,
          aad
        );
        const entry: VaultEntryFull = JSON.parse(plaintext);

        const [tagsRes, attachRes] = await Promise.all([
          fetch(API_PATH.TAGS),
          fetch(apiPath.passwordAttachments(id)),
        ]);
        const allTags: TagData[] = tagsRes.ok ? await tagsRes.json() : [];
        const tagIdsSet = new Set<string>(raw.tagIds ?? []);
        const resolvedTags = allTags.filter((t) => tagIdsSet.has(t.id));
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
          requireReprompt: raw.requireReprompt ?? false,
          folderId: raw.folderId ?? null,
        });
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : td("notFound"));
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [open, id, encryptionKey, td, userId]);

  const handleSaved = () => {
    onOpenChange(false);
    onSaved();
  };

  const isNote = data?.entryType === ENTRY_TYPE.SECURE_NOTE;
  const isCreditCard = data?.entryType === ENTRY_TYPE.CREDIT_CARD;
  const isIdentity = data?.entryType === ENTRY_TYPE.IDENTITY;
  const isPasskey = data?.entryType === ENTRY_TYPE.PASSKEY;

  const dialogTitle = isPasskey
    ? tpk("editPasskey")
    : isIdentity
      ? ti("editIdentity")
      : isCreditCard
      ? tcc("editCard")
      : isNote
        ? tn("editNote")
        : t("editPassword");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
        </DialogHeader>
        {error ? (
          <p className="text-muted-foreground text-center py-8">{error}</p>
        ) : !data ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : isPasskey ? (
          <PasskeyForm
            mode="edit"
            variant="dialog"
            initialData={{
              id: data.id,
              title: data.title,
              relyingPartyId: data.relyingPartyId ?? null,
              relyingPartyName: data.relyingPartyName ?? null,
              username: data.username || null,
              credentialId: data.credentialId ?? null,
              creationDate: data.creationDate ?? null,
              deviceInfo: data.deviceInfo ?? null,
              notes: data.notes || null,
              tags: data.tags,
            }}
            onSaved={handleSaved}
          />
        ) : isIdentity ? (
          <IdentityForm
            mode="edit"
            variant="dialog"
            initialData={{
              id: data.id,
              title: data.title,
              fullName: data.fullName ?? null,
              address: data.address ?? null,
              phone: data.phone ?? null,
              email: data.email ?? null,
              dateOfBirth: data.dateOfBirth ?? null,
              nationality: data.nationality ?? null,
              idNumber: data.idNumber ?? null,
              issueDate: data.issueDate ?? null,
              expiryDate: data.expiryDate ?? null,
              notes: data.notes,
              tags: data.tags,
            }}
            onSaved={handleSaved}
          />
        ) : isCreditCard ? (
          <CreditCardForm
            mode="edit"
            variant="dialog"
            initialData={{
              id: data.id,
              title: data.title,
              cardholderName: data.cardholderName ?? null,
              cardNumber: data.cardNumber ?? null,
              brand: data.brand ?? null,
              expiryMonth: data.expiryMonth ?? null,
              expiryYear: data.expiryYear ?? null,
              cvv: data.cvv ?? null,
              notes: data.notes,
              tags: data.tags,
            }}
            onSaved={handleSaved}
          />
        ) : isNote ? (
          <SecureNoteForm
            mode="edit"
            variant="dialog"
            initialData={{
              id: data.id,
              title: data.title,
              content: data.content,
              tags: data.tags,
            }}
            onSaved={handleSaved}
          />
        ) : (
          <PasswordForm
            mode="edit"
            variant="dialog"
            initialData={data}
            onSaved={handleSaved}
          />
        )}
        {data && (
          <div className="border-t pt-4 mt-2">
            <AttachmentSection
              entryId={id}
              attachments={attachments}
              onAttachmentsChange={setAttachments}
              keyVersion={undefined}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
