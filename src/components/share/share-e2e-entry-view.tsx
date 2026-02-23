"use client";

import { useState, useEffect, useMemo } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { ShareEntryView } from "@/components/share/share-entry-view";
import { ShareError } from "@/components/share/share-error";

interface ShareE2EEntryViewProps {
  encryptedData: string; // hex ciphertext
  dataIv: string; // hex (24 chars)
  dataAuthTag: string; // hex (32 chars)
  entryType: string;
  expiresAt: string;
  viewCount: number;
  maxViews: number | null;
}

function hexDecode(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function base64urlDecode(str: string): Uint8Array {
  // Restore base64 padding and standard chars
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function decryptShareE2E(
  ciphertextHex: string,
  ivHex: string,
  authTagHex: string,
  keyBytes: Uint8Array
): Promise<Record<string, unknown>> {
  const ciphertext = hexDecode(ciphertextHex);
  const iv = hexDecode(ivHex);
  const authTag = hexDecode(authTagHex);

  // Web Crypto expects ciphertext + authTag concatenated
  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext);
  combined.set(authTag, ciphertext.length);

  const toAB = (arr: Uint8Array): ArrayBuffer =>
    arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;

  const key = await crypto.subtle.importKey(
    "raw",
    toAB(keyBytes),
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toAB(iv) },
    key,
    toAB(combined)
  );

  const plaintext = new TextDecoder().decode(decrypted);
  return JSON.parse(plaintext);
}

export function ShareE2EEntryView({
  encryptedData,
  dataIv,
  dataAuthTag,
  entryType,
  expiresAt,
  viewCount,
  maxViews,
}: ShareE2EEntryViewProps) {
  const t = useTranslations("Share");

  // Parse share key from URL fragment (pure computation, no setState).
  const parsedKey = useMemo(() => {
    if (typeof window === "undefined") return null;
    const hash = window.location.hash;
    const keyParam = hash
      .slice(1)
      .split("&")
      .find((p) => p.startsWith("key="));
    if (!keyParam) return null;
    const keyB64 = keyParam.slice(4);
    if (!keyB64) return null;
    try {
      const bytes = base64urlDecode(keyB64);
      return bytes.length === 32 ? bytes : null;
    } catch {
      return null;
    }
  }, []);

  // Decrypt state — only set from async callbacks inside the effect.
  const [decryptState, setDecryptState] = useState<
    | { status: "pending" }
    | { status: "error"; reason: string }
    | { status: "ok"; data: Record<string, unknown> }
  >({ status: "pending" });

  // Derive display state: missing key → error, pending → loading, otherwise decrypt result.
  const state = !parsedKey
    ? ({ status: "error", reason: "missingKey" } as const)
    : decryptState.status === "pending"
      ? ({ status: "loading" } as const)
      : decryptState;

  // Prevent URL leakage via Referer header (S-06)
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "referrer";
    meta.content = "no-referrer";
    document.head.appendChild(meta);
    return () => { document.head.removeChild(meta); };
  }, []);

  useEffect(() => {
    // Remove fragment from browser history immediately (S-15)
    history.replaceState(null, "", location.pathname + location.search);

    if (!parsedKey) return;

    decryptShareE2E(encryptedData, dataIv, dataAuthTag, parsedKey)
      .then((data) => setDecryptState({ status: "ok", data }))
      .catch(() => setDecryptState({ status: "error", reason: "decryptFailed" }))
      .finally(() => parsedKey.fill(0));
  }, [parsedKey, encryptedData, dataIv, dataAuthTag]);

  if (state.status === "loading") {
    return (
      <div className="min-h-screen bg-gradient-to-b from-muted/30 to-background p-4">
        <div className="mx-auto flex max-w-md items-center justify-center py-16">
          <Card className="w-full space-y-4 rounded-xl border p-8 text-center">
            <Loader2 className="mx-auto h-10 w-10 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t("e2eDecrypting")}</p>
          </Card>
        </div>
      </div>
    );
  }

  if (state.status === "error") {
    return <ShareError reason={state.reason} />;
  }

  return (
    <ShareEntryView
      data={state.data}
      entryType={entryType}
      expiresAt={expiresAt}
      viewCount={viewCount}
      maxViews={maxViews}
    />
  );
}
