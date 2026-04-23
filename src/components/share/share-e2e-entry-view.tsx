"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { ShareEntryView } from "@/components/share/share-entry-view";
import { ShareError } from "@/components/share/share-error";
import { hexDecode, toArrayBuffer } from "@/lib/crypto/crypto-utils";

interface ShareE2EEntryViewProps {
  encryptedData: string; // hex ciphertext
  dataIv: string; // hex (24 chars)
  dataAuthTag: string; // hex (32 chars)
  entryType: string;
  expiresAt: string;
  viewCount: number;
  maxViews: number | null;
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

  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(keyBytes),
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(combined)
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

  // Decrypt state — starts as "pending" on both server and client to avoid hydration mismatch.
  const [decryptState, setDecryptState] = useState<
    | { status: "pending" }
    | { status: "error"; reason: string }
    | { status: "ok"; data: Record<string, unknown> }
  >({ status: "pending" });

  // Prevent URL leakage via Referer header (S-06)
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "referrer";
    meta.content = "no-referrer";
    document.head.appendChild(meta);
    return () => { document.head.removeChild(meta); };
  }, []);

  useEffect(() => {
    async function decrypt() {
      // Parse share key from URL fragment (client-only)
      const hash = window.location.hash;
      const keyParam = hash
        .slice(1)
        .split("&")
        .find((p) => p.startsWith("key="));

      // Remove fragment from browser history immediately (S-15)
      history.replaceState(null, "", location.pathname + location.search);

      if (!keyParam) {
        setDecryptState({ status: "error", reason: "missingKey" });
        return;
      }
      const keyB64 = keyParam.slice(4);
      let keyBytes: Uint8Array;
      try {
        keyBytes = base64urlDecode(keyB64);
        if (keyBytes.length !== 32) {
          setDecryptState({ status: "error", reason: "missingKey" });
          return;
        }
      } catch {
        setDecryptState({ status: "error", reason: "missingKey" });
        return;
      }

      try {
        const data = await decryptShareE2E(encryptedData, dataIv, dataAuthTag, keyBytes);
        setDecryptState({ status: "ok", data });
      } catch {
        setDecryptState({ status: "error", reason: "decryptFailed" });
      } finally {
        keyBytes.fill(0);
      }
    }
    decrypt();
  }, [encryptedData, dataIv, dataAuthTag]);

  if (decryptState.status === "pending") {
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

  if (decryptState.status === "error") {
    return <ShareError reason={decryptState.reason} />;
  }

  return (
    <ShareEntryView
      data={decryptState.data}
      entryType={entryType}
      expiresAt={expiresAt}
      viewCount={viewCount}
      maxViews={maxViews}
    />
  );
}
