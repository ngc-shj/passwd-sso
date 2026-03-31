"use client";

import { useEffect, useState, useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SectionCardHeader } from "@/components/settings/section-card-header";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { FolderSync, Loader2, Play, Plus, ScrollText, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { fetchApi } from "@/lib/url-helpers";
import { NAME_MAX_LENGTH } from "@/lib/validations";
import { apiPath, API_PATH } from "@/lib/constants";
import { formatDateTime, formatRelativeTime } from "@/lib/format-datetime";

// ─── Types ───────────────────────────────────────────────────

interface DirectorySyncConfig {
  id: string;
  provider: string;
  displayName: string;
  enabled: boolean;
  syncIntervalMinutes: number;
  status: string;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  lastSyncStats: Record<string, number> | null;
  nextSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SyncLog {
  id: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  dryRun: boolean;
  usersCreated: number;
  usersUpdated: number;
  usersDeactivated: number;
  groupsUpdated: number;
  errorMessage: string | null;
}

type Provider = "AZURE_AD" | "GOOGLE_WORKSPACE" | "OKTA";

const PROVIDERS: { value: Provider; labelKey: string }[] = [
  { value: "AZURE_AD", labelKey: "providerAzureAd" },
  { value: "GOOGLE_WORKSPACE", labelKey: "providerGoogleWorkspace" },
  { value: "OKTA", labelKey: "providerOkta" },
];

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  IDLE: "outline",
  RUNNING: "secondary",
  SUCCESS: "default",
  ERROR: "destructive",
};

// ─── Component ───────────────────────────────────────────────

export function DirectorySyncCard() {
  const t = useTranslations("DirectorySync");
  const locale = useLocale();
  const [configs, setConfigs] = useState<DirectorySyncConfig[]>([]);
  const [loading, setLoading] = useState(true);

  // Add/Edit dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingConfig, setEditingConfig] = useState<DirectorySyncConfig | null>(null);
  const [formProvider, setFormProvider] = useState<Provider>("AZURE_AD");
  const [formDisplayName, setFormDisplayName] = useState("");
  const [formEnabled, setFormEnabled] = useState(true);
  const [formSyncInterval, setFormSyncInterval] = useState("60");
  const [formCredentials, setFormCredentials] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // Delete dialog
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Sync logs sheet
  const [logsConfigId, setLogsConfigId] = useState<string | null>(null);
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsCursor, setLogsCursor] = useState<string | undefined>();
  const [logsHasMore, setLogsHasMore] = useState(false);

  // Running sync
  const [runningSyncId, setRunningSyncId] = useState<string | null>(null);

  // ─── Fetch configs ──────────────────────────────────────────

  const fetchConfigs = useCallback(async () => {
    try {
      const res = await fetchApi(API_PATH.DIRECTORY_SYNC);
      if (res.ok) {
        setConfigs(await res.json());
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  // ─── Create / Edit ──────────────────────────────────────────

  function openCreateDialog() {
    setEditingConfig(null);
    setFormProvider("AZURE_AD");
    setFormDisplayName("");
    setFormEnabled(true);
    setFormSyncInterval("60");
    setFormCredentials({});
    setDialogOpen(true);
  }

  function openEditDialog(config: DirectorySyncConfig) {
    setEditingConfig(config);
    setFormProvider(config.provider as Provider);
    setFormDisplayName(config.displayName);
    setFormEnabled(config.enabled);
    setFormSyncInterval(String(config.syncIntervalMinutes));
    setFormCredentials({});
    setDialogOpen(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      if (editingConfig) {
        // Update
        const body: Record<string, unknown> = {
          displayName: formDisplayName,
          enabled: formEnabled,
          syncIntervalMinutes: parseInt(formSyncInterval, 10),
        };
        if (Object.keys(formCredentials).some((k) => formCredentials[k])) {
          body.credentials = formCredentials;
        }
        const res = await fetchApi(apiPath.directorySyncById(editingConfig.id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          toast.success(t("configUpdated"));
          setDialogOpen(false);
          fetchConfigs();
        } else if (res.status === 400) {
          toast.error(t("validationError"));
        } else {
          toast.error(t("syncFailed"));
        }
      } else {
        // Create
        const res = await fetchApi(API_PATH.DIRECTORY_SYNC, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: formProvider,
            displayName: formDisplayName,
            enabled: formEnabled,
            syncIntervalMinutes: parseInt(formSyncInterval, 10),
            credentials: formCredentials,
          }),
        });
        if (res.ok) {
          toast.success(t("configCreated"));
          setDialogOpen(false);
          fetchConfigs();
        } else if (res.status === 409) {
          toast.error(t("syncConflict"));
        } else if (res.status === 400) {
          toast.error(t("validationError"));
        } else {
          toast.error(t("syncFailed"));
        }
      }
    } catch {
      toast.error(t("syncFailed"));
    } finally {
      setSaving(false);
    }
  }

  // ─── Delete ─────────────────────────────────────────────────

  async function handleDelete() {
    if (!deletingId) return;
    try {
      const res = await fetchApi(apiPath.directorySyncById(deletingId), {
        method: "DELETE",
      });
      if (res.ok) {
        toast.success(t("configDeleted"));
        fetchConfigs();
      } else {
        toast.error(t("syncFailed"));
      }
    } catch {
      toast.error(t("syncFailed"));
    } finally {
      setDeletingId(null);
    }
  }

  // ─── Run sync ───────────────────────────────────────────────

  async function handleRunSync(configId: string, dryRun: boolean, force = false) {
    setRunningSyncId(configId);
    try {
      const res = await fetchApi(apiPath.directorySyncRun(configId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun, force }),
      });
      if (res.ok) {
        toast.success(t("syncStarted"));
        fetchConfigs();
      } else if (res.status === 409) {
        toast.error(t("syncConflict"));
      } else {
        const data = await res.json().catch(() => ({}));
        if (data?.result?.abortedSafety) {
          toast.error(t("safetyGuardTriggered"));
        } else {
          toast.error(t("syncFailed"));
        }
      }
    } catch {
      toast.error(t("syncFailed"));
    } finally {
      setRunningSyncId(null);
    }
  }

  // ─── Sync logs ──────────────────────────────────────────────

  async function openLogs(configId: string) {
    setLogsConfigId(configId);
    setLogs([]);
    setLogsCursor(undefined);
    setLogsHasMore(false);
    setLogsLoading(true);
    try {
      const res = await fetchApi(apiPath.directorySyncLogs(configId));
      if (res.ok) {
        const data = await res.json();
        setLogs(data.items ?? []);
        setLogsCursor(data.nextCursor);
        setLogsHasMore(data.hasMore ?? false);
      }
    } catch {
      // silent
    } finally {
      setLogsLoading(false);
    }
  }

  async function loadMoreLogs() {
    if (!logsConfigId || !logsCursor) return;
    setLogsLoading(true);
    try {
      const res = await fetchApi(
        `${apiPath.directorySyncLogs(logsConfigId)}?cursor=${logsCursor}`,
      );
      if (res.ok) {
        const data = await res.json();
        setLogs((prev) => [...prev, ...(data.items ?? [])]);
        setLogsCursor(data.nextCursor);
        setLogsHasMore(data.hasMore ?? false);
      }
    } catch {
      // silent
    } finally {
      setLogsLoading(false);
    }
  }

  // ─── Credential fields per provider ─────────────────────────

  const isEditing = !!editingConfig;
  const editPlaceholder = isEditing ? `••••••••  (${t("credentialsConfigured")})` : "";

  function hasRequiredCredentials(): boolean {
    if (isEditing) return true; // credentials optional on edit
    switch (formProvider) {
      case "AZURE_AD":
        return !!(formCredentials.tenantId && formCredentials.clientId && formCredentials.clientSecret);
      case "GOOGLE_WORKSPACE":
        return !!(formCredentials.serviceAccountJson && formCredentials.domain && formCredentials.adminEmail);
      case "OKTA":
        return !!(formCredentials.orgUrl && formCredentials.apiToken);
      default:
        return false;
    }
  }

  function renderCredentialFields() {
    switch (formProvider) {
      case "AZURE_AD":
        return (
          <>
            <div className="space-y-2">
              <Label>{t("azureTenantId")}</Label>
              <Input
                value={formCredentials.tenantId ?? ""}
                onChange={(e) =>
                  setFormCredentials((prev) => ({ ...prev, tenantId: e.target.value }))
                }
                placeholder={isEditing ? editPlaceholder : "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("azureClientId")}</Label>
              <Input
                value={formCredentials.clientId ?? ""}
                onChange={(e) =>
                  setFormCredentials((prev) => ({ ...prev, clientId: e.target.value }))
                }
                placeholder={editPlaceholder}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("azureClientSecret")}</Label>
              <Input
                type="password"
                value={formCredentials.clientSecret ?? ""}
                onChange={(e) =>
                  setFormCredentials((prev) => ({ ...prev, clientSecret: e.target.value }))
                }
                placeholder={editPlaceholder}
              />
            </div>
          </>
        );
      case "GOOGLE_WORKSPACE":
        return (
          <>
            <div className="space-y-2">
              <Label>{t("googleServiceAccount")}</Label>
              <textarea
                className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                value={formCredentials.serviceAccountJson ?? ""}
                onChange={(e) =>
                  setFormCredentials((prev) => ({ ...prev, serviceAccountJson: e.target.value }))
                }
                placeholder={isEditing ? editPlaceholder : '{"type":"service_account",...}'}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("googleDomain")}</Label>
              <Input
                value={formCredentials.domain ?? ""}
                onChange={(e) =>
                  setFormCredentials((prev) => ({ ...prev, domain: e.target.value }))
                }
                placeholder={isEditing ? editPlaceholder : "example.com"}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("googleAdminEmail")}</Label>
              <Input
                type="email"
                value={formCredentials.adminEmail ?? ""}
                onChange={(e) =>
                  setFormCredentials((prev) => ({ ...prev, adminEmail: e.target.value }))
                }
                placeholder={isEditing ? editPlaceholder : "admin@example.com"}
              />
            </div>
          </>
        );
      case "OKTA":
        return (
          <>
            <div className="space-y-2">
              <Label>{t("oktaOrgUrl")}</Label>
              <Input
                value={formCredentials.orgUrl ?? ""}
                onChange={(e) =>
                  setFormCredentials((prev) => ({ ...prev, orgUrl: e.target.value }))
                }
                placeholder={isEditing ? editPlaceholder : "https://your-org.okta.com/"}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("oktaApiToken")}</Label>
              <Input
                type="password"
                value={formCredentials.apiToken ?? ""}
                onChange={(e) =>
                  setFormCredentials((prev) => ({ ...prev, apiToken: e.target.value }))
                }
                placeholder={editPlaceholder}
              />
            </div>
          </>
        );
    }
  }

  // ─── Status badge ───────────────────────────────────────────

  function statusLabel(status: string) {
    switch (status) {
      case "IDLE": return t("statusIdle");
      case "RUNNING": return t("statusRunning");
      case "SUCCESS": return t("statusSuccess");
      case "ERROR": return t("statusError");
      default: return status;
    }
  }

  function providerLabel(provider: string) {
    const p = PROVIDERS.find((pp) => pp.value === provider);
    return p ? t(p.labelKey) : provider;
  }

  // ─── Render ─────────────────────────────────────────────────

  return (
    <>
      <Card>
        <SectionCardHeader
          icon={FolderSync}
          title={t("title")}
          description={t("description")}
          action={
            <Button size="sm" className="shrink-0" onClick={openCreateDialog}>
              <Plus className="h-4 w-4 mr-1" />
              {t("addConfig")}
            </Button>
          }
        />
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : configs.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-sm text-muted-foreground">{t("noConfigs")}</p>
              <p className="text-xs text-muted-foreground mt-1">{t("noConfigsHint")}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {configs.map((config) => (
                <div
                  key={config.id}
                  className="flex items-start justify-between rounded-md border p-4"
                >
                  <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{config.displayName}</span>
                      <Badge variant="outline">{providerLabel(config.provider)}</Badge>
                      <Badge variant={STATUS_VARIANT[config.status] ?? "outline"}>
                        {statusLabel(config.status)}
                      </Badge>
                      {!config.enabled && (
                        <Badge variant="secondary" className="text-muted-foreground">
                          {t("disabled")}
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground space-x-3">
                      <span>
                        {t("lastSyncAt")}:{" "}
                        {config.lastSyncAt
                          ? formatRelativeTime(config.lastSyncAt, locale)
                          : t("neverSynced")}
                      </span>
                    </div>
                    {config.lastSyncError && (
                      <p className="text-xs text-destructive mt-1 truncate max-w-md">
                        {config.lastSyncError}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0 ml-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleRunSync(config.id, false)}
                      disabled={runningSyncId === config.id}
                    >
                      {runningSyncId === config.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Play className="h-3 w-3" />
                      )}
                      <span className="ml-1">{t("syncNow")}</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openLogs(config.id)}
                    >
                      <ScrollText className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openEditDialog(config)}
                    >
                      {t("editConfig")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => setDeletingId(config.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Add/Edit Dialog ───────────────────────────────────── */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingConfig ? t("editConfig") : t("addConfig")}
            </DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {!editingConfig && (
              <div className="space-y-2">
                <Label>{t("provider")}</Label>
                <Select
                  value={formProvider}
                  onValueChange={(v) => {
                    setFormProvider(v as Provider);
                    setFormCredentials({});
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("selectProvider")} />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDERS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        {t(p.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2">
              <Label>{t("displayName")}</Label>
              <Input
                value={formDisplayName}
                onChange={(e) => setFormDisplayName(e.target.value)}
                placeholder={t("displayNamePlaceholder")}
                maxLength={NAME_MAX_LENGTH}
              />
            </div>
            <div className="flex items-center gap-3">
              <Switch checked={formEnabled} onCheckedChange={setFormEnabled} />
              <Label>{t("enabled")}</Label>
            </div>
            <div className="space-y-2">
              <Label>{t("syncInterval")}</Label>
              <Select value={formSyncInterval} onValueChange={setFormSyncInterval}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="15">15</SelectItem>
                  <SelectItem value="30">30</SelectItem>
                  <SelectItem value="60">60</SelectItem>
                  <SelectItem value="120">120</SelectItem>
                  <SelectItem value="360">360</SelectItem>
                  <SelectItem value="720">720</SelectItem>
                  <SelectItem value="1440">1440</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-3 border-t pt-3">
              <Label className="text-sm font-medium">{t("credentials")}</Label>
              <p className="text-xs text-muted-foreground">
                {editingConfig ? t("credentialsEditHint") : t("credentialsHint")}
              </p>
              {renderCredentialFields()}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t("cancel")}
            </Button>
            <Button onClick={handleSave} disabled={saving || !formDisplayName.trim() || !hasRequiredCredentials()}>
              {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Delete Confirmation ───────────────────────────────── */}
      <AlertDialog open={!!deletingId} onOpenChange={(open) => { if (!open) setDeletingId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConfig")}</AlertDialogTitle>
            <AlertDialogDescription>{t("deleteConfirm")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>{t("deleteConfig")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ─── Sync Logs Sheet ───────────────────────────────────── */}
      <Sheet open={!!logsConfigId} onOpenChange={(open) => { if (!open) setLogsConfigId(null); }}>
        <SheetContent className="sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t("syncLogs")}</SheetTitle>
            <SheetDescription>
              {configs.find((c) => c.id === logsConfigId)?.displayName ?? ""}
            </SheetDescription>
          </SheetHeader>
          <div className="mt-4 space-y-3">
            {logsLoading && logs.length === 0 ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : logs.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                {t("syncLogsEmpty")}
              </p>
            ) : (
              <>
                {logs.map((log) => (
                  <div key={log.id} className="border rounded-md p-3 space-y-1">
                    <div className="flex items-center gap-2">
                      <Badge variant={STATUS_VARIANT[log.status] ?? "outline"}>
                        {statusLabel(log.status)}
                      </Badge>
                      {log.dryRun && (
                        <Badge variant="secondary">{t("logDryRun")}</Badge>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {formatDateTime(log.startedAt, locale)}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>{t("logUsersCreated")}: {log.usersCreated}</span>
                      <span>{t("logUsersUpdated")}: {log.usersUpdated}</span>
                      <span>{t("logUsersDeactivated")}: {log.usersDeactivated}</span>
                      <span>{t("logGroupsUpdated")}: {log.groupsUpdated}</span>
                    </div>
                    {log.errorMessage && (
                      <p className="text-xs text-destructive break-words whitespace-pre-wrap">{log.errorMessage}</p>
                    )}
                  </div>
                ))}
                {logsHasMore && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={loadMoreLogs}
                    disabled={logsLoading}
                  >
                    {logsLoading ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      t("loadMore")
                    )}
                  </Button>
                )}
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
