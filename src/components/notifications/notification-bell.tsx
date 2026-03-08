"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatRelativeTime } from "@/lib/format-datetime";
import { API_PATH, apiPath } from "@/lib/constants";
import type { NotificationType } from "@prisma/client";
import { fetchApi } from "@/lib/url-helpers";

interface NotificationItem {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  metadata: unknown;
  isRead: boolean;
  createdAt: string;
}

const POLL_INTERVAL_MS = 60_000;
const PAGE_LIMIT = 10;

/** Resolve notification body using i18n when a translation key exists for the type */
function resolveNotificationBody(
  n: NotificationItem,
  t: ReturnType<typeof useTranslations<"Notifications">>,
): string {
  const bodyKey = `body_${n.type}` as Parameters<typeof t>[0];
  if (!t.has(bodyKey)) return n.body;
  const meta = (n.metadata && typeof n.metadata === "object" ? n.metadata : {}) as Record<string, unknown>;
  return t(bodyKey, {
    count: String(meta.evictedCount ?? 0),
    max: String(meta.maxConcurrentSessions ?? "?"),
  });
}

export function NotificationBell() {
  const t = useTranslations("Notifications");
  const locale = useLocale();
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const fetchUnreadCount = useCallback(async () => {
    try {
      const res = await fetchApi(API_PATH.NOTIFICATIONS_COUNT);
      if (res.ok) {
        const data = await res.json();
        setUnreadCount(data.unreadCount);
      }
    } catch {
      // Silently ignore polling errors
    }
  }, []);

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchApi(
        `${API_PATH.NOTIFICATIONS}?limit=${PAGE_LIMIT}`,
      );
      if (res.ok) {
        const data = await res.json();
        setNotifications(data.items);
      }
    } catch {
      // Silently ignore
    } finally {
      setLoading(false);
    }
  }, []);

  // Poll unread count (pause when tab is hidden)
  useEffect(() => {
    fetchUnreadCount();
    let id: ReturnType<typeof setInterval> | null = setInterval(fetchUnreadCount, POLL_INTERVAL_MS);

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        fetchUnreadCount();
        if (!id) id = setInterval(fetchUnreadCount, POLL_INTERVAL_MS);
      } else {
        if (id) { clearInterval(id); id = null; }
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      if (id) clearInterval(id);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [fetchUnreadCount]);

  // Fetch list when dropdown opens
  useEffect(() => {
    if (open) {
      fetchNotifications();
    }
  }, [open, fetchNotifications]);

  const markAllAsRead = useCallback(async () => {
    try {
      const res = await fetchApi(API_PATH.NOTIFICATIONS, { method: "PATCH" });
      if (res.ok) {
        setUnreadCount(0);
        setNotifications((prev) =>
          prev.map((n) => ({ ...n, isRead: true })),
        );
      }
    } catch {
      // Silently ignore
    }
  }, []);

  const markAsRead = useCallback(async (id: string) => {
    try {
      const res = await fetchApi(apiPath.notificationById(id), {
        method: "PATCH",
      });
      if (res.ok) {
        setUnreadCount((c) => Math.max(0, c - 1));
        setNotifications((prev) =>
          prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)),
        );
      }
    } catch {
      // Silently ignore
    }
  }, []);

  const deleteNotification = useCallback(async (id: string) => {
    try {
      const res = await fetchApi(apiPath.notificationById(id), {
        method: "DELETE",
      });
      if (res.ok) {
        setNotifications((prev) => {
          const removed = prev.find((n) => n.id === id);
          if (removed && !removed.isRead) {
            setUnreadCount((c) => Math.max(0, c - 1));
          }
          return prev.filter((n) => n.id !== id);
        });
      }
    } catch {
      // Silently ignore
    }
  }, []);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={t("label")}
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>{t("title")}</span>
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                markAllAsRead();
              }}
              className="text-xs font-normal text-muted-foreground hover:text-foreground"
            >
              {t("markAllAsRead")}
            </button>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {loading && notifications.length === 0 ? (
          <div className="px-2 py-4 text-center text-sm text-muted-foreground">
            {t("loading")}
          </div>
        ) : notifications.length === 0 ? (
          <div className="px-2 py-4 text-center text-sm text-muted-foreground">
            {t("noNotifications")}
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto">
            {notifications.map((n) => (
              <DropdownMenuItem
                key={n.id}
                className="flex flex-col items-start gap-1 px-3 py-2"
                onSelect={(e) => {
                  e.preventDefault();
                  if (!n.isRead) markAsRead(n.id);
                }}
              >
                <div className="flex w-full items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {!n.isRead && (
                      <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary" />
                    )}
                    <span className="text-sm font-medium">
                      {t.has(`type_${n.type}`) ? t(`type_${n.type}`) : n.title}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteNotification(n.id);
                    }}
                    className="shrink-0 text-xs text-muted-foreground hover:text-destructive"
                  >
                    {t("delete")}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground line-clamp-2">
                  {resolveNotificationBody(n, t)}
                </p>
                <span className="text-[10px] text-muted-foreground">
                  {formatRelativeTime(n.createdAt, locale)}
                </span>
              </DropdownMenuItem>
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
