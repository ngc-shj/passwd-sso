"use client";

import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { buildPersonalGetDetail } from "@/lib/vault/build-personal-get-detail";
import { CLIPBOARD_CLEAR_TIMEOUT_MS } from "@/lib/constants";
import type { DisplayEntry } from "@/components/passwords/detail/password-list";

/**
 * The full set of copy/fetch/open callbacks for a single vault entry.
 * Returned by useEntryActions and consumed by both PasswordRow (list) and
 * PasswordDetailPane header (pane) — ONE source of truth (Commonization).
 */
export interface EntryActionCallbacks {
  fetchPassword: () => Promise<string>;
  fetchContent: () => Promise<string>;
  fetchCardField: (field: "cardNumber" | "cvv") => Promise<string>;
  fetchIdentityField: (field: "idNumber") => Promise<string>;
  fetchPasskeyField: (field: "credentialId" | "username") => Promise<string>;
  fetchBankField: (field: "accountNumber" | "routingNumber") => Promise<string>;
  fetchLicenseField: (field: "licenseKey") => Promise<string>;
  fetchSshField: (field: "fingerprint" | "publicKey") => Promise<string>;
  onCopyPassword: () => void;
  onCopyContent: () => void;
  onCopyUsername: () => void;
  onCopyCardNumber: () => void;
  onCopyCvv: () => void;
  onCopyCredentialId: () => void;
  onCopyAccountNumber: () => void;
  onCopyLicenseKey: () => void;
  onCopyFingerprint: () => void;
  onCopyPublicKey: () => void;
  onCopyIdNumber: () => void;
  onOpenUrl: () => Promise<void>;
}

/**
 * Returns a stable factory function `(entry: DisplayEntry) => EntryActionCallbacks`.
 * Used by PasswordList (list rows) and PasswordDashboard (detail pane header) so
 * copy/fetch logic is never duplicated across the personal vault UI.
 *
 * Security: clipboard is cleared after CLIPBOARD_CLEAR_TIMEOUT_MS (30s).
 * The vault-locked path throws immediately so no plaintext is ever requested.
 */
export function useEntryActions(
  encryptionKey: CryptoKey | null,
  userId: string | null,
): (entry: DisplayEntry) => EntryActionCallbacks {
  const tCopy = useTranslations("CopyButton");
  const tCard = useTranslations("PasswordCard");

  // Clipboard clear: overwrite only if the value is still there (mirrors password-card.tsx).
  const scheduleClearClipboard = (copiedValue: string) => {
    setTimeout(async () => {
      try {
        const current = await navigator.clipboard.readText();
        if (current === copiedValue) await navigator.clipboard.writeText("");
      } catch {
        try { await navigator.clipboard.writeText(""); } catch { /* best-effort */ }
      }
    }, CLIPBOARD_CLEAR_TIMEOUT_MS);
  };

  const makeCopyToast = async (getter: () => Promise<string>) => {
    try {
      const val = await getter();
      if (!val) return;
      await navigator.clipboard.writeText(val);
      toast.success(tCopy("copied"));
      scheduleClearClipboard(val);
    } catch {
      toast.error(tCard("networkError"));
    }
  };

  return (entry: DisplayEntry): EntryActionCallbacks => {
    const getEntry = encryptionKey
      ? buildPersonalGetDetail(entry, { encryptionKey, userId })
      : async (_id: string): Promise<never> => { throw new Error("Vault locked"); };

    const fetchPassword = async () => {
      const d = await getEntry(entry.id);
      return d.password ?? "";
    };
    const fetchContent = async () => {
      const d = await getEntry(entry.id);
      return d.content ?? "";
    };
    const fetchCardField = async (field: "cardNumber" | "cvv") => {
      const d = await getEntry(entry.id);
      return (d[field] ?? "") as string;
    };
    const fetchIdentityField = async (field: "idNumber") => {
      const d = await getEntry(entry.id);
      return (d[field] ?? "") as string;
    };
    const fetchPasskeyField = async (field: "credentialId" | "username") => {
      const d = await getEntry(entry.id);
      return (d[field] ?? "") as string;
    };
    const fetchBankField = async (field: "accountNumber" | "routingNumber") => {
      const d = await getEntry(entry.id);
      return (d[field] ?? "") as string;
    };
    const fetchLicenseField = async (field: "licenseKey") => {
      const d = await getEntry(entry.id);
      return (d[field] ?? "") as string;
    };
    const fetchSshField = async (field: "fingerprint" | "publicKey") => {
      const d = await getEntry(entry.id);
      return (d[field] ?? "") as string;
    };

    return {
      fetchPassword,
      fetchContent,
      fetchCardField,
      fetchIdentityField,
      fetchPasskeyField,
      fetchBankField,
      fetchLicenseField,
      fetchSshField,
      onCopyPassword: () => void makeCopyToast(fetchPassword),
      onCopyContent: () => void makeCopyToast(fetchContent),
      onCopyUsername: () => {
        if (!entry.username) return;
        void makeCopyToast(async () => entry.username ?? "");
      },
      onCopyCardNumber: () => void makeCopyToast(() => fetchCardField("cardNumber")),
      onCopyCvv: () => void makeCopyToast(() => fetchCardField("cvv")),
      onCopyCredentialId: () => void makeCopyToast(() => fetchPasskeyField("credentialId")),
      onCopyAccountNumber: () => void makeCopyToast(() => fetchBankField("accountNumber")),
      onCopyLicenseKey: () => void makeCopyToast(() => fetchLicenseField("licenseKey")),
      onCopyFingerprint: () => void makeCopyToast(() => fetchSshField("fingerprint")),
      onCopyPublicKey: () => void makeCopyToast(() => fetchSshField("publicKey")),
      onCopyIdNumber: () => void makeCopyToast(() => fetchIdentityField("idNumber")),
      onOpenUrl: async () => {
        try {
          const d = await getEntry(entry.id);
          if (d.url) window.open(d.url, "_blank", "noopener,noreferrer");
        } catch { toast.error(tCard("networkError")); }
      },
    };
  };
}
