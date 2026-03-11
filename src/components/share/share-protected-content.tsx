"use client";

import { useState } from "react";
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

  const handleVerified = async (newAccessToken: string) => {
    setAccessToken(newAccessToken);
    setError(null);

    // Fetch content using the access token
    try {
      const res = await fetchApi(`/api/share-links/${shareId}/content`, {
        headers: { Authorization: `Bearer ${newAccessToken}` },
      });

      if (!res.ok) {
        setError(t("contentLoadError"));
        return;
      }

      const data: ContentData = await res.json();
      setContent(data);
    } catch {
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
