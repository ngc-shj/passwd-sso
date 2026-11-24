"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { API_PATH, apiPath } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import { revokeLeftLinkRevoked } from "@/lib/share/share-link-revoke";

export interface ShareLinkItem {
  id: string;
  entryType: string | null;
  shareType: string;
  sendName: string | null;
  sendFilename: string | null;
  sendSizeBytes: number | null;
  expiresAt: string;
  maxViews: number | null;
  viewCount: number;
  revokedAt: string | null;
  createdAt: string;
  passwordEntryId: string | null;
  teamPasswordEntryId: string | null;
  teamName: string | null;
  hasPersonalEntry: boolean;
  sharedBy: string | null;
  canRevoke: boolean;
  /** The access log (viewers' IPs and user agents) is the creator's only. */
  canViewAccessLogs: boolean;
  isActive: boolean;
  /** False when the link no longer serves because its creator left the entry's team. */
  creatorAdmitted?: boolean;
}

export interface ShareAccessLogItem {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

/**
 * The viewer's share links and sends: filtered, paginated list state, revoke,
 * and the per-link access-log drawer.
 */
export function useShareLinks() {
  const tShare = useTranslations("Share");
  const searchParams = useSearchParams();
  const teamFilter = searchParams.get("team");
  const typeParam = searchParams.get("type");
  const [links, setLinks] = useState<ShareLinkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>(typeParam === "send" || typeParam === "entry" ? typeParam : "all");
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [accessLogs, setAccessLogs] = useState<ShareAccessLogItem[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [logNextCursor, setLogNextCursor] = useState<string | null>(null);

  // Sync typeFilter when navigating via sidebar links (?type=send / ?type=entry)
  const [prevTypeParam, setPrevTypeParam] = useState(typeParam);
  if (typeParam !== prevTypeParam) {
    setPrevTypeParam(typeParam);
    setTypeFilter(typeParam === "send" || typeParam === "entry" ? typeParam : "all");
  }

  const fetchLinks = useCallback(
    async (cursor?: string) => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (typeFilter !== "all") params.set("shareType", typeFilter);
      if (teamFilter) params.set("team", teamFilter);
      if (cursor) params.set("cursor", cursor);

      const res = await fetchApi(`${API_PATH.SHARE_LINKS_MINE}?${params.toString()}`);
      if (!res.ok) return null;
      return res.json();
    },
    [statusFilter, typeFilter, teamFilter]
  );

  // A new fetchLinks is exactly what re-runs the effect below.
  const [prevFetchLinks, setPrevFetchLinks] = useState(() => fetchLinks);
  if (fetchLinks !== prevFetchLinks) {
    setPrevFetchLinks(() => fetchLinks);
    setLoading(true);
  }

  useEffect(() => {
    fetchLinks().then((data) => {
      if (data) {
        setLinks(data.items);
        setNextCursor(data.nextCursor);
      }
      setLoading(false);
    });
  }, [fetchLinks]);

  const handleLoadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    const data = await fetchLinks(nextCursor);
    if (data) {
      setLinks((prev) => [...prev, ...data.items]);
      setNextCursor(data.nextCursor);
    }
    setLoadingMore(false);
  };

  const fetchAccessLogs = useCallback(
    async (shareId: string, cursor?: string | null) => {
      setLoadingLogs(true);
      try {
        const url = `${apiPath.shareLinkAccessLogs(shareId)}${cursor ? `?cursor=${cursor}` : ""}`;
        const res = await fetchApi(url);
        if (res.ok) {
          const data = await res.json();
          if (cursor) {
            setAccessLogs((prev) => [...prev, ...data.items]);
          } else {
            setAccessLogs(data.items);
          }
          setLogNextCursor(data.nextCursor);
        }
      } catch {
        // silently fail
      } finally {
        setLoadingLogs(false);
      }
    },
    []
  );

  const toggleAccessLogs = (shareId: string) => {
    if (expandedLogId === shareId) {
      setExpandedLogId(null);
      setAccessLogs([]);
      setLogNextCursor(null);
    } else {
      setExpandedLogId(shareId);
      fetchAccessLogs(shareId);
    }
  };

  const handleRevoke = async (id: string) => {
    setRevokingId(id);
    try {
      const res = await fetchApi(apiPath.shareLinkById(id), { method: "DELETE" });
      if (await revokeLeftLinkRevoked(res)) {
        toast.success(tShare("revokeSuccess"));
        // Update in-place
        setLinks((prev) =>
          prev.map((l) =>
            l.id === id
              ? { ...l, revokedAt: new Date().toISOString(), isActive: false }
              : l
          )
        );
      } else {
        toast.error(tShare("revokeError"));
      }
    } catch {
      toast.error(tShare("revokeError"));
    } finally {
      setRevokingId(null);
    }
  };

  const handleSendCreated = () => {
    fetchLinks().then((data) => {
      if (data) {
        setLinks(data.items);
        setNextCursor(data.nextCursor);
      }
    });
  };

  return {
    teamFilter,
    links,
    loading,
    loadingMore,
    nextCursor,
    statusFilter,
    setStatusFilter,
    typeFilter,
    setTypeFilter,
    sendDialogOpen,
    setSendDialogOpen,
    revokingId,
    expandedLogId,
    accessLogs,
    loadingLogs,
    logNextCursor,
    handleLoadMore,
    fetchAccessLogs,
    toggleAccessLogs,
    handleRevoke,
    handleSendCreated,
  };
}
