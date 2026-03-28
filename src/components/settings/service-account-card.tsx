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
import { Switch } from "@/components/ui/switch";
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChevronDown, Loader2, Plus, Trash2, Pencil, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { apiPath } from "@/lib/constants";
import { SA_TOKEN_SCOPES } from "@/lib/constants/service-account";
import { formatDateTime } from "@/lib/format-datetime";
import { fetchApi } from "@/lib/url-helpers";

interface ServiceAccount {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
}

interface SaToken {
  id: string;
  name: string;
  prefix: string;
  scope: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function ServiceAccountCard() {
  const t = useTranslations("UnifiedAccess");
  const tCommon = useTranslations("Common");
  const locale = useLocale();

  const [accounts, setAccounts] = useState<ServiceAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedSa, setExpandedSa] = useState<Set<string>>(new Set());
  const [saTokens, setSaTokens] = useState<Record<string, SaToken[]>>({});
  const [tokenLoading, setTokenLoading] = useState<Set<string>>(new Set());

  // Create SA dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createNameError, setCreateNameError] = useState("");

  // Edit SA dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editSa, setEditSa] = useState<ServiceAccount | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editIsActive, setEditIsActive] = useState(true);
  const [editNameError, setEditNameError] = useState("");

  // Create token dialog
  const [tokenCreateOpen, setTokenCreateOpen] = useState(false);
  const [tokenCreating, setTokenCreating] = useState(false);
  const [tokenForSaId, setTokenForSaId] = useState<string | null>(null);
  const [tokenName, setTokenName] = useState("");
  const [tokenSelectedScopes, setTokenSelectedScopes] = useState<Set<string>>(new Set());
  const [tokenExpiresAt, setTokenExpiresAt] = useState("");
  const [tokenNameError, setTokenNameError] = useState("");
  const [tokenScopeError, setTokenScopeError] = useState("");
  const [newTokenSecret, setNewTokenSecret] = useState<string | null>(null);

  const fetchAccounts = useCallback(async () => {
    try {
      const res = await fetchApi(apiPath.tenantServiceAccounts());
      if (res.ok) {
        const data = await res.json();
        setAccounts(Array.isArray(data) ? data : data.serviceAccounts ?? []);
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  const fetchTokens = useCallback(async (saId: string) => {
    setTokenLoading((prev) => new Set(prev).add(saId));
    try {
      const res = await fetchApi(apiPath.tenantServiceAccountTokens(saId));
      if (res.ok) {
        const data = await res.json();
        const rawTokens = Array.isArray(data) ? data : data.tokens ?? [];
        // Backend returns scope as CSV string; normalize to array for UI
        const normalized = rawTokens.map((tok: Record<string, unknown>) => ({
          ...tok,
          scope: typeof tok.scope === "string" ? (tok.scope as string).split(",").filter(Boolean) : tok.scope,
        }));
        setSaTokens((prev) => ({ ...prev, [saId]: normalized }));
      }
    } catch {
      // silently fail
    } finally {
      setTokenLoading((prev) => {
        const next = new Set(prev);
        next.delete(saId);
        return next;
      });
    }
  }, []);

  const toggleExpand = (saId: string) => {
    setExpandedSa((prev) => {
      const next = new Set(prev);
      if (next.has(saId)) {
        next.delete(saId);
      } else {
        next.add(saId);
        if (!saTokens[saId]) {
          fetchTokens(saId);
        }
      }
      return next;
    });
  };

  const handleCreate = async () => {
    if (!createName.trim()) {
      setCreateNameError(t("saNameRequired"));
      return;
    }
    if (createName.trim().length > 100) {
      setCreateNameError(t("saNameTooLong"));
      return;
    }
    setCreating(true);
    setCreateNameError("");
    try {
      const res = await fetchApi(apiPath.tenantServiceAccounts(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: createName.trim(),
          ...(createDescription.trim() && { description: createDescription.trim() }),
        }),
      });
      if (res.status === 409) {
        const data = await res.json().catch(() => null);
        if (data?.code === "NAME_CONFLICT") {
          setCreateNameError(t("saNameConflict"));
        } else {
          toast.error(t("saLimitReached"));
        }
        return;
      }
      if (!res.ok) {
        toast.error(t("saCreateFailed"));
        return;
      }
      toast.success(t("saCreated"));
      setCreateOpen(false);
      setCreateName("");
      setCreateDescription("");
      fetchAccounts();
    } catch {
      toast.error(t("saCreateFailed"));
    } finally {
      setCreating(false);
    }
  };

  const openEdit = (sa: ServiceAccount) => {
    setEditSa(sa);
    setEditName(sa.name);
    setEditDescription(sa.description ?? "");
    setEditIsActive(sa.isActive);
    setEditNameError("");
    setEditOpen(true);
  };

  const handleEdit = async () => {
    if (!editSa) return;
    if (!editName.trim()) {
      setEditNameError(t("saNameRequired"));
      return;
    }
    if (editName.trim().length > 100) {
      setEditNameError(t("saNameTooLong"));
      return;
    }
    setEditing(true);
    setEditNameError("");
    try {
      const res = await fetchApi(apiPath.tenantServiceAccountById(editSa.id), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName.trim(),
          description: editDescription.trim() || null,
          isActive: editIsActive,
        }),
      });
      if (res.status === 409) {
        setEditNameError(t("saNameConflict"));
        return;
      }
      if (!res.ok) {
        toast.error(t("saUpdateFailed"));
        return;
      }
      toast.success(t("saUpdated"));
      setEditOpen(false);
      fetchAccounts();
    } catch {
      toast.error(t("saUpdateFailed"));
    } finally {
      setEditing(false);
    }
  };

  const handleDelete = async (saId: string) => {
    try {
      const res = await fetchApi(apiPath.tenantServiceAccountById(saId), {
        method: "DELETE",
      });
      if (res.ok) {
        toast.success(t("saDeleted"));
        fetchAccounts();
      } else {
        toast.error(t("saDeleteFailed"));
      }
    } catch {
      toast.error(t("saDeleteFailed"));
    }
  };

  const openTokenCreate = (saId: string) => {
    setTokenForSaId(saId);
    setTokenName("");
    setTokenSelectedScopes(new Set());
    setTokenExpiresAt("");
    setTokenNameError("");
    setTokenScopeError("");
    setNewTokenSecret(null);
    setTokenCreateOpen(true);
  };

  const handleCreateToken = async () => {
    if (!tokenForSaId) return;
    if (!tokenName.trim()) {
      setTokenNameError(t("tokenNameRequired"));
      return;
    }
    if (tokenSelectedScopes.size === 0) {
      setTokenScopeError(t("tokenScopeRequired"));
      return;
    }
    setTokenCreating(true);
    setTokenNameError("");
    setTokenScopeError("");
    try {
      if (!tokenExpiresAt) {
        setTokenNameError(t("tokenExpiresAtRequired"));
        setTokenCreating(false);
        return;
      }
      // Set expiry to end-of-day to avoid timezone issues with date-only input
      const expiryDate = new Date(tokenExpiresAt + "T23:59:59");
      const body = {
        name: tokenName.trim(),
        scope: Array.from(tokenSelectedScopes),
        expiresAt: expiryDate.toISOString(),
      };
      const res = await fetchApi(
        apiPath.tenantServiceAccountTokens(tokenForSaId),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        const code = errData?.error;
        if (res.status === 409 && code === "SA_TOKEN_LIMIT_EXCEEDED") {
          toast.error(t("tokenLimitReached"));
        } else if (res.status === 409) {
          toast.error(t("saInactiveError"));
        } else if (res.status === 400) {
          toast.error(t("tokenValidationError"));
        } else {
          toast.error(t("tokenCreateFailed"));
        }
        return;
      }
      const data = await res.json();
      setNewTokenSecret(data.token ?? null);
      toast.success(t("tokenCreated"));
      fetchTokens(tokenForSaId);
    } catch {
      toast.error(t("tokenCreateFailed"));
    } finally {
      setTokenCreating(false);
    }
  };

  const handleRevokeToken = async (saId: string, tokenId: string) => {
    try {
      const res = await fetchApi(
        apiPath.tenantServiceAccountTokenById(saId, tokenId),
        { method: "DELETE" }
      );
      if (res.ok) {
        toast.success(t("tokenRevoked2"));
        fetchTokens(saId);
      } else {
        toast.error(t("tokenRevokeFailed"));
      }
    } catch {
      toast.error(t("tokenRevokeFailed"));
    }
  };

  const toggleScope = (scope: string, checked: boolean) => {
    setTokenSelectedScopes((prev) => {
      const next = new Set(prev);
      if (checked) next.add(scope);
      else next.delete(scope);
      return next;
    });
    setTokenScopeError("");
  };

  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{t("serviceAccounts")}</h3>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          {t("createServiceAccount")}
        </Button>
      </div>

      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : accounts.length === 0 ? (
        <p className="text-center text-muted-foreground">{t("noServiceAccounts")}</p>
      ) : (
        <div className="space-y-2">
          {accounts.map((sa) => (
            <Collapsible
              key={sa.id}
              open={expandedSa.has(sa.id)}
              onOpenChange={() => toggleExpand(sa.id)}
            >
              <div className="border rounded-md">
                <div className="flex items-center justify-between p-3">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <CollapsibleTrigger asChild>
                      <button
                        type="button"
                        className="flex items-center gap-2 min-w-0 flex-1 text-left"
                      >
                        <ChevronDown
                          className={`h-4 w-4 shrink-0 transition-transform text-muted-foreground ${expandedSa.has(sa.id) ? "rotate-0" : "-rotate-90"}`}
                        />
                        <span className="text-sm font-medium truncate">{sa.name}</span>
                        {sa.description && (
                          <span className="text-xs text-muted-foreground truncate hidden sm:block">
                            {sa.description}
                          </span>
                        )}
                        <Badge variant={sa.isActive ? "default" : "secondary"} className="shrink-0">
                          {sa.isActive ? t("saActive") : t("saInactive")}
                        </Badge>
                      </button>
                    </CollapsibleTrigger>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => openEdit(sa)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            {t("saDeleteConfirm", { name: sa.name })}
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            {t("saDeleteWarning")}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
                          <AlertDialogAction onClick={() => handleDelete(sa.id)}>
                            {tCommon("delete")}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>

                <CollapsibleContent>
                  <div className="border-t px-3 pb-3 pt-2 space-y-2 bg-muted/20">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium text-muted-foreground">
                        {t("tokens")}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => openTokenCreate(sa.id)}
                        disabled={!sa.isActive}
                      >
                        <KeyRound className="h-3 w-3 mr-1" />
                        {t("createToken")}
                      </Button>
                    </div>

                    {tokenLoading.has(sa.id) ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : !saTokens[sa.id] || saTokens[sa.id].length === 0 ? (
                      <p className="text-xs text-muted-foreground">{t("noTokens")}</p>
                    ) : (
                      <div className="space-y-1">
                        {saTokens[sa.id].map((token) => (
                          <div
                            key={token.id}
                            className="flex items-center justify-between border rounded p-2 bg-background"
                          >
                            <div className="space-y-0.5 min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs font-medium truncate">
                                  {token.name}
                                </span>
                                <span className="text-xs text-muted-foreground font-mono shrink-0">
                                  {token.prefix}…
                                </span>
                                {token.revokedAt && (
                                  <Badge variant="destructive" className="text-[10px] px-1 h-3.5 shrink-0">
                                    {t("tokenRevoked")}
                                  </Badge>
                                )}
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {token.scope.map((s) => (
                                  <Badge key={s} variant="outline" className="text-[10px] px-1 h-3.5">
                                    {s}
                                  </Badge>
                                ))}
                              </div>
                              <div className="text-[10px] text-muted-foreground space-x-2">
                                <span>
                                  {t("tokenLastUsed")}:{" "}
                                  {token.lastUsedAt
                                    ? formatDateTime(token.lastUsedAt, locale)
                                    : t("tokenNeverUsed")}
                                </span>
                                <span>
                                  {t("tokenExpires")}:{" "}
                                  {token.expiresAt
                                    ? formatDateTime(token.expiresAt, locale)
                                    : t("tokenNeverExpires")}
                                </span>
                              </div>
                            </div>
                            {!token.revokedAt && (
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0">
                                    <Trash2 className="h-3 w-3 text-destructive" />
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>
                                      {t("tokenRevokeConfirm", { name: token.name })}
                                    </AlertDialogTitle>
                                    <AlertDialogDescription>
                                      {t("tokenRevokeWarning")}
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
                                    <AlertDialogAction
                                      onClick={() => handleRevokeToken(sa.id, token.id)}
                                    >
                                      {t("revokeToken")}
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>
          ))}
        </div>
      )}

      {/* Create SA dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) {
            setCreateName("");
            setCreateDescription("");
            setCreateNameError("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("createServiceAccount")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>{t("saName")}</Label>
              <Input
                value={createName}
                onChange={(e) => {
                  setCreateName(e.target.value);
                  setCreateNameError("");
                }}
                placeholder={t("saNamePlaceholder")}
                maxLength={100}
              />
              {createNameError && (
                <p className="text-sm text-destructive">{createNameError}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>{t("saDescription")}</Label>
              <Input
                value={createDescription}
                onChange={(e) => setCreateDescription(e.target.value)}
                placeholder={t("saDescriptionPlaceholder")}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              {tCommon("create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit SA dialog */}
      <Dialog
        open={editOpen}
        onOpenChange={(open) => {
          setEditOpen(open);
          if (!open) {
            setEditSa(null);
            setEditNameError("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("editServiceAccount")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>{t("saName")}</Label>
              <Input
                value={editName}
                onChange={(e) => {
                  setEditName(e.target.value);
                  setEditNameError("");
                }}
                placeholder={t("saNamePlaceholder")}
                maxLength={100}
              />
              {editNameError && (
                <p className="text-sm text-destructive">{editNameError}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>{t("saDescription")}</Label>
              <Input
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder={t("saDescriptionPlaceholder")}
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <Switch
                  id="sa-active"
                  checked={editIsActive}
                  onCheckedChange={setEditIsActive}
                />
                <Label htmlFor="sa-active" className={editIsActive ? "" : "text-destructive"}>
                  {editIsActive ? t("saActive") : t("saInactive")}
                </Label>
              </div>
              {!editIsActive && (
                <p className="text-xs text-destructive">
                  {t("saDeactivateWarning")}
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={handleEdit} disabled={editing}>
              {editing && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              {tCommon("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create token dialog */}
      <Dialog
        open={tokenCreateOpen}
        onOpenChange={(open) => {
          setTokenCreateOpen(open);
          if (!open) {
            setTokenForSaId(null);
            setTokenName("");
            setTokenSelectedScopes(new Set());
            setTokenExpiresAt("");
            setTokenNameError("");
            setTokenScopeError("");
            setNewTokenSecret(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("createToken")}</DialogTitle>
          </DialogHeader>
          {newTokenSecret ? (
            <div className="space-y-3 py-2">
              <p className="text-sm font-medium">{t("tokenSecret")}</p>
              <div className="flex items-center gap-2">
                <Input
                  value={newTokenSecret}
                  readOnly
                  autoComplete="off"
                  className="font-mono text-xs"
                />
                <CopyButton getValue={() => newTokenSecret} />
              </div>
              <p className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                {t("tokenSecretWarning")}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setTokenCreateOpen(false);
                  setNewTokenSecret(null);
                }}
              >
                OK
              </Button>
            </div>
          ) : (
            <>
              <div className="space-y-4 py-2">
                <div className="space-y-2">
                  <Label>{t("tokenName")}</Label>
                  <Input
                    value={tokenName}
                    onChange={(e) => {
                      setTokenName(e.target.value);
                      setTokenNameError("");
                    }}
                    placeholder={t("tokenNamePlaceholder")}
                  />
                  {tokenNameError && (
                    <p className="text-sm text-destructive">{tokenNameError}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label>{t("tokenScope")}</Label>
                  <div className="border rounded-md p-3 space-y-1 max-h-48 overflow-y-auto">
                    {SA_TOKEN_SCOPES.map((scope) => (
                      <label
                        key={scope}
                        className="flex items-center gap-2 text-sm py-0.5"
                      >
                        <Checkbox
                          checked={tokenSelectedScopes.has(scope)}
                          onCheckedChange={(checked) =>
                            toggleScope(scope, !!checked)
                          }
                        />
                        {scope}
                      </label>
                    ))}
                  </div>
                  {tokenScopeError && (
                    <p className="text-sm text-destructive">{tokenScopeError}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label>{t("tokenExpiresAt")}</Label>
                  <Input
                    type="date"
                    value={tokenExpiresAt}
                    onChange={(e) => setTokenExpiresAt(e.target.value)}
                    min={new Date(Date.now() + 86400000).toISOString().split("T")[0]}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setTokenCreateOpen(false)}>
                  {tCommon("cancel")}
                </Button>
                <Button onClick={handleCreateToken} disabled={tokenCreating || !tokenName.trim() || tokenSelectedScopes.size === 0 || !tokenExpiresAt}>
                  {tokenCreating && (
                    <Loader2 className="h-4 w-4 animate-spin mr-1" />
                  )}
                  {tCommon("create")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
