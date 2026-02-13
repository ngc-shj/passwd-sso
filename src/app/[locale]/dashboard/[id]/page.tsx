"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useVault } from "@/lib/vault-context";
import { decryptData, type EncryptedData } from "@/lib/crypto-client";
import { buildPersonalEntryAAD } from "@/lib/crypto-aad";
import { PasswordDetail } from "@/components/passwords/password-detail";
import type { TOTPEntry } from "@/components/passwords/totp-field";
import { Loader2 } from "lucide-react";
import { apiPath, type CustomFieldType } from "@/lib/constants";

interface PasswordHistoryEntry {
  password: string;
  changedAt: string;
}

interface CustomField {
  label: string;
  value: string;
  type: CustomFieldType;
}

interface VaultEntryFull {
  title: string;
  username: string | null;
  password: string;
  url: string | null;
  notes: string | null;
  tags: Array<{ name: string; color: string | null }>;
  passwordHistory?: PasswordHistoryEntry[];
  customFields?: CustomField[];
  totp?: TOTPEntry;
}

interface DetailData {
  id: string;
  title: string;
  username: string | null;
  password: string;
  url: string | null;
  notes: string | null;
  tags: Array<{ name: string; color: string | null }>;
  passwordHistory: PasswordHistoryEntry[];
  customFields: CustomField[];
  totp?: TOTPEntry;
  isFavorite: boolean;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export default function PasswordDetailPage() {
  const t = useTranslations("PasswordDetail");
  const params = useParams();
  const id = params.id as string;
  const { encryptionKey, userId } = useVault();
  const [data, setData] = useState<DetailData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!encryptionKey) return;

    async function load() {
      try {
        const res = await fetch(apiPath.passwordById(id));
        if (!res.ok) throw new Error(t("notFound"));
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

        setData({
          id: raw.id,
          title: entry.title,
          username: entry.username,
          password: entry.password,
          url: entry.url,
          notes: entry.notes,
          tags: entry.tags ?? [],
          passwordHistory: entry.passwordHistory ?? [],
          customFields: entry.customFields ?? [],
          totp: entry.totp,
          isFavorite: raw.isFavorite ?? false,
          isArchived: raw.isArchived ?? false,
          createdAt: raw.createdAt,
          updatedAt: raw.updatedAt,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : t("notFound"));
      }
    }

    load();
  }, [id, t, encryptionKey]);

  if (error) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-muted-foreground">{error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <PasswordDetail data={data} />;
}
