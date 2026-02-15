"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  LogIn,
  LogOut,
  Plus,
  Archive,
  Pencil,
  Trash2,
  RotateCcw,
  Download,
  Upload,
  UserPlus,
  UserMinus,
  ShieldCheck,
  ShieldAlert,
  ShieldOff,
  ScrollText,
  Loader2,
  Link as LinkIcon,
  Link2Off,
  HeartPulse,
  KeyRound,
  Eye,
} from "lucide-react";
import { useVault } from "@/lib/vault-context";
import { decryptData, type EncryptedData } from "@/lib/crypto-client";
import { buildPersonalEntryAAD } from "@/lib/crypto-aad";
import {
  API_PATH,
  AUDIT_ACTION,
  AUDIT_ACTION_EMERGENCY_PREFIX,
  AUDIT_ACTION_GROUP,
  AUDIT_ACTION_GROUPS_PERSONAL,
  AUDIT_TARGET_TYPE,
  type AuditActionValue,
} from "@/lib/constants";
import { formatDateTime } from "@/lib/format-datetime";

interface AuditLogItem {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  user?: { id: string; name: string | null; email: string | null; image: string | null } | null;
}

type EntryOverviewMap = Record<
  string,
  { ciphertext: string; iv: string; authTag: string; aadVersion: number }
>;
type UserMap = Record<
  string,
  { id: string; name: string | null; email: string | null; image: string | null }
>;

const ACTION_ICONS: Partial<Record<AuditActionValue, React.ReactNode>> = {
  [AUDIT_ACTION.AUTH_LOGIN]: <LogIn className="h-4 w-4" />,
  [AUDIT_ACTION.AUTH_LOGOUT]: <LogOut className="h-4 w-4" />,
  [AUDIT_ACTION.ENTRY_BULK_TRASH]: <Trash2 className="h-4 w-4" />,
  [AUDIT_ACTION.ENTRY_EMPTY_TRASH]: <Trash2 className="h-4 w-4" />,
  [AUDIT_ACTION.ENTRY_BULK_ARCHIVE]: <Archive className="h-4 w-4" />,
  [AUDIT_ACTION.ENTRY_BULK_UNARCHIVE]: <RotateCcw className="h-4 w-4" />,
  [AUDIT_ACTION.ENTRY_BULK_RESTORE]: <RotateCcw className="h-4 w-4" />,
  [AUDIT_ACTION.ENTRY_IMPORT]: <Upload className="h-4 w-4" />,
  [AUDIT_ACTION.ENTRY_CREATE]: <Plus className="h-4 w-4" />,
  [AUDIT_ACTION.ENTRY_UPDATE]: <Pencil className="h-4 w-4" />,
  [AUDIT_ACTION.ENTRY_DELETE]: <Trash2 className="h-4 w-4" />,
  [AUDIT_ACTION.ENTRY_TRASH]: <Trash2 className="h-4 w-4" />,
  [AUDIT_ACTION.ENTRY_PERMANENT_DELETE]: <Trash2 className="h-4 w-4" />,
  [AUDIT_ACTION.ENTRY_RESTORE]: <RotateCcw className="h-4 w-4" />,
  [AUDIT_ACTION.ENTRY_EXPORT]: <Download className="h-4 w-4" />,
  [AUDIT_ACTION.ATTACHMENT_UPLOAD]: <Upload className="h-4 w-4" />,
  [AUDIT_ACTION.ATTACHMENT_DELETE]: <Trash2 className="h-4 w-4" />,
  [AUDIT_ACTION.ORG_MEMBER_INVITE]: <UserPlus className="h-4 w-4" />,
  [AUDIT_ACTION.ORG_MEMBER_REMOVE]: <UserMinus className="h-4 w-4" />,
  [AUDIT_ACTION.ORG_ROLE_UPDATE]: <ShieldCheck className="h-4 w-4" />,
  [AUDIT_ACTION.SHARE_CREATE]: <LinkIcon className="h-4 w-4" />,
  [AUDIT_ACTION.SHARE_REVOKE]: <Link2Off className="h-4 w-4" />,
  [AUDIT_ACTION.EMERGENCY_GRANT_CREATE]: <HeartPulse className="h-4 w-4" />,
  [AUDIT_ACTION.EMERGENCY_GRANT_ACCEPT]: <HeartPulse className="h-4 w-4" />,
  [AUDIT_ACTION.EMERGENCY_GRANT_REJECT]: <ShieldOff className="h-4 w-4" />,
  [AUDIT_ACTION.EMERGENCY_GRANT_CONFIRM]: <KeyRound className="h-4 w-4" />,
  [AUDIT_ACTION.EMERGENCY_ACCESS_REQUEST]: <ShieldAlert className="h-4 w-4" />,
  [AUDIT_ACTION.EMERGENCY_ACCESS_ACTIVATE]: <ShieldCheck className="h-4 w-4" />,
  [AUDIT_ACTION.EMERGENCY_ACCESS_REVOKE]: <ShieldOff className="h-4 w-4" />,
  [AUDIT_ACTION.EMERGENCY_VAULT_ACCESS]: <Eye className="h-4 w-4" />,
};

const ACTION_GROUPS = [
  { label: "groupAuth", value: AUDIT_ACTION_GROUP.AUTH, actions: AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.AUTH] },
  {
    label: "groupEntry",
    value: AUDIT_ACTION_GROUP.ENTRY,
    actions: AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.ENTRY],
  },
  {
    label: "groupBulk",
    value: AUDIT_ACTION_GROUP.BULK,
    actions: AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.BULK],
  },
  {
    label: "groupTransfer",
    value: AUDIT_ACTION_GROUP.TRANSFER,
    actions: AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.TRANSFER],
  },
  { label: "groupAttachment", value: AUDIT_ACTION_GROUP.ATTACHMENT, actions: AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.ATTACHMENT] },
  { label: "groupOrg", value: AUDIT_ACTION_GROUP.ORG, actions: AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.ORG] },
  { label: "groupShare", value: AUDIT_ACTION_GROUP.SHARE, actions: AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.SHARE] },
  {
    label: "groupEmergency",
    value: AUDIT_ACTION_GROUP.EMERGENCY,
    actions: AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.EMERGENCY],
  },
] as const;

export default function AuditLogsPage() {
  const t = useTranslations("AuditLog");
  const locale = useLocale();
  const { data: session } = useSession();
  const { encryptionKey } = useVault();
  const [logs, setLogs] = useState<AuditLogItem[]>([]);
  const [entryNames, setEntryNames] = useState<Map<string, string>>(new Map());
  const [relatedUsers, setRelatedUsers] = useState<UserMap>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedActions, setSelectedActions] = useState<Set<AuditActionValue>>(new Set());
  const [actionSearch, setActionSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const resolveEntryNames = useCallback(
    async (overviews: EntryOverviewMap) => {
      if (!encryptionKey || !session?.user?.id) return new Map<string, string>();
      const userId = session.user.id;
      const names = new Map<string, string>();
      for (const [id, ov] of Object.entries(overviews)) {
        try {
          const aad = ov.aadVersion >= 1 ? buildPersonalEntryAAD(userId, id) : undefined;
          const overview = JSON.parse(
            await decryptData(ov as EncryptedData, encryptionKey, aad)
          );
          names.set(id, overview.title);
        } catch {
          // Decryption failed — skip
        }
      }
      return names;
    },
    [encryptionKey, session?.user?.id]
  );

  const fetchLogs = useCallback(
    async (cursor?: string) => {
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
      if (cursor) params.set("cursor", cursor);

      const res = await fetch(`${API_PATH.AUDIT_LOGS}?${params.toString()}`);
      if (!res.ok) return null;
      return res.json();
    },
    [selectedActions, dateFrom, dateTo]
  );

  useEffect(() => {
    setLoading(true);
    fetchLogs().then(async (data) => {
      if (data) {
        setLogs(data.items);
        setNextCursor(data.nextCursor);
        if (data.entryOverviews) {
          const names = await resolveEntryNames(data.entryOverviews);
          setEntryNames(names);
        }
        if (data.relatedUsers) {
          setRelatedUsers(data.relatedUsers);
        }
      }
      setLoading(false);
    });
  }, [fetchLogs, resolveEntryNames]);

  const handleLoadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    const data = await fetchLogs(nextCursor);
      if (data) {
        setLogs((prev) => [...prev, ...data.items]);
        setNextCursor(data.nextCursor);
        if (data.entryOverviews) {
          const names = await resolveEntryNames(data.entryOverviews);
          setEntryNames((prev) => new Map([...prev, ...names]));
        }
        if (data.relatedUsers) {
          setRelatedUsers((prev) => ({ ...prev, ...data.relatedUsers }));
        }
      }
    setLoadingMore(false);
  };

  const formatDate = (iso: string) => formatDateTime(iso, locale);
  const formatUser = (user?: { name: string | null; email: string | null } | null) => {
    if (!user) return null;
    const name = user.name?.trim();
    if (name) return name;
    return user.email ?? null;
  };

  const formatViewer = (log: AuditLogItem) => {
    if (!log.user) return null;
    return formatUser(log.user);
  };

  const resolveUser = (id?: string, fallbackEmail?: string | null) => {
    if (id && relatedUsers[id]) {
      return formatUser(relatedUsers[id]);
    }
    if (fallbackEmail) return fallbackEmail;
    return null;
  };

  const getEmergencyDetail = (log: AuditLogItem): string | null => {
    const meta = log.metadata as { ownerId?: string; granteeId?: string; granteeEmail?: string; permanent?: boolean } | null;
    const owner = resolveUser(meta?.ownerId) ?? t("unknownUser");
    const grantee = resolveUser(meta?.granteeId, meta?.granteeEmail ?? null) ?? t("unknownUser");
    const viewer = formatViewer(log) ?? t("unknownUser");

    switch (log.action) {
      case AUDIT_ACTION.EMERGENCY_GRANT_CREATE:
        return t("eaGrantCreatedFor", { user: grantee });
      case AUDIT_ACTION.EMERGENCY_GRANT_ACCEPT:
        return t("eaGrantAcceptedBy", { viewer, owner });
      case AUDIT_ACTION.EMERGENCY_GRANT_REJECT:
        return t("eaGrantRejectedBy", { viewer, owner });
      case AUDIT_ACTION.EMERGENCY_GRANT_CONFIRM:
        return t("eaGrantConfirmedFor", { user: grantee });
      case AUDIT_ACTION.EMERGENCY_ACCESS_REQUEST:
        return t("eaAccessRequestedBy", { viewer, owner });
      case AUDIT_ACTION.EMERGENCY_ACCESS_ACTIVATE:
        return t("eaAccessActivatedFor", { user: meta?.granteeId ? grantee : owner });
      case AUDIT_ACTION.EMERGENCY_ACCESS_REVOKE:
        return t("eaAccessRevokedFor", { user: grantee });
      case AUDIT_ACTION.EMERGENCY_VAULT_ACCESS:
        return t("viewedByOwner", { viewer, owner });
      default:
        return null;
    }
  };

  const getTargetLabel = (log: AuditLogItem): string | null => {
    const meta =
      log.metadata && typeof log.metadata === "object"
        ? (log.metadata as Record<string, unknown>)
        : null;

    if (log.action === AUDIT_ACTION.ENTRY_BULK_TRASH && meta) {
      const requestedCount =
        typeof meta.requestedCount === "number" ? meta.requestedCount : 0;
      const movedCount =
        typeof meta.movedCount === "number" ? meta.movedCount : 0;
      const notMovedCount = Math.max(0, requestedCount - movedCount);
      return t("bulkTrashMeta", {
        requestedCount,
        movedCount,
        notMovedCount,
      });
    }

    if (log.action === AUDIT_ACTION.ENTRY_EMPTY_TRASH && meta) {
      const deletedCount =
        typeof meta.deletedCount === "number" ? meta.deletedCount : 0;
      return t("emptyTrashMeta", { deletedCount });
    }

    if (log.action === AUDIT_ACTION.ENTRY_BULK_ARCHIVE && meta) {
      const requestedCount =
        typeof meta.requestedCount === "number" ? meta.requestedCount : 0;
      const archivedCount =
        typeof meta.archivedCount === "number" ? meta.archivedCount : 0;
      const notArchivedCount = Math.max(0, requestedCount - archivedCount);
      return t("bulkArchiveMeta", {
        requestedCount,
        archivedCount,
        notArchivedCount,
      });
    }

    if (log.action === AUDIT_ACTION.ENTRY_BULK_UNARCHIVE && meta) {
      const requestedCount =
        typeof meta.requestedCount === "number" ? meta.requestedCount : 0;
      const unarchivedCount =
        typeof meta.unarchivedCount === "number" ? meta.unarchivedCount : 0;
      const alreadyActiveCount = Math.max(0, requestedCount - unarchivedCount);
      return t("bulkUnarchiveMeta", {
        requestedCount,
        unarchivedCount,
        alreadyActiveCount,
      });
    }

    if (log.action === AUDIT_ACTION.ENTRY_BULK_RESTORE && meta) {
      const requestedCount =
        typeof meta.requestedCount === "number" ? meta.requestedCount : 0;
      const restoredCount =
        typeof meta.restoredCount === "number" ? meta.restoredCount : 0;
      const notRestoredCount = Math.max(0, requestedCount - restoredCount);
      return t("bulkRestoreMeta", {
        requestedCount,
        restoredCount,
        notRestoredCount,
      });
    }

    if (log.action === AUDIT_ACTION.ENTRY_IMPORT && meta) {
      const requestedCount = typeof meta.requestedCount === "number" ? meta.requestedCount : 0;
      const successCount = typeof meta.successCount === "number" ? meta.successCount : 0;
      const failedCount = typeof meta.failedCount === "number" ? meta.failedCount : 0;
      const filename = typeof meta.filename === "string" ? meta.filename : "-";
      const format = typeof meta.format === "string" ? meta.format : "-";
      const encrypted = meta.encrypted === true;
      return t("importMeta", {
        requestedCount,
        successCount,
        failedCount,
        filename,
        format,
        encrypted: encrypted ? t("yes") : t("no"),
      });
    }

    if (log.action === AUDIT_ACTION.ENTRY_EXPORT && meta) {
      const filename = typeof meta.filename === "string" ? meta.filename : null;
      const encrypted = meta.encrypted === true;
      const includeOrgs = meta.includeOrgs === true;
      const format = typeof meta.format === "string" ? meta.format : "-";
      const entryCount = typeof meta.entryCount === "number" ? meta.entryCount : 0;
      return t("exportMeta", {
        filename: filename ?? "-",
        format,
        entryCount,
        encrypted: encrypted ? t("yes") : t("no"),
        orgs: includeOrgs ? t("included") : t("notIncluded"),
      });
    }

    const importFilename =
      log.action === AUDIT_ACTION.ENTRY_CREATE &&
      meta?.source === "import" &&
      typeof meta.filename === "string"
        ? meta.filename
        : null;
    const parentAction =
      typeof meta?.parentAction === "string" ? meta.parentAction : null;
    let parentActionText: string | null = null;
    if (parentAction) {
      let parentActionLabel = parentAction;
      try {
        parentActionLabel = t(parentAction as never);
      } catch {
        // fallback to action key when the translation does not exist
      }
      parentActionText = t("fromAction", { action: parentActionLabel });
    }

    // Entry operations: show resolved entry name
    if (
      log.targetType === AUDIT_TARGET_TYPE.PASSWORD_ENTRY &&
      log.targetId
    ) {
      const name = entryNames.get(log.targetId);
      if (name) {
        if (
          log.action === AUDIT_ACTION.ENTRY_PERMANENT_DELETE ||
          (log.action === AUDIT_ACTION.ENTRY_DELETE && meta?.permanent === true)
        ) {
          return `${name}（${t("permanentDelete")}）`;
        }
        const suffixParts = [
          importFilename ? t("fromFile", { filename: importFilename }) : null,
          parentActionText,
        ].filter(Boolean);
        return suffixParts.length > 0 ? `${name} ${suffixParts.join(" ")}` : name;
      }
      return t("deletedEntry");
    }

    // Attachment operations: show filename
    if (meta?.filename) {
      return String(meta.filename);
    }

    // Role updates: show role change
    if (log.action === AUDIT_ACTION.ORG_ROLE_UPDATE && meta?.previousRole && meta?.newRole) {
      return t("roleChange", {
        from: String(meta.previousRole),
        to: String(meta.newRole),
      });
    }

    return null;
  };

  const actionLabel = (action: AuditActionValue | string) => {
    try {
      return t(action as never);
    } catch {
      return String(action);
    }
  };
  const getActionLabel = (log: AuditLogItem) =>
    log.action === AUDIT_ACTION.ENTRY_BULK_TRASH
      ? t("ENTRY_BULK_TRASH")
      : log.action === AUDIT_ACTION.ENTRY_EMPTY_TRASH
        ? t("ENTRY_EMPTY_TRASH")
      : log.action === AUDIT_ACTION.ENTRY_BULK_ARCHIVE
        ? t("ENTRY_BULK_ARCHIVE")
        : log.action === AUDIT_ACTION.ENTRY_BULK_UNARCHIVE
          ? t("ENTRY_BULK_UNARCHIVE")
          : log.action === AUDIT_ACTION.ENTRY_BULK_RESTORE
            ? t("ENTRY_BULK_RESTORE")
            : log.action === AUDIT_ACTION.ENTRY_TRASH
              ? t("ENTRY_TRASH")
              : log.action === AUDIT_ACTION.ENTRY_PERMANENT_DELETE
                ? t("ENTRY_PERMANENT_DELETE")
        : actionLabel(log.action);

  const filteredActions = (actions: readonly AuditActionValue[]) => {
    if (!actionSearch) return actions;
    const q = actionSearch.toLowerCase();
    return actions.filter((a) => {
      const label = actionLabel(a).toLowerCase();
      return label.includes(q) || a.toLowerCase().includes(q);
    });
  };

  const isActionSelected = (action: AuditActionValue) => selectedActions.has(action);

  const toggleAction = (action: AuditActionValue, checked: boolean) => {
    setSelectedActions((prev) => {
      const next = new Set(prev);
      if (checked) next.add(action);
      else next.delete(action);
      return next;
    });
  };

  const setGroupSelection = (actions: readonly AuditActionValue[], checked: boolean) => {
    setSelectedActions((prev) => {
      const next = new Set(prev);
      for (const action of actions) {
        if (checked) next.add(action);
        else next.delete(action);
      }
      return next;
    });
  };

  const clearActions = () => setSelectedActions(new Set());

  const selectedCount = selectedActions.size;
  const actionSummary =
    selectedCount === 0
      ? t("allActions")
      : selectedCount === 1
        ? actionLabel(Array.from(selectedActions)[0])
        : t("actionsSelected", { count: selectedCount });

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6">
      <div className="mx-auto max-w-4xl space-y-6">
      <Card className="rounded-xl border bg-gradient-to-b from-muted/30 to-background p-4">
        <div className="flex items-center gap-3">
          <ScrollText className="h-6 w-6" />
          <div>
            <h1 className="text-2xl font-bold">{t("title")}</h1>
            <p className="text-sm text-muted-foreground">{t("description")}</p>
          </div>
        </div>
      </Card>

      <Card className="rounded-xl border bg-card/80 p-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="space-y-1">
            <Label className="text-xs">{t("action")}</Label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="w-[240px] justify-between">
                  <span className="truncate">{actionSummary}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-[280px] p-2" align="start">
                <div className="px-2 pb-2">
                  <Input
                    placeholder={t("actionSearch")}
                    value={actionSearch}
                    onChange={(e) => setActionSearch(e.target.value)}
                  />
                </div>
                <DropdownMenuCheckboxItem
                  checked={selectedActions.size === 0}
                  onCheckedChange={() => clearActions()}
                >
                  {t("allActions")}
                </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
                {ACTION_GROUPS.map((group) => {
                  const actions = filteredActions(group.actions);
                  if (actions.length === 0) return null;
                  const allSelected = group.actions.every((a) => selectedActions.has(a));
                  return (
                    <div key={group.value}>
                      <DropdownMenuLabel className="px-2 pt-2 text-xs">
                        {t(group.label as never)}
                      </DropdownMenuLabel>
                      <DropdownMenuCheckboxItem
                        checked={allSelected}
                        onCheckedChange={(checked) => setGroupSelection(group.actions, !!checked)}
                        className="font-medium"
                      >
                        {t("selectGroup")}
                      </DropdownMenuCheckboxItem>
                      {actions.map((action) => (
                        <DropdownMenuCheckboxItem
                          key={action}
                          checked={isActionSelected(action)}
                          onCheckedChange={(checked) => toggleAction(action, !!checked)}
                          className="pl-6"
                        >
                          {actionLabel(action)}
                        </DropdownMenuCheckboxItem>
                      ))}
                    </div>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("dateFrom")}</Label>
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-[160px]"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("dateTo")}</Label>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-[160px]"
            />
          </div>
        </div>
      </Card>

      {loading ? (
        <Card className="rounded-xl border bg-card/80 p-10">
          <div className="flex justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </Card>
      ) : logs.length === 0 ? (
        <Card className="rounded-xl border bg-card/80 p-10">
          <p className="text-center text-muted-foreground">{t("noLogs")}</p>
        </Card>
      ) : (
        <>
          <Card className="rounded-xl border bg-card/80 divide-y">
            {logs.map((log) => {
              const targetLabel = getTargetLabel(log);
              return (
                <div key={log.id} className="px-4 py-3 flex items-start gap-3 transition-colors hover:bg-accent">
                  <div className="shrink-0 text-muted-foreground mt-0.5">
                    {ACTION_ICONS[log.action as AuditActionValue] ?? <ScrollText className="h-4 w-4" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{getActionLabel(log)}</p>
                    {targetLabel && (
                      <p className="text-xs text-muted-foreground truncate">
                        {targetLabel}
                      </p>
                    )}
                    {log.action.startsWith(AUDIT_ACTION_EMERGENCY_PREFIX) && (() => {
                      const detail = getEmergencyDetail(log);
                      return detail ? (
                        <p className="text-xs text-muted-foreground">{detail}</p>
                      ) : null;
                    })()}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs text-muted-foreground whitespace-nowrap">
                      {formatDate(log.createdAt)}
                    </p>
                    {log.ip && (
                      <p className="text-xs text-muted-foreground">{log.ip}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </Card>

          {nextCursor && (
            <div className="flex justify-center pt-4">
              <Button
                variant="outline"
                onClick={handleLoadMore}
                disabled={loadingMore}
              >
                {loadingMore && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
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
