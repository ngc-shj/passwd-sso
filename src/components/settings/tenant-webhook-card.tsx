"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useLocale } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { CopyButton } from "@/components/passwords/copy-button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ChevronDown, Loader2, Plus, Trash2, Webhook } from "lucide-react";
import { toast } from "sonner";
import { apiPath } from "@/lib/constants";
import {
  AUDIT_ACTION_GROUP,
  AUDIT_ACTION_GROUPS_TENANT,
  TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS,
} from "@/lib/constants/audit";
import { formatDateTime } from "@/lib/format-datetime";
import { fetchApi } from "@/lib/url-helpers";

interface WebhookItem {
  id: string;
  url: string;
  events: string[];
  isActive: boolean;
  failCount: number;
  lastDeliveredAt: string | null;
  lastFailedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

const MAX_WEBHOOKS = 5;

/**
 * Event groups available for tenant webhook subscription.
 * Excludes group:tenantWebhook to prevent self-referential triggers
 * and filters each group's actions to only subscribable ones.
 */
const subscribableSet = new Set<string>(TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS);

const EVENT_GROUPS = Object.entries(AUDIT_ACTION_GROUPS_TENANT)
  .filter(([key]) => key !== AUDIT_ACTION_GROUP.TENANT_WEBHOOK)
  .map(([key, actions]) => ({
    key,
    actions: actions.filter((a) => subscribableSet.has(a)),
  }))
  .filter(({ actions }) => actions.length > 0);

export function TenantWebhookCard() {
  const t = useTranslations("TenantWebhook");
  const tCommon = useTranslations("Common");
  const tAudit = useTranslations("AuditLog");
  const locale = useLocale();

  const [webhooks, setWebhooks] = useState<WebhookItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [url, setUrl] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<Set<string>>(new Set());
  const [newSecret, setNewSecret] = useState<string | null>(null);

  const fetchWebhooks = useCallback(async () => {
    try {
      const res = await fetchApi(apiPath.tenantWebhooks());
      if (res.ok) {
        const data = await res.json();
        setWebhooks(data.webhooks ?? []);
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWebhooks();
  }, [fetchWebhooks]);

  const [urlError, setUrlError] = useState("");

  const validateUrl = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return t("urlRequired");
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "https:") return t("urlHttpsRequired");
    } catch {
      return t("urlInvalid");
    }
    return null;
  };

  const handleCreate = async () => {
    const urlValidationError = validateUrl(url);
    if (urlValidationError) {
      setUrlError(urlValidationError);
      return;
    }

    setCreating(true);
    setUrlError("");
    try {
      const res = await fetchApi(apiPath.tenantWebhooks(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          events: Array.from(selectedEvents),
        }),
      });
      if (res.status === 400) {
        const data = await res.json().catch(() => null);
        if (data?.details?.fieldErrors?.url?.length) {
          setUrlError(t("urlInvalid"));
        } else {
          toast.error(t("validationError"));
        }
        return;
      }
      if (!res.ok) {
        toast.error(t("createFailed"));
        return;
      }
      const data = await res.json();
      setNewSecret(data.secret);
      setUrl("");
      setSelectedEvents(new Set());
      toast.success(t("created"));
      fetchWebhooks();
    } catch {
      toast.error(t("createFailed"));
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (webhookId: string) => {
    try {
      const res = await fetchApi(apiPath.tenantWebhookById(webhookId), {
        method: "DELETE",
      });
      if (res.ok) {
        toast.success(t("deleted"));
        fetchWebhooks();
      } else {
        toast.error(t("deleteFailed"));
      }
    } catch {
      toast.error(t("deleteFailed"));
    }
  };

  const toggleEvent = (action: string, checked: boolean) => {
    setSelectedEvents((prev) => {
      const next = new Set(prev);
      if (checked) next.add(action);
      else next.delete(action);
      return next;
    });
  };

  const toggleGroup = (actions: string[], checked: boolean) => {
    setSelectedEvents((prev) => {
      const next = new Set(prev);
      for (const a of actions) {
        if (checked) next.add(a);
        else next.delete(a);
      }
      return next;
    });
  };

  const groupLabel = (key: string) => {
    const map: Record<string, string> = {
      [AUDIT_ACTION_GROUP.ADMIN]: "groupAdmin",
      [AUDIT_ACTION_GROUP.SCIM]: "groupScim",
      [AUDIT_ACTION_GROUP.DIRECTORY_SYNC]: "groupDirectorySync",
      [AUDIT_ACTION_GROUP.BREAKGLASS]: "groupBreakglass",
    };
    return tAudit(map[key] ?? key);
  };

  const limitReached = webhooks.length >= MAX_WEBHOOKS;

  const activeWebhooks = webhooks.filter((w) => w.isActive);
  const inactiveWebhooks = webhooks.filter((w) => !w.isActive);
  const [showInactive, setShowInactive] = useState(false);

  // Auto-expand inactive section when limit is reached so users can delete inactive webhooks
  useEffect(() => {
    if (limitReached && inactiveWebhooks.length > 0) {
      setShowInactive(true);
    }
  }, [limitReached, inactiveWebhooks.length]);

  const renderWebhookItem = (w: WebhookItem) => (
    <div
      key={w.id}
      className="flex items-center justify-between border rounded-md p-3"
    >
      <div className="space-y-1 min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">
            {w.url}
          </span>
          <Badge
            variant={w.isActive ? "default" : "destructive"}
            className="shrink-0"
          >
            {w.isActive ? t("active") : t("inactive")}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-1 mt-1">
          {w.events.map((e) => (
            <Badge key={e} variant="outline" className="text-xs font-normal">
              {tAudit(e)}
            </Badge>
          ))}
        </div>
        <div className="text-xs text-muted-foreground space-x-3">
          {w.failCount > 0 && (
            <span className="text-amber-600 dark:text-amber-400">
              {t("failCount", { count: w.failCount })}
            </span>
          )}
          {w.lastDeliveredAt && (
            <span>
              {t("lastDelivered")}: {formatDateTime(w.lastDeliveredAt, locale)}
            </span>
          )}
        </div>
      </div>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConfirm")}</AlertDialogTitle>
            <AlertDialogDescription>
              {w.url}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => handleDelete(w.id)}>
              {tCommon("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );

  return (
    <Card className="p-6 space-y-6">
      {/* Header */}
      <section>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Webhook className="h-5 w-5 text-muted-foreground" />
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t("description")}
        </p>
      </section>

      {/* Create webhook form (fixed) */}
      <section className="space-y-3 border-t pt-4">
        <h3 className="text-sm font-medium">{t("addWebhook")}</h3>

        {limitReached ? (
          <p className="text-sm text-muted-foreground">{t("limitReached")}</p>
        ) : (
          <>
            <div className="space-y-2">
              <Label>{t("url")}</Label>
              <Input
                type="url"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setUrlError("");
                }}
                placeholder={t("urlPlaceholder")}
              />
              {urlError && (
                <p className="text-sm text-destructive">{urlError}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label>{t("events")}</Label>
              <div className="max-h-64 overflow-y-auto border rounded-md p-3 space-y-1">
                {EVENT_GROUPS.map(({ key, actions }) => (
                  <Collapsible key={key}>
                    <div className="flex items-center gap-2 py-1">
                      <Checkbox
                        checked={actions.every((a) => selectedEvents.has(a))}
                        onCheckedChange={(checked) =>
                          toggleGroup(actions, !!checked)
                        }
                      />
                      <CollapsibleTrigger className="flex items-center gap-1 text-sm font-medium hover:underline">
                        {groupLabel(key)}
                        <ChevronDown className="h-3.5 w-3.5" />
                      </CollapsibleTrigger>
                    </div>
                    <CollapsibleContent className="pl-6 space-y-1">
                      {actions.map((action) => (
                        <label
                          key={action}
                          className="flex items-center gap-2 text-sm py-0.5"
                        >
                          <Checkbox
                            checked={selectedEvents.has(action)}
                            onCheckedChange={(checked) =>
                              toggleEvent(action, !!checked)
                            }
                          />
                          {tAudit(action)}
                        </label>
                      ))}
                    </CollapsibleContent>
                  </Collapsible>
                ))}
              </div>
            </div>

            <Button
              onClick={handleCreate}
              disabled={creating || !url.trim() || selectedEvents.size === 0}
              size="sm"
            >
              {creating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              {t("addWebhook")}
            </Button>
          </>
        )}
      </section>

      {/* Secret display (shown once after creation) */}
      {newSecret && (
        <section className="border rounded-md p-4 bg-muted/50 space-y-2">
          <p className="text-sm font-medium">{t("secret")}</p>
          <div className="flex items-center gap-2">
            <Input
              value={newSecret}
              readOnly
              autoComplete="off"
              className="font-mono text-xs"
            />
            <CopyButton getValue={() => newSecret} />
          </div>
          <p className="text-xs text-muted-foreground">{t("secretCopied")}</p>
          <Button variant="ghost" size="sm" onClick={() => setNewSecret(null)}>
            OK
          </Button>
        </section>
      )}

      {/* Webhook list (dynamic) */}
      <section className="space-y-3 border-t pt-4">
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : webhooks.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noWebhooks")}</p>
        ) : (
          <div className="max-h-80 space-y-3 overflow-y-auto">
            {activeWebhooks.length === 0 && inactiveWebhooks.length > 0 && (
              <p className="text-sm text-muted-foreground">{t("noActiveWebhooks")}</p>
            )}
            {activeWebhooks.map(renderWebhookItem)}
            {inactiveWebhooks.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setShowInactive((v) => !v)}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ChevronDown
                    className={`h-3 w-3 transition-transform ${showInactive ? "rotate-0" : "-rotate-90"}`}
                  />
                  {t("inactiveWebhooks", { count: inactiveWebhooks.length })}
                </button>
                {showInactive && (
                  <div className="mt-2 space-y-3">
                    {inactiveWebhooks.map(renderWebhookItem)}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </section>
    </Card>
  );
}
