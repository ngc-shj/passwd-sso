"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useVault } from "@/lib/vault-context";
import { decryptData, type EncryptedData } from "@/lib/crypto-client";
import { PasswordCard } from "./password-card";
import { Archive, KeyRound, Loader2, Star } from "lucide-react";

interface DecryptedOverview {
  title: string;
  username?: string | null;
  urlHost?: string | null;
  snippet?: string | null;
  brand?: string | null;
  lastFour?: string | null;
  cardholderName?: string | null;
  fullName?: string | null;
  idNumberLast4?: string | null;
  relyingPartyId?: string | null;
  tags: Array<{ name: string; color: string | null }>;
}

interface DisplayEntry {
  id: string;
  entryType: "LOGIN" | "SECURE_NOTE" | "CREDIT_CARD" | "IDENTITY" | "PASSKEY";
  title: string;
  username: string | null;
  urlHost: string | null;
  snippet: string | null;
  brand: string | null;
  lastFour: string | null;
  cardholderName: string | null;
  fullName: string | null;
  idNumberLast4: string | null;
  relyingPartyId: string | null;
  tags: Array<{ name: string; color: string | null }>;
  isFavorite: boolean;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export type SortOption = "updatedAt" | "createdAt" | "title";

interface PasswordListProps {
  searchQuery: string;
  tagId: string | null;
  entryType?: string | null;
  refreshKey: number;
  favoritesOnly?: boolean;
  archivedOnly?: boolean;
  sortBy?: SortOption;
  onDataChange?: () => void;
}

export function PasswordList({
  searchQuery,
  tagId,
  entryType,
  refreshKey,
  favoritesOnly = false,
  archivedOnly = false,
  sortBy = "updatedAt",
  onDataChange,
}: PasswordListProps) {
  const t = useTranslations("PasswordList");
  const { encryptionKey } = useVault();
  const [entries, setEntries] = useState<DisplayEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleToggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  const fetchPasswords = useCallback(async () => {
    if (!encryptionKey) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (tagId) params.set("tag", tagId);
      if (entryType) params.set("type", entryType);
      if (favoritesOnly) params.set("favorites", "true");
      if (archivedOnly) params.set("archived", "true");

      const res = await fetch(`/api/passwords?${params}`);
      if (!res.ok) return;
      const data = await res.json();

      // Decrypt overviews client-side
      const decrypted: DisplayEntry[] = [];
      for (const entry of data) {
        if (!entry.encryptedOverview) continue;
        try {
          const overview: DecryptedOverview = JSON.parse(
            await decryptData(
              entry.encryptedOverview as EncryptedData,
              encryptionKey
            )
          );

          // Client-side search filtering
          if (searchQuery) {
            const q = searchQuery.toLowerCase();
            const matches =
              overview.title.toLowerCase().includes(q) ||
              (overview.username?.toLowerCase().includes(q) ?? false) ||
              (overview.urlHost?.toLowerCase().includes(q) ?? false) ||
              (overview.snippet?.toLowerCase().includes(q) ?? false) ||
              (overview.brand?.toLowerCase().includes(q) ?? false) ||
              (overview.lastFour?.includes(q) ?? false) ||
              (overview.cardholderName?.toLowerCase().includes(q) ?? false) ||
              (overview.fullName?.toLowerCase().includes(q) ?? false) ||
              (overview.idNumberLast4?.includes(q) ?? false) ||
              (overview.relyingPartyId?.toLowerCase().includes(q) ?? false);
            if (!matches) continue;
          }

          decrypted.push({
            id: entry.id,
            entryType: entry.entryType ?? "LOGIN",
            title: overview.title,
            username: overview.username ?? null,
            urlHost: overview.urlHost ?? null,
            snippet: overview.snippet ?? null,
            brand: overview.brand ?? null,
            lastFour: overview.lastFour ?? null,
            cardholderName: overview.cardholderName ?? null,
            fullName: overview.fullName ?? null,
            idNumberLast4: overview.idNumberLast4 ?? null,
            relyingPartyId: overview.relyingPartyId ?? null,
            tags: overview.tags ?? [],
            isFavorite: entry.isFavorite ?? false,
            isArchived: entry.isArchived ?? false,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
          });
        } catch {
          // Skip entries that fail to decrypt
        }
      }

      // Client-side sorting
      decrypted.sort((a, b) => {
        // Favorites always first
        if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;

        switch (sortBy) {
          case "title":
            return a.title.localeCompare(b.title);
          case "createdAt":
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
          case "updatedAt":
          default:
            return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        }
      });

      setEntries(decrypted);
    } catch {
      // Network error
    } finally {
      setLoading(false);
    }
  }, [searchQuery, tagId, entryType, encryptionKey, favoritesOnly, archivedOnly, sortBy]);

  useEffect(() => {
    fetchPasswords();
  }, [fetchPasswords, refreshKey]);

  const handleToggleFavorite = async (id: string, current: boolean) => {
    // Optimistic update
    setEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, isFavorite: !current } : e))
    );

    try {
      const res = await fetch(`/api/passwords/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isFavorite: !current }),
      });
      if (!res.ok) {
        setEntries((prev) =>
          prev.map((e) => (e.id === id ? { ...e, isFavorite: current } : e))
        );
      }
    } catch {
      setEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, isFavorite: current } : e))
      );
    }
  };

  const handleToggleArchive = async (id: string, current: boolean) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
    try {
      const res = await fetch(`/api/passwords/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isArchived: !current }),
      });
      if (!res.ok) fetchPasswords();
    } catch {
      fetchPasswords();
    }
    onDataChange?.();
  };

  const handleDelete = async (id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
    try {
      const res = await fetch(`/api/passwords/${id}`, { method: "DELETE" });
      if (!res.ok) fetchPasswords();
    } catch {
      fetchPasswords();
    }
    onDataChange?.();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        {archivedOnly ? (
          <>
            <Archive className="h-12 w-12 text-muted-foreground/50 mb-4" />
            <p className="text-muted-foreground">{t("noArchive")}</p>
          </>
        ) : favoritesOnly ? (
          <>
            <Star className="h-12 w-12 text-muted-foreground/50 mb-4" />
            <p className="text-muted-foreground">{t("noFavorites")}</p>
          </>
        ) : (
          <>
            <KeyRound className="h-12 w-12 text-muted-foreground/50 mb-4" />
            <p className="text-muted-foreground">
              {searchQuery ? t("noMatch") : t("noPasswords")}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              {t("addFirst")}
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {entries.map((entry) => (
        <PasswordCard
          key={entry.id}
          id={entry.id}
          entryType={entry.entryType}
          title={entry.title}
          username={entry.username}
          urlHost={entry.urlHost}
          snippet={entry.snippet}
          brand={entry.brand}
          lastFour={entry.lastFour}
          cardholderName={entry.cardholderName}
          fullName={entry.fullName}
          idNumberLast4={entry.idNumberLast4}
          relyingPartyId={entry.relyingPartyId}
          tags={entry.tags}
          isFavorite={entry.isFavorite}
          isArchived={entry.isArchived}
          expanded={expandedId === entry.id}
          onToggleFavorite={handleToggleFavorite}
          onToggleArchive={handleToggleArchive}
          onDelete={handleDelete}
          onToggleExpand={handleToggleExpand}
          onRefresh={() => { fetchPasswords(); onDataChange?.(); }}
        />
      ))}
    </div>
  );
}
