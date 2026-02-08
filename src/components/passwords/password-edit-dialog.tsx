"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useVault } from "@/lib/vault-context";
import { decryptData, type EncryptedData } from "@/lib/crypto-client";
import {
  PasswordForm,
  type PasswordHistoryEntry,
  type CustomField,
  type TOTPEntry,
} from "./password-form";
import type { TagData } from "@/components/tags/tag-input";
import type { GeneratorSettings } from "@/lib/generator-prefs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";

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
  const td = useTranslations("PasswordDetail");
  const { encryptionKey } = useVault();
  const [data, setData] = useState<FormData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !encryptionKey) {
      setData(null);
      setError(null);
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/passwords/${id}`);
        if (!res.ok) throw new Error(td("notFound"));
        const raw = await res.json();

        const plaintext = await decryptData(
          raw.encryptedBlob as EncryptedData,
          encryptionKey!
        );
        const entry: VaultEntryFull = JSON.parse(plaintext);

        const tagsRes = await fetch("/api/tags");
        const allTags: TagData[] = tagsRes.ok ? await tagsRes.json() : [];
        const tagIdsSet = new Set<string>(raw.tagIds ?? []);
        const resolvedTags = allTags.filter((t) => tagIdsSet.has(t.id));

        if (cancelled) return;
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
        if (!cancelled) {
          setError(e instanceof Error ? e.message : td("notFound"));
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [open, id, encryptionKey, td]);

  const handleSaved = () => {
    onOpenChange(false);
    onSaved();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("editPassword")}</DialogTitle>
        </DialogHeader>
        {error ? (
          <p className="text-muted-foreground text-center py-8">{error}</p>
        ) : !data ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <PasswordForm
            mode="edit"
            variant="dialog"
            initialData={data}
            onSaved={handleSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
