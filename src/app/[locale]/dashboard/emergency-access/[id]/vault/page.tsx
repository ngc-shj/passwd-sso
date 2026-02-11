"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { useVault } from "@/lib/vault-context";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useRouter } from "@/i18n/navigation";
import { ArrowLeft, Eye, EyeOff, KeyRound, Lock } from "lucide-react";
import {
  decryptPrivateKey,
  importPrivateKey,
  unwrapSecretKeyAsGrantee,
} from "@/lib/crypto-emergency";
import { deriveEncryptionKey, decryptData, hexDecode, type EncryptedData } from "@/lib/crypto-client";
import { buildPersonalEntryAAD } from "@/lib/crypto-aad";

interface VaultEntry {
  id: string;
  encryptedBlob: string;
  blobIv: string;
  blobAuthTag: string;
  encryptedOverview: string;
  overviewIv: string;
  overviewAuthTag: string;
  keyVersion: number;
  aadVersion: number;
  entryType: string;
  isFavorite: boolean;
  isArchived: boolean;
}

interface DecryptedEntry {
  id: string;
  entryType: string;
  title: string;
  username?: string;
  password?: string;
  url?: string;
  notes?: string;
}

export default function EmergencyVaultPage() {
  const t = useTranslations("EmergencyAccess");
  const params = useParams();
  const grantId = params.id as string;
  const router = useRouter();
  const { status: vaultStatus, encryptionKey } = useVault();

  const [entries, setEntries] = useState<DecryptedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ownerName, setOwnerName] = useState("");
  const [visiblePasswords, setVisiblePasswords] = useState<Set<string>>(new Set());

  const decryptEntries = useCallback(async () => {
    if (!encryptionKey) {
      setError(t("vaultUnlockRequired"));
      setLoading(false);
      return;
    }

    try {
      // 1. Fetch ECDH data
      const vaultRes = await fetch(`/api/emergency-access/${grantId}/vault`);
      if (!vaultRes.ok) {
        const data = await vaultRes.json();
        setError(data.error || t("networkError"));
        setLoading(false);
        return;
      }
      const vaultData = await vaultRes.json();
      setOwnerName(vaultData.owner?.name || vaultData.owner?.email || "");

      // 2. Decrypt grantee's ECDH private key
      const granteePrivKeyBytes = await decryptPrivateKey(
        {
          ciphertext: vaultData.granteeKeyPair.encryptedPrivateKey,
          iv: vaultData.granteeKeyPair.privateKeyIv,
          authTag: vaultData.granteeKeyPair.privateKeyAuthTag,
        },
        encryptionKey
      );
      const granteePrivKey = await importPrivateKey(granteePrivKeyBytes);

      // 3. Unwrap owner's secretKey (with HKDF salt and WrapContext AAD)
      const hkdfSalt = hexDecode(vaultData.hkdfSalt);
      const wrapCtx = {
        grantId: vaultData.grantId,
        ownerId: vaultData.ownerId,
        granteeId: vaultData.granteeId,
        keyVersion: vaultData.keyVersion ?? 1,
        wrapVersion: vaultData.wrapVersion ?? 1,
      };
      const ownerSecretKey = await unwrapSecretKeyAsGrantee(
        {
          ciphertext: vaultData.encryptedSecretKey,
          iv: vaultData.secretKeyIv,
          authTag: vaultData.secretKeyAuthTag,
        },
        vaultData.ownerEphemeralPublicKey,
        granteePrivKey,
        hkdfSalt,
        wrapCtx
      );

      // 4. Derive owner's encryption key
      const ownerEncKey = await deriveEncryptionKey(ownerSecretKey);
      ownerSecretKey.fill(0);

      // 5. Fetch encrypted entries
      const entriesRes = await fetch(`/api/emergency-access/${grantId}/vault/entries`);
      if (!entriesRes.ok) {
        setError(t("networkError"));
        setLoading(false);
        return;
      }
      const rawEntries: VaultEntry[] = await entriesRes.json();

      // 6. Decrypt all entries
      const decrypted: DecryptedEntry[] = [];
      for (const entry of rawEntries) {
        try {
          const blobEncrypted: EncryptedData = {
            ciphertext: entry.encryptedBlob,
            iv: entry.blobIv,
            authTag: entry.blobAuthTag,
          };
          const aad = entry.aadVersion >= 1
            ? buildPersonalEntryAAD(vaultData.ownerId, entry.id)
            : undefined;
          const plaintext = await decryptData(blobEncrypted, ownerEncKey, aad);
          const data = JSON.parse(plaintext);
          decrypted.push({
            id: entry.id,
            entryType: entry.entryType,
            title: data.title || "Untitled",
            username: data.username,
            password: data.password,
            url: data.url,
            notes: data.notes,
          });
        } catch {
          // Skip entries that fail to decrypt
        }
      }

      setEntries(decrypted);
    } catch {
      setError(t("networkError"));
    } finally {
      setLoading(false);
    }
  }, [encryptionKey, grantId, t]);

  useEffect(() => {
    if (vaultStatus === "unlocked") {
      decryptEntries();
    }
  }, [vaultStatus, decryptEntries]);

  const togglePassword = (id: string) => {
    setVisiblePasswords((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (vaultStatus !== "unlocked") {
    return (
      <div className="mx-auto flex max-w-md items-center justify-center p-4 pt-20">
        <Card className="w-full text-center">
          <CardContent className="flex items-center justify-center gap-2 py-8">
            <Lock className="h-5 w-5" />
            <span>{t("vaultUnlockRequired")}</span>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.push("/dashboard/emergency-access")}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold">
            <KeyRound className="h-5 w-5" />
            {t("readOnlyVault")}
          </h1>
          {ownerName && (
            <p className="text-sm text-muted-foreground">
              {t("readOnlyVaultDesc", { ownerName })}
            </p>
          )}
        </div>
      </div>

      {loading && (
        <div className="py-8 text-center text-muted-foreground">...</div>
      )}

      {error && (
        <div className="rounded-lg bg-red-500/10 p-4 text-center text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {!loading && !error && entries.length === 0 && (
        <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
          {t("noEntries")}
        </div>
      )}

      <div className="space-y-2">
        {entries.map((entry) => (
          <Card key={entry.id}>
            <CardHeader className="py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{entry.title}</span>
                  <Badge variant="outline" className="text-xs">
                    {entry.entryType}
                  </Badge>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-1 py-2 text-sm">
              {entry.username && (
                <div className="flex items-center gap-2">
                  <span className="w-20 text-muted-foreground">{t("username")}:</span>
                  <button
                    className="cursor-pointer font-mono hover:underline"
                    onClick={() => {
                      navigator.clipboard.writeText(entry.username!);
                      toast.success("Copied");
                    }}
                  >
                    {entry.username}
                  </button>
                </div>
              )}
              {entry.password && (
                <div className="flex items-center gap-2">
                  <span className="w-20 text-muted-foreground">{t("password")}:</span>
                  <button
                    className="cursor-pointer font-mono hover:underline"
                    onClick={() => {
                      navigator.clipboard.writeText(entry.password!);
                      toast.success("Copied");
                    }}
                  >
                    {visiblePasswords.has(entry.id) ? entry.password : "••••••••"}
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => togglePassword(entry.id)}
                  >
                    {visiblePasswords.has(entry.id) ? (
                      <EyeOff className="h-3 w-3" />
                    ) : (
                      <Eye className="h-3 w-3" />
                    )}
                  </Button>
                </div>
              )}
              {entry.url && (
                <div className="flex items-center gap-2">
                  <span className="w-20 text-muted-foreground">URL:</span>
                  <span className="truncate font-mono text-xs">{entry.url}</span>
                </div>
              )}
              {entry.notes && (
                <div className="flex gap-2">
                  <span className="w-20 text-muted-foreground">{t("notes")}:</span>
                  <span className="whitespace-pre-wrap text-xs">{entry.notes}</span>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
