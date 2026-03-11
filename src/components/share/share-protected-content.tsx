"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { SharePasswordGate } from "@/components/share/share-password-gate";
import { ShareSendView } from "@/components/share/share-send-view";
import { ShareEntryView } from "@/components/share/share-entry-view";
import { ShareE2EEntryView } from "@/components/share/share-e2e-entry-view";
import { fetchApi } from "@/lib/url-helpers";

interface ShareProtectedContentProps {
  shareId: string;
  token: string;
  shareType: string;
  entryType: string | null;
  expiresAt: string;
  maxViews: number | null;
}

interface ContentData {
  shareType: string;
  entryType: string | null;
  data?: Record<string, unknown>;
  encryptedData?: string;
  dataIv?: string;
  dataAuthTag?: string;
  sendName?: string | null;
  sendFilename?: string | null;
  sendSizeBytes?: number | null;
  expiresAt: string;
  viewCount: number;
  maxViews: number | null;
}

export function ShareProtectedContent({
  shareId,
  token,
  shareType,
  entryType,
  expiresAt,
  maxViews,
}: ShareProtectedContentProps) {
  const t = useTranslations("Share");
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [content, setContent] = useState<ContentData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchContent = useCallback(async (tokenToUse: string): Promise<boolean> => {
    try {
      const res = await fetchApi(`/api/share-links/${shareId}/content`, {
        headers: { Authorization: `Bearer ${tokenToUse}` },
      });

      if (!res.ok) {
        return false;
      }

      const data: ContentData = await res.json();
      setAccessToken(tokenToUse);
      setContent(data);
      return true;
    } catch {
      return false;
    }
  }, [shareId]);

  // Attempt to restore access token from sessionStorage on mount
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(`share-access:${token}`);
      if (stored) {
        fetchContent(stored).then((ok) => {
          if (!ok) {
            // Stale or expired token — clear and show gate
            sessionStorage.removeItem(`share-access:${token}`);
          }
        });
      }
    } catch {
      // sessionStorage unavailable
    }
  }, [token, fetchContent]);

  const handleVerified = async (newAccessToken: string) => {
    setError(null);

    const ok = await fetchContent(newAccessToken);
    if (!ok) {
      setError(t("contentLoadError"));
    }
  };

  if (!accessToken || !content) {
    return (
      <SharePasswordGate
        token={token}
        onVerified={handleVerified}
        error={error}
      />
    );
  }

  // E2E share: client-side decryption
  if (content.encryptedData && content.dataIv && content.dataAuthTag) {
    return (
      <ShareE2EEntryView
        encryptedData={content.encryptedData}
        dataIv={content.dataIv}
        dataAuthTag={content.dataAuthTag}
        entryType={content.entryType!}
        expiresAt={content.expiresAt}
        viewCount={content.viewCount}
        maxViews={content.maxViews}
      />
    );
  }

  // Server-decrypted content
  const data = content.data ?? {};

  if (content.shareType === "TEXT") {
    return (
      <ShareSendView
        sendType="TEXT"
        name={String(data.name ?? content.sendName ?? "")}
        text={String(data.text ?? "")}
        token={token}
        expiresAt={content.expiresAt}
        viewCount={content.viewCount}
        maxViews={content.maxViews}
        accessToken={accessToken}
      />
    );
  }

  if (content.shareType === "FILE") {
    return (
      <ShareSendView
        sendType="FILE"
        name={String(data.name ?? content.sendName ?? "")}
        filename={content.sendFilename}
        sizeBytes={content.sendSizeBytes}
        token={token}
        expiresAt={content.expiresAt}
        viewCount={content.viewCount}
        maxViews={content.maxViews}
        accessToken={accessToken}
      />
    );
  }

  // ENTRY_SHARE
  return (
    <ShareEntryView
      data={data}
      entryType={content.entryType!}
      expiresAt={content.expiresAt}
      viewCount={content.viewCount}
      maxViews={content.maxViews}
    />
  );
}
