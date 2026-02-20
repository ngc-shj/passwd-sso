"use client";

import { useState, useEffect, useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
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
  User,
  ChevronDown,
  ChevronUp,
  MessageSquare,
  Paperclip,
  Send,
} from "lucide-react";
import { toast } from "sonner";
import { API_PATH, apiPath, ENTRY_TYPE } from "@/lib/constants";
import { formatDateTime } from "@/lib/format-datetime";
import { formatFileSize } from "@/lib/format-file-size";
import { SendDialog } from "@/components/share/send-dialog";

interface ShareLinkItem {
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
  orgPasswordEntryId: string | null;
  orgName: string | null;
  hasPersonalEntry: boolean;
  sharedBy: string | null;
  canRevoke: boolean;
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
  const locale = useLocale();
  const searchParams = useSearchParams();
  const orgFilter = searchParams.get("org");
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
  const [accessLogs, setAccessLogs] = useState<
    { id: string; ip: string | null; userAgent: string | null; createdAt: string }[]
  >([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [logNextCursor, setLogNextCursor] = useState<string | null>(null);

  // Sync typeFilter when navigating via sidebar links (?type=send / ?type=entry)
  useEffect(() => {
    const next = typeParam === "send" || typeParam === "entry" ? typeParam : "all";
    setTypeFilter(next);
  }, [typeParam]);

  const fetchLinks = useCallback(
    async (cursor?: string) => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (typeFilter !== "all") params.set("shareType", typeFilter);
      if (orgFilter) params.set("org", orgFilter);
      if (cursor) params.set("cursor", cursor);

      const res = await fetch(`${API_PATH.SHARE_LINKS_MINE}?${params.toString()}`);
      if (!res.ok) return null;
      return res.json();
    },
    [statusFilter, typeFilter, orgFilter]
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

  const formatDate = (iso: string) => formatDateTime(iso, locale);

  const getStatusBadge = (link: ShareLinkItem) => {
    if (link.isActive) {
      return (
        <Badge
          variant="outline"
          className="text-xs border-green-500 text-green-600 dark:text-green-400"
        >
          {t("active")}
        </Badge>
      );
    }
    if (link.revokedAt) {
      return (
        <Badge variant="destructive" className="text-xs">
          {tShare("revoked")}
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
      <Badge variant="secondary" className="text-xs">
        {tShare("expired")}
      </Badge>
    );
  };

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6">
      <div className="mx-auto max-w-4xl space-y-6">
      <Card className="rounded-xl border bg-gradient-to-b from-muted/30 to-background p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <LinkIcon className="h-6 w-6" />
            <div>
              <h1 className="text-2xl font-bold">{t("title")}</h1>
              <p className="text-sm text-muted-foreground">{t("description")}</p>
            </div>
          </div>
          {!orgFilter && (
            <Button onClick={() => setSendDialogOpen(true)} className="shrink-0">
              <Send className="h-4 w-4 mr-2" />
              {t("newSend")}
            </Button>
          )}
        </div>
      </Card>

      <SendDialog
        open={sendDialogOpen}
        onOpenChange={setSendDialogOpen}
        onCreated={() => {
          fetchLinks().then((data) => {
            if (data) {
              setLinks(data.items);
              setNextCursor(data.nextCursor);
            }
          });
        }}
      />

      <Card className="rounded-xl border bg-card/80 p-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="space-y-1">
            <Label className="text-xs">{t("typeFilter")}</Label>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("allTypes")}</SelectItem>
                <SelectItem value="entry">{t("entryShares")}</SelectItem>
                {!orgFilter && (
                  <SelectItem value="send">{t("sends")}</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
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
      </Card>

      {loading ? (
        <Card className="rounded-xl border bg-card/80 p-10">
          <div className="flex justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </Card>
      ) : links.length === 0 ? (
        <Card className="rounded-xl border bg-card/80 p-10">
          <p className="text-center text-muted-foreground">{t("noLinks")}</p>
        </Card>
      ) : (
        <>
          <Card className="rounded-xl border bg-card/80 divide-y">
            {links.map((link) => (
              <div key={link.id} className="transition-colors hover:bg-accent">
                <div className="px-4 py-3 flex items-start gap-3">
                  <div className="shrink-0 mt-0.5">
                    {link.isActive ? (
                      <LinkIcon className="h-5 w-5 text-green-500" />
                    ) : (
                      <Link2Off className="h-5 w-5 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      {getStatusBadge(link)}
                      {link.shareType === "TEXT" ? (
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <MessageSquare className="h-3.5 w-3.5" />
                          {link.sendName ?? t("textSend")}
                        </span>
                      ) : link.shareType === "FILE" ? (
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Paperclip className="h-3.5 w-3.5" />
                          {link.sendFilename ?? link.sendName ?? t("fileSend")}
                          {link.sendSizeBytes != null && (
                            <span className="ml-1">
                              ({formatFileSize(link.sendSizeBytes)})
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          {link.entryType && ENTRY_TYPE_ICONS[link.entryType]}
                          {link.entryType}
                        </span>
                      )}
                      {link.sharedBy && (
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <User className="h-3 w-3" />
                          {t("sharedBy", { name: link.sharedBy })}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                      {link.shareType === "ENTRY_SHARE" && link.hasPersonalEntry ? (
                        <span className="text-muted-foreground italic">
                          {t("personalEntry")}
                        </span>
                      ) : link.shareType === "ENTRY_SHARE" && !link.orgPasswordEntryId ? (
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
                <div className="shrink-0 flex items-center gap-1.5">
                  <span className="hidden whitespace-nowrap text-xs text-muted-foreground sm:block">
                    {formatDate(link.createdAt)}
                  </span>
                  {link.viewCount > 0 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 rounded-lg"
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
                  {link.isActive && link.canRevoke && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 rounded-lg text-destructive hover:text-destructive"
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
                    <div className="space-y-2 rounded-lg border bg-background/80 p-3">
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
                                className="flex items-center justify-between rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
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
    </div>
  );
}
