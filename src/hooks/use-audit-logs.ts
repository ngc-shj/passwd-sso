"use client";

import { useState, useEffect, useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { normalizeAuditActionKey } from "@/lib/audit/audit-action-key";
import { fetchApi } from "@/lib/url-helpers";
import { downloadBlob } from "@/lib/download-blob";
import { formatDateTime } from "@/lib/format-datetime";
import type { AuditActionValue } from "@/lib/constants";

// ---- Types ----

export interface AuditLogItem {
  id: string;
  action: string;
  actorType?: string;
  userId?: string | null;
  scope?: string;
  serviceAccountId?: string | null;
  serviceAccount?: { id: string; name: string } | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  userAgent?: string | null;
  createdAt: string;
  user?: { id: string; name: string | null; email: string | null; image?: string | null } | null;
  team?: { id: string; name: string } | null;
}

export interface ActionGroupDef {
  label: string;
  value: string;
  actions: readonly AuditActionValue[];
}

export interface UseAuditLogsConfig {
  fetchEndpoint: string;
  downloadEndpoint: string;
  downloadFilename: "audit-logs" | "team-audit-logs" | "tenant-audit-logs";
  actionGroups: readonly ActionGroupDef[];
  buildExtraParams?: () => URLSearchParams;
  resolveEntryNames?: (data: unknown) => Promise<Map<string, string>>;
  // Called on BOTH initial fetch AND handleLoadMore
  onDataReceived?: (data: unknown) => void;
}

export interface UseAuditLogsReturn {
  logs: AuditLogItem[];
  loading: boolean;
  loadingMore: boolean;
  nextCursor: string | null;
  entryNames: Map<string, string>;
  downloading: boolean;

  // Filter state
  selectedActions: Set<AuditActionValue>;
  actionSearch: string;
  dateFrom: string;
  dateTo: string;
  filterOpen: boolean;
  actorTypeFilter: string;

  // Filter setters
  setActionSearch: (v: string) => void;
  setDateFrom: (v: string) => void;
  setDateTo: (v: string) => void;
  setFilterOpen: (v: boolean) => void;
  setActorTypeFilter: (v: string) => void;
  toggleAction: (action: AuditActionValue, checked: boolean) => void;
  setGroupSelection: (actions: readonly AuditActionValue[], checked: boolean) => void;
  clearActions: () => void;

  // Derived
  actionSummary: string;
  filteredActions: (actions: readonly AuditActionValue[]) => readonly AuditActionValue[];
  actionLabel: (action: AuditActionValue | string) => string;
  isActionSelected: (action: AuditActionValue) => boolean;
  formatDate: (iso: string) => string;

  // Actions
  handleLoadMore: () => Promise<void>;
  handleDownload: (format: "jsonl" | "csv") => Promise<void>;
}

// ---- Hook ----

export function useAuditLogs(config: UseAuditLogsConfig): UseAuditLogsReturn {
  const t = useTranslations("AuditLog");
  const td = useTranslations("AuditDownload");
  const locale = useLocale();

  const [logs, setLogs] = useState<AuditLogItem[]>([]);
  const [entryNames, setEntryNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedActions, setSelectedActions] = useState<Set<AuditActionValue>>(new Set());
  const [actionSearch, setActionSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [actorTypeFilter, setActorTypeFilter] = useState<string>("ALL");

  const {
    fetchEndpoint,
    downloadEndpoint,
    downloadFilename,
    buildExtraParams,
    resolveEntryNames,
    onDataReceived,
  } = config;

  const buildFilterParams = useCallback(() => {
    const params = new URLSearchParams();
    if (selectedActions.size > 0) {
      params.set("actions", Array.from(selectedActions).join(","));
    }
    if (dateFrom) params.set("from", new Date(dateFrom).toISOString());
    if (dateTo) {
      const endOfDay = new Date(dateTo);
      endOfDay.setHours(23, 59, 59, 999);
      params.set("to", endOfDay.toISOString());
    }
    if (actorTypeFilter !== "ALL") params.set("actorType", actorTypeFilter);
    if (buildExtraParams) {
      const extra = buildExtraParams();
      extra.forEach((value, key) => params.set(key, value));
    }
    return params;
  }, [selectedActions, dateFrom, dateTo, actorTypeFilter, buildExtraParams]);

  const fetchLogs = useCallback(
    async (cursor?: string) => {
      const params = buildFilterParams();
      if (cursor) params.set("cursor", cursor);
      const res = await fetchApi(`${fetchEndpoint}?${params.toString()}`);
      if (!res.ok) return null;
      return res.json();
    },
    [buildFilterParams, fetchEndpoint],
  );

  useEffect(() => {
    let stale = false;
    setLoading(true);
    fetchLogs().then(async (data) => {
      if (stale) return;
      if (data) {
        setLogs(data.items ?? []);
        setNextCursor(data.nextCursor ?? null);
        if (resolveEntryNames) {
          const names = await resolveEntryNames(data);
          if (!stale) setEntryNames(names);
        }
        onDataReceived?.(data);
      }
      setLoading(false);
    });
    return () => { stale = true; };
  }, [fetchLogs, resolveEntryNames, onDataReceived]);

  const handleLoadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    const data = await fetchLogs(nextCursor);
    if (data) {
      setLogs((prev) => [...prev, ...(data.items ?? [])]);
      setNextCursor(data.nextCursor ?? null);
      if (resolveEntryNames) {
        const names = await resolveEntryNames(data);
        setEntryNames((prev) => new Map([...prev, ...names]));
      }
      onDataReceived?.(data);
    }
    setLoadingMore(false);
  }, [nextCursor, fetchLogs, resolveEntryNames, onDataReceived]);

  const handleDownload = useCallback(async (format: "jsonl" | "csv") => {
    setDownloading(true);
    try {
      const params = buildFilterParams();
      params.set("format", format);
      const res = await fetchApi(`${downloadEndpoint}?${params.toString()}`);
      if (!res.ok) {
        if (res.status === 429) {
          toast.error(td("rateLimited"));
        } else if (res.status === 400) {
          try {
            const body = await res.json();
            const details = body?.details ?? {};
            // Map known validation keys to i18n messages
            const msg =
              details.date ? td("dateRequired")
              : details.range ? td("maxRange")
              : td("downloadError");
            toast.error(msg);
          } catch {
            toast.error(td("downloadError"));
          }
        } else {
          toast.error(td("downloadError"));
        }
        return;
      }
      const ext = format === "csv" ? "csv" : "jsonl";
      await downloadBlob(res, `${downloadFilename}.${ext}`);
    } finally {
      setDownloading(false);
    }
  }, [buildFilterParams, downloadEndpoint, downloadFilename, td]);

  // ---- Filter helpers ----

  const actionLabel = useCallback((action: AuditActionValue | string) => {
    const key = normalizeAuditActionKey(String(action));
    return t.has(key as never) ? t(key as never) : String(action);
  }, [t]);

  const filteredActions = useCallback((actions: readonly AuditActionValue[]) => {
    if (!actionSearch) return actions;
    const q = actionSearch.toLowerCase();
    return actions.filter((a) => {
      const label = actionLabel(a).toLowerCase();
      return label.includes(q) || a.toLowerCase().includes(q);
    });
  }, [actionSearch, actionLabel]);

  const isActionSelected = useCallback(
    (action: AuditActionValue) => selectedActions.has(action),
    [selectedActions],
  );

  const toggleAction = useCallback((action: AuditActionValue, checked: boolean) => {
    setSelectedActions((prev) => {
      const next = new Set(prev);
      if (checked) next.add(action);
      else next.delete(action);
      return next;
    });
  }, []);

  const setGroupSelection = useCallback((actions: readonly AuditActionValue[], checked: boolean) => {
    setSelectedActions((prev) => {
      const next = new Set(prev);
      for (const action of actions) {
        if (checked) next.add(action);
        else next.delete(action);
      }
      return next;
    });
  }, []);

  const clearActions = useCallback(() => setSelectedActions(new Set()), []);

  const formatDate = useCallback((iso: string) => formatDateTime(iso, locale), [locale]);

  const selectedCount = selectedActions.size;
  const actionSummary =
    selectedCount === 0
      ? t("allActions")
      : selectedCount === 1
        ? actionLabel(Array.from(selectedActions)[0])
        : t("actionsSelected", { count: selectedCount });

  return {
    logs,
    loading,
    loadingMore,
    nextCursor,
    entryNames,
    downloading,
    selectedActions,
    actionSearch,
    dateFrom,
    dateTo,
    filterOpen,
    actorTypeFilter,
    setActionSearch,
    setDateFrom,
    setDateTo,
    setFilterOpen,
    setActorTypeFilter,
    toggleAction,
    setGroupSelection,
    clearActions,
    actionSummary,
    filteredActions,
    actionLabel,
    isActionSelected,
    formatDate,
    handleLoadMore,
    handleDownload,
  };
}
