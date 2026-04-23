"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { useVault } from "@/lib/vault-context";
import { VAULT_STATUS, ENTRY_TYPE, apiPath } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";
import { ArrowLeft, KeyRound, Loader2, Lock } from "lucide-react";
import { eaErrorToI18nKey } from "@/lib/api-error-codes";
import {
  decryptPrivateKey,
  importPrivateKey,
  unwrapSecretKeyAsGrantee,
} from "@/lib/crypto/crypto-emergency";
import { deriveEncryptionKey, decryptData, hexDecode, type EncryptedData } from "@/lib/crypto/crypto-client";
import { buildPersonalEntryAAD } from "@/lib/crypto/crypto-aad";
import { fetchApi } from "@/lib/url-helpers";
import { PasswordCard } from "@/components/passwords/password-card";
import type { EntryCardData } from "@/types/entry-card";
import type { InlineDetailData } from "@/types/entry";
import type { EntryTagNameColor } from "@/lib/entry-form-types";

// No-op handler for read-only mode (stable reference across renders)
const noop = () => {};

interface RawVaultEntry {
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
  createdAt: string;
  updatedAt: string;
}

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
  bankName?: string | null;
  accountNumberLast4?: string | null;
  softwareName?: string | null;
  licensee?: string | null;
  keyType?: string | null;
  fingerprint?: string | null;
  tags: EntryTagNameColor[];
}

interface DisplayEntry {
  card: EntryCardData;
  raw: RawVaultEntry;
}

export default function EmergencyVaultPage() {
  const t = useTranslations("EmergencyAccess");
  const params = useParams();
  const grantId = params.id as string;
  const router = useRouter();
  const { status: vaultStatus, encryptionKey } = useVault();

  const [entries, setEntries] = useState<DisplayEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ownerName, setOwnerName] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [decryptFailCount, setDecryptFailCount] = useState(0);
  // Owner's derived encryption key, stored after ECDH unwrap for lazy blob decryption
  const ownerEncKeyRef = useRef<CryptoKey | null>(null);
  const ownerIdRef = useRef<string>("");

  const decryptEntries = useCallback(async () => {
    if (!encryptionKey) {
      setError(t("vaultUnlockRequired"));
      setLoading(false);
      return;
    }

    try {
      // 1. Fetch ECDH data
      const vaultRes = await fetchApi(apiPath.emergencyGrantVault(grantId));
      if (!vaultRes.ok) {
        const data = await vaultRes.json().catch(() => null);
        setError(t(eaErrorToI18nKey(data?.error)));
        setLoading(false);
        return;
      }
      const vaultData = await vaultRes.json();
      setOwnerName(vaultData.owner?.name || vaultData.owner?.email || "");
      ownerIdRef.current = vaultData.ownerId;

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

      // 3. Unwrap owner's secretKey
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
      ownerEncKeyRef.current = ownerEncKey;

      // 5. Fetch encrypted entries
      const entriesRes = await fetchApi(apiPath.emergencyGrantVaultEntries(grantId));
      if (!entriesRes.ok) {
        setError(t("networkError"));
        setLoading(false);
        return;
      }
      const rawEntries: RawVaultEntry[] = await entriesRes.json();

      // 6. Decrypt overviews for list display
      const decrypted: DisplayEntry[] = [];
      let failCount = 0;
      for (const entry of rawEntries) {
        try {
          const aad = entry.aadVersion >= 1
            ? buildPersonalEntryAAD(vaultData.ownerId, entry.id)
            : undefined;
          const overviewEncrypted: EncryptedData = {
            ciphertext: entry.encryptedOverview,
            iv: entry.overviewIv,
            authTag: entry.overviewAuthTag,
          };
          const overviewPlain = await decryptData(overviewEncrypted, ownerEncKey, aad);
          const overview: DecryptedOverview = JSON.parse(overviewPlain);

          decrypted.push({
            card: {
              id: entry.id,
              entryType: (entry.entryType as EntryTypeValue) ?? ENTRY_TYPE.LOGIN,
              title: overview.title || "Untitled",
              username: overview.username ?? null,
              urlHost: overview.urlHost ?? null,
              snippet: overview.snippet ?? null,
              brand: overview.brand ?? null,
              lastFour: overview.lastFour ?? null,
              cardholderName: overview.cardholderName ?? null,
              fullName: overview.fullName ?? null,
              idNumberLast4: overview.idNumberLast4 ?? null,
              relyingPartyId: overview.relyingPartyId ?? null,
              bankName: overview.bankName ?? null,
              accountNumberLast4: overview.accountNumberLast4 ?? null,
              softwareName: overview.softwareName ?? null,
              licensee: overview.licensee ?? null,
              keyType: overview.keyType ?? null,
              fingerprint: overview.fingerprint ?? null,
              tags: overview.tags ?? [],
              isFavorite: entry.isFavorite,
              isArchived: entry.isArchived,
            },
            raw: entry,
          });
        } catch {
          failCount++;
        }
      }

      setDecryptFailCount(failCount);
      setEntries(decrypted);
    } catch {
      setError(t("networkError"));
    } finally {
      setLoading(false);
    }
  }, [encryptionKey, grantId, t]);

  useEffect(() => {
    if (vaultStatus === VAULT_STATUS.UNLOCKED) {
      decryptEntries();
    }
  }, [vaultStatus, decryptEntries]);

  // Clear crypto refs on unmount
  useEffect(() => {
    return () => {
      ownerEncKeyRef.current = null;
      ownerIdRef.current = "";
    };
  }, []);

  const decryptBlob = useCallback(async (entry: RawVaultEntry) => {
    const ownerEncKey = ownerEncKeyRef.current;
    if (!ownerEncKey) throw new Error("Owner key not available");
    const aad = entry.aadVersion >= 1
      ? buildPersonalEntryAAD(ownerIdRef.current, entry.id)
      : undefined;
    const blobEncrypted: EncryptedData = {
      ciphertext: entry.encryptedBlob,
      iv: entry.blobIv,
      authTag: entry.blobAuthTag,
    };
    return JSON.parse(await decryptData(blobEncrypted, ownerEncKey, aad));
  }, []);

  const makeGetDetail = useCallback((displayEntry: DisplayEntry) => {
    return async (): Promise<InlineDetailData> => {
      const data = await decryptBlob(displayEntry.raw);
      return {
        id: displayEntry.raw.id,
        entryType: (displayEntry.raw.entryType as EntryTypeValue) ?? ENTRY_TYPE.LOGIN,
        requireReprompt: false,
        password: data.password ?? "",
        content: data.content,
        isMarkdown: data.isMarkdown,
        url: data.url ?? null,
        urlHost: displayEntry.card.urlHost,
        notes: data.notes ?? null,
        customFields: data.customFields ?? [],
        passwordHistory: data.passwordHistory ?? [],
        totp: data.totp,
        cardholderName: data.cardholderName,
        cardNumber: data.cardNumber,
        brand: data.brand,
        expiryMonth: data.expiryMonth,
        expiryYear: data.expiryYear,
        cvv: data.cvv,
        fullName: data.fullName,
        address: data.address,
        phone: data.phone,
        email: data.email,
        dateOfBirth: data.dateOfBirth,
        nationality: data.nationality,
        idNumber: data.idNumber,
        issueDate: data.issueDate,
        expiryDate: data.expiryDate,
        relyingPartyId: data.relyingPartyId,
        relyingPartyName: data.relyingPartyName,
        username: data.username,
        credentialId: data.credentialId,
        creationDate: data.creationDate,
        deviceInfo: data.deviceInfo,
        bankName: data.bankName,
        accountType: data.accountType,
        accountHolderName: data.accountHolderName,
        accountNumber: data.accountNumber,
        routingNumber: data.routingNumber,
        swiftBic: data.swiftBic,
        iban: data.iban,
        branchName: data.branchName,
        softwareName: data.softwareName,
        licenseKey: data.licenseKey,
        version: data.version,
        licensee: data.licensee,
        purchaseDate: data.purchaseDate,
        expirationDate: data.expirationDate,
        privateKey: data.privateKey,
        publicKey: data.publicKey,
        keyType: data.keyType,
        keySize: data.keySize,
        fingerprint: data.fingerprint,
        sshPassphrase: data.passphrase,
        sshComment: data.comment,
        createdAt: displayEntry.raw.createdAt,
        updatedAt: displayEntry.raw.updatedAt,
      };
    };
  }, [decryptBlob]);

  const makeGetPassword = useCallback((displayEntry: DisplayEntry) => {
    return async (): Promise<string> => {
      const data = await decryptBlob(displayEntry.raw);
      return data.password ?? "";
    };
  }, [decryptBlob]);

  const makeGetUrl = useCallback((displayEntry: DisplayEntry) => {
    return async (): Promise<string | null> => {
      const data = await decryptBlob(displayEntry.raw);
      return data.url ?? null;
    };
  }, [decryptBlob]);

  // Pre-compute stable callback references keyed by entry ID for O(1) lookup
  const entryCallbackMap = useMemo(
    () =>
      new Map(
        entries.map((entry) => [
          entry.card.id,
          {
            getPassword: makeGetPassword(entry),
            getDetail: makeGetDetail(entry),
            getUrl: makeGetUrl(entry),
          },
        ])
      ),
    [entries, makeGetDetail, makeGetPassword, makeGetUrl]
  );

  if (vaultStatus !== VAULT_STATUS.UNLOCKED) {
    return (
      <div className="flex-1 overflow-auto p-4 md:p-6">
        <div className="mx-auto flex max-w-md items-center justify-center pt-16">
          <Card className="w-full rounded-xl border text-center">
          <CardContent className="flex items-center justify-center gap-2 py-8">
            <Lock className="h-5 w-5" />
            <span>{t("vaultUnlockRequired")}</span>
          </CardContent>
        </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <Card className="rounded-xl border bg-gradient-to-b from-muted/30 to-background p-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => router.push("/dashboard/emergency-access")}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="flex items-center gap-2 text-2xl font-bold">
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
        </Card>

        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && (
          <Card className="rounded-xl border border-red-500/40 bg-red-500/5 p-4 text-center text-red-700 dark:text-red-400">
            {error}
          </Card>
        )}

        {!loading && decryptFailCount > 0 && (
          <Card className="rounded-xl border border-yellow-500/40 bg-yellow-500/5 p-4 text-center text-yellow-700 dark:text-yellow-400">
            {t("decryptFailWarning", { count: String(decryptFailCount) })}
          </Card>
        )}

        {!loading && !error && entries.length === 0 && (
          <Card className="rounded-xl border border-dashed p-8 text-center text-muted-foreground">
            {t("noEntries")}
          </Card>
        )}

        <div className="space-y-1">
          {entries.map((entry) => {
            const cb = entryCallbackMap.get(entry.card.id);
            return (
              <PasswordCard
                key={entry.card.id}
                entry={entry.card}
                expanded={expandedId === entry.card.id}
                onToggleFavorite={noop}
                onToggleArchive={noop}
                onDelete={noop}
                onToggleExpand={(id) => setExpandedId((prev) => (prev === id ? null : id))}
                onRefresh={noop}
                getPassword={cb?.getPassword}
                getDetail={cb?.getDetail}
                getUrl={cb?.getUrl}
                canEdit={false}
                canDelete={false}
                canShare={false}
                readOnly
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
