"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { SharePasswordGate } from "@/components/share/share-password-gate";
import { ShareSendView } from "@/components/share/share-send-view";
import { ShareEntryView } from "@/components/share/share-entry-view";
import { ShareE2EEntryView } from "@/components/share/share-e2e-entry-view";
import { fetchApi } from "@/lib/url-helpers";
import { SESSION_STORAGE_KEY, SHARE_TYPE } from "@/lib/constants";

interface ShareProtectedContentProps {
  shareId: string;
  token: string;
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

async function tryFetchContent(
  shareId: string,
  tokenToUse: string,
): Promise<ContentData | null> {
  try {
    const res = await fetchApi(`/api/share-links/${shareId}/content`, {
      headers: { Authorization: `Bearer ${tokenToUse}` },
    });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as ContentData;
  } catch {
    return null;
  }
}

export function ShareProtectedContent({
  shareId,
  token,
}: ShareProtectedContentProps) {
  const t = useTranslations("Share");
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [content, setContent] = useState<ContentData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetchContent = useCallback(async (tokenToUse: string): Promise<boolean> => {
    const data = await tryFetchContent(shareId, tokenToUse);
    if (!data) return false;
    setAccessToken(tokenToUse);
    setContent(data);
    return true;
  }, [shareId]);

  // Attempt to restore access token from sessionStorage on mount
  useEffect(() => {
    let cancelled = false;

    try {
      const stored = sessionStorage.getItem(`${SESSION_STORAGE_KEY.SHARE_ACCESS_PREFIX}${token}`);
      if (stored) {
        tryFetchContent(shareId, stored).then((data) => {
          if (cancelled) return;
          if (data) {
            setAccessToken(stored);
            setContent(data);
          } else {
            sessionStorage.removeItem(`${SESSION_STORAGE_KEY.SHARE_ACCESS_PREFIX}${token}`);
          }
        });
      }
    } catch {
      // sessionStorage unavailable
    }

    return () => { cancelled = true; };
  }, [token, shareId]);

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

  if (content.shareType === SHARE_TYPE.TEXT) {
    return (
      <ShareSendView
        sendType={SHARE_TYPE.TEXT}
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

  if (content.shareType === SHARE_TYPE.FILE) {
    return (
      <ShareSendView
        sendType={SHARE_TYPE.FILE}
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
