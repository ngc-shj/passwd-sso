"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { useVault } from "@/lib/vault-context";
import { API_PATH } from "@/lib/constants/api-path";
import { fetchApi } from "@/lib/url-helpers";
import { decryptData, type EncryptedData } from "@/lib/crypto/crypto-client";
import { buildPersonalEntryAAD } from "@/lib/crypto/crypto-aad";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Loader2, AlertTriangle, Search } from "lucide-react";

interface AvailableToken {
  id: string;
  mcpClientName: string;
  mcpClientId: string;
  hasDelegationScope: boolean;
  expiresAt: string;
}

interface DecryptedOverview {
  title: string;
  username?: string | null;
  urlHost?: string | null;
}

interface EntryItem {
  id: string;
  title: string;
  username: string | null;
  urlHost: string | null;
  aadVersion: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  availableTokens: AvailableToken[];
  onCreated: () => void;
}

const TTL_OPTIONS = [
  { value: 300, label: "5" },
  { value: 900, label: "15" },
  { value: 1800, label: "30" },
  { value: 3600, label: "60" },
];

export function CreateDelegationDialog({
  open,
  onOpenChange,
  availableTokens,
  onCreated,
}: Props) {
  const t = useTranslations("MachineIdentity.delegation");
  const { encryptionKey, userId } = useVault();
  const [search, setSearch] = useState("");
  const [selectedTokenId, setSelectedTokenId] = useState<string>("");
  const [entries, setEntries] = useState<EntryItem[]>([]);
  const [selectedEntryIds, setSelectedEntryIds] = useState<Set<string>>(
    new Set(),
  );
  const [ttlSeconds, setTtlSeconds] = useState(900);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const loadedRef = useRef(false);

  const decryptableTokens = availableTokens.filter((t) => t.hasDelegationScope);

  // Load and decrypt entries on open
  const loadEntries = useCallback(async () => {
    if (!encryptionKey || !userId) return;
    setLoading(true);
    try {
      const res = await fetchApi(API_PATH.PASSWORDS);
      if (!res.ok) return;
      const data = await res.json();

      const decrypted: EntryItem[] = [];
      for (const entry of data) {
        try {
          const aad =
            entry.aadVersion >= 1
              ? buildPersonalEntryAAD(userId, entry.id)
              : undefined;
          const overview: DecryptedOverview = JSON.parse(
            await decryptData(
              entry.encryptedOverview as EncryptedData,
              encryptionKey,
              aad,
            ),
          );
          decrypted.push({
            id: entry.id,
            title: overview.title,
            username: overview.username ?? null,
            urlHost: overview.urlHost ?? null,
            aadVersion: entry.aadVersion,
          });
        } catch {
          // Skip entries that fail to decrypt
        }
      }
      setEntries(decrypted.sort((a, b) => a.title.localeCompare(b.title)));
      loadedRef.current = true;
    } finally {
      setLoading(false);
    }
  }, [encryptionKey, userId]);

  useEffect(() => {
    if (open && selectedTokenId && !loadedRef.current) {
      loadEntries();
    }
  }, [open, selectedTokenId, loadEntries]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setSelectedTokenId("");
      setEntries([]);
      setSelectedEntryIds(new Set());
      setTtlSeconds(900);
      setSearch("");
      loadedRef.current = false;
    }
  }, [open]);

  const toggleEntry = (id: string) => {
    setSelectedEntryIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < 20) {
        next.add(id);
      }
      return next;
    });
  };

  const handleSubmit = async () => {
    if (!encryptionKey || !userId || selectedEntryIds.size === 0 || !selectedTokenId)
      return;
    setSubmitting(true);

    try {
      // Build metadata-only entries from already-decrypted overview data
      // Secret fields (password, notes, url) are intentionally excluded
      const delegationEntries: Array<{
        id: string;
        title: string;
        username?: string | null;
        urlHost?: string | null;
        tags?: string[] | null;
      }> = [];

      const failedIds: string[] = [];
      const entryById = new Map(entries.map((e) => [e.id, e]));
      for (const entryId of selectedEntryIds) {
        // Look up from already-loaded overview data to avoid extra decryption round-trips
        const entry = entryById.get(entryId);
        if (entry) {
          delegationEntries.push({
            id: entryId,
            title: entry.title,
            username: entry.username ?? null,
            urlHost: entry.urlHost ?? null,
          });
        } else {
          failedIds.push(entryId);
        }
      }

      if (failedIds.length > 0 && delegationEntries.length === 0) {
        toast.error("Failed to build delegation entries");
        return;
      }

      const res = await fetchApi(API_PATH.VAULT_DELEGATION, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mcpTokenId: selectedTokenId,
          ttlSeconds,
          entries: delegationEntries,
        }),
      });

      if (res.ok) {
        toast.success(t("created"));
        onOpenChange(false);
        onCreated();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error ?? "Failed to create delegation");
      }
    } catch {
      toast.error("Failed to create delegation");
    } finally {
      setSubmitting(false);
    }
  };

  const filteredEntries = entries.filter((e) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      e.title.toLowerCase().includes(q) ||
      (e.username?.toLowerCase().includes(q) ?? false)
    );
  });

  const canSubmit =
    selectedTokenId !== "" && selectedEntryIds.size > 0 && !submitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-lg flex-col">
        <DialogHeader>
          <DialogTitle>{t("newDelegation")}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 space-y-3 overflow-hidden">
          {/* MCP token + TTL — single row */}
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Label className="mb-1 text-xs">{t("selectMcpToken")}</Label>
              {decryptableTokens.length === 0 ? (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                  <p>{t("noDecryptScope")}</p>
                </div>
              ) : (
                <Select
                  value={selectedTokenId}
                  onValueChange={setSelectedTokenId}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder={t("selectMcpToken")} />
                  </SelectTrigger>
                  <SelectContent>
                    {decryptableTokens.map((token) => {
                      const remaining = Math.max(
                        0,
                        Math.floor(
                          (new Date(token.expiresAt).getTime() - Date.now()) /
                            60_000,
                        ),
                      );
                      const expired = remaining <= 0;
                      return (
                        <SelectItem
                          key={token.id}
                          value={token.id}
                          disabled={expired}
                        >
                          <span>{token.mcpClientName}</span>
                          <span
                            className={`ml-2 text-xs ${expired ? "text-destructive" : "text-muted-foreground"}`}
                          >
                            {expired
                              ? t("expired")
                              : t("expiresIn", { minutes: remaining })}
                          </span>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="w-28 shrink-0">
              <Label className="mb-1 text-xs">{t("setTtl")}</Label>
              <Select
                value={String(ttlSeconds)}
                onValueChange={(v) => setTtlSeconds(Number(v))}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TTL_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={String(opt.value)}>
                      {t("ttlMinutes", { minutes: opt.label })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Search + entry list — only shown after MCP token is selected */}
          {selectedTokenId && (
            <>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder={t("selectEntries")}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="h-9 pl-9"
                  />
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {selectedEntryIds.size}/20
                </span>
              </div>

              {loading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin" />
                </div>
              ) : (
                <div className="max-h-[40vh] overflow-y-auto rounded-md border p-1.5">
                  {filteredEntries.map((entry) => (
                    <label
                      key={entry.id}
                      className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted"
                    >
                      <Checkbox
                        checked={selectedEntryIds.has(entry.id)}
                        onCheckedChange={() => toggleEntry(entry.id)}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {entry.title}
                        </p>
                        {entry.username && (
                          <p className="truncate text-xs text-muted-foreground">
                            {entry.username}
                          </p>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Warning + submit */}
        {selectedEntryIds.size > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
            <p>{t("warning")}</p>
          </div>
        )}

        <DialogFooter>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
