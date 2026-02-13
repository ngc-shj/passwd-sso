"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import {
  Link as LinkIcon,
  Link2Off,
  Loader2,
  Trash2,
  Eye,
  Clock,
  KeyRound,
  FileText,
  CreditCard,
  IdCard,
  Building2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { toast } from "sonner";
import { API_PATH, apiPath, ENTRY_TYPE } from "@/lib/constants";

interface ShareLinkItem {
  id: string;
  entryType: string;
  expiresAt: string;
  maxViews: number | null;
  viewCount: number;
  revokedAt: string | null;
  createdAt: string;
  passwordEntryId: string | null;
  orgPasswordEntryId: string | null;
  orgName: string | null;
  hasPersonalEntry: boolean;
  isActive: boolean;
}

const ENTRY_TYPE_ICONS: Record<string, React.ReactNode> = {
  [ENTRY_TYPE.LOGIN]: <KeyRound className="h-4 w-4" />,
  [ENTRY_TYPE.SECURE_NOTE]: <FileText className="h-4 w-4" />,
  [ENTRY_TYPE.CREDIT_CARD]: <CreditCard className="h-4 w-4" />,
  [ENTRY_TYPE.IDENTITY]: <IdCard className="h-4 w-4" />,
};

export default function ShareLinksPage() {
  const t = useTranslations("ShareLinks");
  const tShare = useTranslations("Share");
  const [links, setLinks] = useState<ShareLinkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [accessLogs, setAccessLogs] = useState<
    { id: string; ip: string | null; userAgent: string | null; createdAt: string }[]
  >([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [logNextCursor, setLogNextCursor] = useState<string | null>(null);

  const fetchLinks = useCallback(
    async (cursor?: string) => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (cursor) params.set("cursor", cursor);

      const res = await fetch(`${API_PATH.SHARE_LINKS_MINE}?${params.toString()}`);
      if (!res.ok) return null;
      return res.json();
    },
    [statusFilter]
  );

  useEffect(() => {
    setLoading(true);
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
        const res = await fetch(url);
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
      const res = await fetch(apiPath.shareLinkById(id), { method: "DELETE" });
      if (res.ok) {
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

  const formatDate = (iso: string) => new Date(iso).toLocaleString();

  const getStatusBadge = (link: ShareLinkItem) => {
    if (link.revokedAt) {
      return (
        <Badge variant="destructive" className="text-xs">
          {tShare("revoked")}
        </Badge>
      );
    }
    if (new Date(link.expiresAt) <= new Date()) {
      return (
        <Badge variant="secondary" className="text-xs">
          {tShare("expired")}
        </Badge>
      );
    }
    if (link.maxViews !== null && link.viewCount >= link.maxViews) {
      return (
        <Badge variant="secondary" className="text-xs">
          {t("maxViewsReached")}
        </Badge>
      );
    }
    return (
      <Badge
        variant="outline"
        className="text-xs border-green-500 text-green-600 dark:text-green-400"
      >
        {t("active")}
      </Badge>
    );
  };

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6 space-y-6">
      <div className="flex items-center gap-3">
        <LinkIcon className="h-6 w-6" />
        <div>
          <h1 className="text-2xl font-bold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <div className="space-y-1">
          <Label className="text-xs">{t("status")}</Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("allStatuses")}</SelectItem>
              <SelectItem value="active">{t("active")}</SelectItem>
              <SelectItem value="expired">{tShare("expired")}</SelectItem>
              <SelectItem value="revoked">{tShare("revoked")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : links.length === 0 ? (
        <p className="text-center text-muted-foreground py-12">
          {t("noLinks")}
        </p>
      ) : (
        <>
        <Card className="divide-y">
          {links.map((link) => (
            <div key={link.id}>
              <div className="px-4 py-2 flex items-start gap-3">
                <div className="shrink-0 mt-0.5">
                  {link.isActive ? (
                    <LinkIcon className="h-5 w-5 text-green-500" />
                  ) : (
                    <Link2Off className="h-5 w-5 text-muted-foreground" />
                  )}
                </div>
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    {getStatusBadge(link)}
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      {ENTRY_TYPE_ICONS[link.entryType]}
                      {link.entryType}
                    </span>
                    {link.orgName && (
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Building2 className="h-3 w-3" />
                        {link.orgName}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                    {link.hasPersonalEntry ? (
                      <span className="text-muted-foreground italic">
                        {t("personalEntry")}
                      </span>
                    ) : !link.orgPasswordEntryId ? (
                      <span className="text-muted-foreground italic">
                        {t("deletedEntry")}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Eye className="h-3 w-3" />
                      {link.maxViews
                        ? tShare("viewCount", {
                            current: link.viewCount,
                            max: link.maxViews,
                          })
                        : `${link.viewCount} ${tShare("views")}`}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {formatDate(link.expiresAt)}
                    </span>
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-2">
                  <span className="text-xs text-muted-foreground hidden sm:block whitespace-nowrap">
                    {formatDate(link.createdAt)}
                  </span>
                  {link.viewCount > 0 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => toggleAccessLogs(link.id)}
                      title={tShare("accessLogs")}
                    >
                      {expandedLogId === link.id ? (
                        <ChevronUp className="h-4 w-4" />
                      ) : (
                        <ChevronDown className="h-4 w-4" />
                      )}
                    </Button>
                  )}
                  {link.isActive && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => handleRevoke(link.id)}
                      disabled={revokingId === link.id}
                      title={tShare("revoked")}
                    >
                      {revokingId === link.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
                  )}
                </div>
              </div>
              {/* Access logs */}
              {expandedLogId === link.id && (
                <div className="px-4 pb-3 pl-12">
                  <div className="rounded-md border p-3 space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      {tShare("accessLogs")}
                    </p>
                    {loadingLogs && accessLogs.length === 0 ? (
                      <div className="flex justify-center py-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                      </div>
                    ) : accessLogs.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        {tShare("noAccessLogs")}
                      </p>
                    ) : (
                      <>
                        <div className="space-y-1">
                          {accessLogs.map((log) => (
                            <div
                              key={log.id}
                              className="flex items-center justify-between text-xs text-muted-foreground"
                            >
                              <span>{formatDate(log.createdAt)}</span>
                              <span className="font-mono">{log.ip ?? "-"}</span>
                            </div>
                          ))}
                        </div>
                        {logNextCursor && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="w-full h-7 text-xs"
                            onClick={() => fetchAccessLogs(link.id, logNextCursor)}
                            disabled={loadingLogs}
                          >
                            {loadingLogs ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              tShare("loadMoreLogs")
                            )}
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}

        </Card>

            {nextCursor && (
              <div className="flex justify-center pt-4">
                <Button
                  variant="outline"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                >
                  {loadingMore && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  {t("loadMore")}
                </Button>
              </div>
            )}
          </>
      )}
    </div>
  );
}
