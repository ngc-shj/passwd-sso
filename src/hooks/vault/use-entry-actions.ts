"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useReprompt } from "@/hooks/vault/use-reprompt";
import { copySecretToClipboard } from "@/lib/clipboard/copy-secret";
import { reportCopyOutcome } from "@/lib/clipboard/report-copy-outcome";
import type { InlineDetailData } from "@/types/entry";

/**
 * Minimal entry shape required by useEntryActions.
 * Both DisplayEntry (personal) and TeamPasswordEntry satisfy this interface,
 * so the hook is vault-agnostic (Commonization principle).
 */
export interface DisplayEntryLike {
  id: string;
  username: string | null;
}

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
 * Returns a stable factory function `(entry: E) => EntryActionCallbacks`.
 *
 * The hook is vault-agnostic: it accepts a `getDetailFor` function that builds
 * a per-entry detail fetcher. Both the personal vault (via buildPersonalGetDetail)
 * and the team vault (via createDetailFetcher) use this same hook — there is ONE
 * source of truth for copy/fetch/clipboard logic (Commonization).
 *
 * @param getDetailFor - Given an entry, returns a zero-arg async function that
 *   resolves to InlineDetailData. Called at factory-call time (per row render),
 *   so it can close over entry-specific context (id, entryType, etc.).
 *
 * Security: clipboard is cleared after CLIPBOARD_CLEAR_TIMEOUT_MS (30s).
 */
export function useEntryActions<E extends DisplayEntryLike>(
  getDetailFor: (entry: E) => () => Promise<InlineDetailData>,
): { buildCallbacks: (entry: E) => EntryActionCallbacks; repromptDialog: ReactNode } {
  const tCopy = useTranslations("CopyButton");
  const tCard = useTranslations("PasswordCard");
  const { createGuardedGetter, repromptDialog } = useReprompt();

  // Clipboard write, emptiness, and the 30s clear all live in the shared
  // primitive now — this hook, CopyButton and PasswordCard had three
  // byte-identical copies of the clear routine and three different ideas of what
  // to show the user.
  const makeCopyToast = async (getter: () => Promise<string>) => {
    reportCopyOutcome(await copySecretToClipboard(getter), { tCopy, tCard });
  };

  const buildCallbacks = (entry: E): EntryActionCallbacks => {
    const getDetail = getDetailFor(entry);

    /**
     * The single place the row and overflow-menu copies obtain a value out of
     * the DECRYPTED BLOB, and therefore the only place the re-prompt has to be
     * applied for those. The overview-sourced username copy is deliberately
     * outside this funnel — see onCopyUsername below.
     *
     * The guard wraps the value AFTER the detail is decrypted, which is the same
     * ordering the detail pane's sections use: `requireReprompt` governs whether
     * the secret may leave the vault, not whether it may be decrypted into page
     * memory. The flag rides on the detail itself, so there is no second fetch
     * and no way to reach a field without having consulted it.
     *
     * A declined prompt rejects with CopyCancelledError, which the clipboard
     * primitive classifies as CANCELLED — the one outcome reported silently.
     */
    const fetchGuarded = (pick: (d: InlineDetailData) => string) => async () => {
      const d = await getDetail();
      return createGuardedGetter(entry.id, d.requireReprompt, () => pick(d))();
    };

    const fetchPassword = fetchGuarded((d) => d.password ?? "");
    const fetchContent = fetchGuarded((d) => d.content ?? "");
    const fetchCardField = (field: "cardNumber" | "cvv") =>
      fetchGuarded((d) => (d[field] ?? "") as string)();
    const fetchIdentityField = (field: "idNumber") =>
      fetchGuarded((d) => (d[field] ?? "") as string)();
    const fetchPasskeyField = (field: "credentialId" | "username") =>
      fetchGuarded((d) => (d[field] ?? "") as string)();
    const fetchBankField = (field: "accountNumber" | "routingNumber") =>
      fetchGuarded((d) => (d[field] ?? "") as string)();
    const fetchLicenseField = (field: "licenseKey") =>
      fetchGuarded((d) => (d[field] ?? "") as string)();
    const fetchSshField = (field: "fingerprint" | "publicKey") =>
      fetchGuarded((d) => (d[field] ?? "") as string)();

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
      // DELIBERATELY UNGUARDED, under a stated policy: a username shown on
      // screen is a public identifier regardless of where it was stored. The
      // list renders it in plain text beside every entry, and the detail pane
      // copies it with a raw getter for the same reason — including
      // passkey-section.tsx, whose `data.username` DOES come out of the
      // decrypted blob. Guarding it here would demand a passphrase for a value
      // the same screen is already displaying.
      //
      // (The `fetchPasskeyField("username")` branch exists in the callback
      // surface but has no production caller, so it is not the counter-example
      // it might look like.)
      //
      // Also no `if (!entry.username) return`: the menu item renders inside
      // `{username && (...)}` and is the only path here, so the empty case was
      // never reachable from the UI. The primitive decides it now.
      onCopyUsername: () => void makeCopyToast(async () => entry.username ?? ""),
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
          const d = await getDetail();
          if (d.url) window.open(d.url, "_blank", "noopener,noreferrer");
        } catch { toast.error(tCard("networkError")); }
      },
    };
  };

  return { buildCallbacks, repromptDialog };
}
