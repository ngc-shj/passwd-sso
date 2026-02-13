"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useVault } from "@/lib/vault-context";
import { decryptData, type EncryptedData } from "@/lib/crypto-client";
import { buildPersonalEntryAAD } from "@/lib/crypto-aad";
import {
  PasswordForm,
  type PasswordHistoryEntry,
  type CustomField,
  type TOTPEntry,
} from "@/components/passwords/password-form";
import type { TagData } from "@/components/tags/tag-input";
import type { GeneratorSettings } from "@/lib/generator-prefs";
import { Loader2 } from "lucide-react";
import { apiPath, API_PATH } from "@/lib/constants";

interface VaultEntryFull {
  title: string;
  username: string | null;
  password: string;
  url: string | null;
  notes: string | null;
  tags: Array<{ name: string; color: string | null }>;
  generatorSettings?: GeneratorSettings;
  passwordHistory?: PasswordHistoryEntry[];
  customFields?: CustomField[];
  totp?: TOTPEntry;
}

interface FormData {
  id: string;
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  tags: TagData[];
  generatorSettings?: GeneratorSettings;
  passwordHistory?: PasswordHistoryEntry[];
  customFields?: CustomField[];
  totp?: TOTPEntry;
}

export default function EditPasswordPage() {
  const t = useTranslations("PasswordDetail");
  const params = useParams();
  const id = params.id as string;
  const { encryptionKey, userId } = useVault();
  const [data, setData] = useState<FormData | null>(null);
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

        // Fetch user's tags to resolve IDs from tagIds
        const tagsRes = await fetch(API_PATH.TAGS);
        const allTags: TagData[] = tagsRes.ok ? await tagsRes.json() : [];
        const tagIdsSet = new Set<string>(raw.tagIds ?? []);
        const resolvedTags = allTags.filter((t) => tagIdsSet.has(t.id));

        setData({
          id: raw.id,
          title: entry.title,
          username: entry.username ?? "",
          password: entry.password,
          url: entry.url ?? "",
          notes: entry.notes ?? "",
          tags: resolvedTags,
          generatorSettings: entry.generatorSettings,
          passwordHistory: entry.passwordHistory,
          customFields: entry.customFields,
          totp: entry.totp,
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

  return <PasswordForm mode="edit" initialData={data} />;
}
