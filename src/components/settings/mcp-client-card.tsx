"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { CopyButton } from "@/components/passwords/copy-button";
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
import { Loader2, Plus, Trash2, Pencil } from "lucide-react";
import { toast } from "sonner";
import { apiPath } from "@/lib/constants";
import { MCP_SCOPES } from "@/lib/constants/mcp";
import { fetchApi } from "@/lib/url-helpers";

interface McpClient {
  id: string;
  name: string;
  clientId: string;
  redirectUris: string[];
  allowedScopes: string;
  isActive: boolean;
  createdAt: string;
}

interface NewClientCredentials {
  clientId: string;
  clientSecret: string;
}

function validateRedirectUris(uris: string[]): boolean {
  return uris.every((u) => {
    try {
      const url = new URL(u);
      return url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost");
    } catch {
      return false;
    }
  });
}

export function McpClientCard() {
  const t = useTranslations("MachineIdentity");
  const tCommon = useTranslations("Common");

  const [clients, setClients] = useState<McpClient[]>([]);
  const [loading, setLoading] = useState(true);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createRedirectUris, setCreateRedirectUris] = useState("");
  const [createScopes, setCreateScopes] = useState<Set<string>>(new Set());
  const [createNameError, setCreateNameError] = useState("");
  const [createUriError, setCreateUriError] = useState("");
  const [createScopeError, setCreateScopeError] = useState("");
  const [newCredentials, setNewCredentials] = useState<NewClientCredentials | null>(null);

  // Edit dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editClient, setEditClient] = useState<McpClient | null>(null);
  const [editName, setEditName] = useState("");
  const [editRedirectUris, setEditRedirectUris] = useState("");
  const [editScopes, setEditScopes] = useState<Set<string>>(new Set());
  const [editIsActive, setEditIsActive] = useState(true);
  const [editNameError, setEditNameError] = useState("");
  const [editUriError, setEditUriError] = useState("");
  const [editScopeError, setEditScopeError] = useState("");

  const fetchClients = useCallback(async () => {
    try {
      const res = await fetchApi(apiPath.tenantMcpClients());
      if (res.ok) {
        const data = await res.json();
        setClients(data.clients ?? []);
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchClients();
  }, [fetchClients]);

  const parseUris = (raw: string): string[] =>
    raw
      .split("\n")
      .map((u) => u.trim())
      .filter(Boolean);

  const handleCreate = async () => {
    let valid = true;
    if (!createName.trim()) {
      setCreateNameError(t("mcpNameRequired"));
      valid = false;
    }
    const uris = parseUris(createRedirectUris);
    if (uris.length === 0) {
      setCreateUriError(t("mcpRedirectUriRequired"));
      valid = false;
    } else if (!validateRedirectUris(uris)) {
      setCreateUriError(t("mcpRedirectUriInvalid"));
      valid = false;
    }
    if (createScopes.size === 0) {
      setCreateScopeError(t("mcpScopeRequired"));
      valid = false;
    }
    if (!valid) return;

    setCreating(true);
    try {
      const res = await fetchApi(apiPath.tenantMcpClients(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: createName.trim(),
          redirectUris: uris,
          allowedScopes: Array.from(createScopes),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        if (res.status === 409 && data?.error === "MCP_CLIENT_NAME_CONFLICT") {
          setCreateNameError(t("mcpNameConflict"));
        } else if (res.status === 422 && data?.error === "MCP_CLIENT_LIMIT_EXCEEDED") {
          toast.error(t("mcpLimitReached"));
        } else {
          toast.error(t("mcpCreateFailed"));
        }
        return;
      }
      const data = await res.json();
      const created = data.client ?? data;
      setNewCredentials({
        clientId: created.clientId,
        clientSecret: created.clientSecret,
      });
      toast.success(t("mcpCreated"));
      fetchClients();
    } catch {
      toast.error(t("mcpCreateFailed"));
    } finally {
      setCreating(false);
    }
  };

  const openEdit = (client: McpClient) => {
    setEditClient(client);
    setEditName(client.name);
    setEditRedirectUris(Array.isArray(client.redirectUris) ? client.redirectUris.join("\n") : "");
    setEditScopes(
      new Set(client.allowedScopes ? client.allowedScopes.split(",").map((s) => s.trim()).filter(Boolean) : [])
    );
    setEditIsActive(client.isActive);
    setEditNameError("");
    setEditUriError("");
    setEditScopeError("");
    setEditOpen(true);
  };

  const handleEdit = async () => {
    if (!editClient) return;
    let valid = true;
    if (!editName.trim()) {
      setEditNameError(t("mcpNameRequired"));
      valid = false;
    }
    const uris = parseUris(editRedirectUris);
    if (uris.length > 0 && !validateRedirectUris(uris)) {
      setEditUriError(t("mcpRedirectUriInvalid"));
      valid = false;
    }
    if (editScopes.size === 0) {
      setEditScopeError(t("mcpScopeRequired"));
      valid = false;
    }
    if (!valid) return;

    setEditing(true);
    try {
      const body: Record<string, unknown> = {
        name: editName.trim(),
        redirectUris: uris,
        allowedScopes: Array.from(editScopes),
        isActive: editIsActive,
      };
      const res = await fetchApi(apiPath.tenantMcpClientById(editClient.id), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 409) {
        setEditNameError(t("mcpNameConflict"));
        return;
      }
      if (!res.ok) {
        toast.error(t("mcpUpdateFailed"));
        return;
      }
      toast.success(t("mcpUpdated"));
      setEditOpen(false);
      fetchClients();
    } catch {
      toast.error(t("mcpUpdateFailed"));
    } finally {
      setEditing(false);
    }
  };

  const handleDelete = async (clientId: string) => {
    try {
      const res = await fetchApi(apiPath.tenantMcpClientById(clientId), {
        method: "DELETE",
      });
      if (res.ok) {
        toast.success(t("mcpDeleted"));
        fetchClients();
      } else {
        toast.error(t("mcpDeleteFailed"));
      }
    } catch {
      toast.error(t("mcpDeleteFailed"));
    }
  };

  const toggleCreateScope = (scope: string, checked: boolean) => {
    setCreateScopes((prev) => {
      const next = new Set(prev);
      if (checked) next.add(scope);
      else next.delete(scope);
      return next;
    });
    setCreateScopeError("");
  };

  const toggleEditScope = (scope: string, checked: boolean) => {
    setEditScopes((prev) => {
      const next = new Set(prev);
      if (checked) next.add(scope);
      else next.delete(scope);
      return next;
    });
    setEditScopeError("");
  };

  const closeCreateDialog = () => {
    setCreateOpen(false);
    setCreateName("");
    setCreateRedirectUris("");
    setCreateScopes(new Set());
    setCreateNameError("");
    setCreateUriError("");
    setCreateScopeError("");
    setNewCredentials(null);
  };

  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{t("mcpClients")}</h3>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          {t("registerMcpClient")}
        </Button>
      </div>

      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : clients.length === 0 ? (
        <p className="text-center text-muted-foreground">{t("noMcpClients")}</p>
      ) : (
        <div className="space-y-2">
          {clients.map((client) => (
            <div
              key={client.id}
              className="flex items-center justify-between border rounded-md p-3"
            >
              <div className="space-y-1 min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{client.name}</span>
                  <Badge
                    variant={client.isActive ? "default" : "secondary"}
                    className="shrink-0"
                  >
                    {client.isActive ? t("mcpActive") : t("mcpInactive")}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground font-mono">
                  {client.clientId}
                </p>
                <div className="flex flex-wrap gap-1">
                  {client.allowedScopes
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean)
                    .map((scope) => (
                      <Badge key={scope} variant="outline" className="text-xs font-normal">
                        {scope}
                      </Badge>
                    ))}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => openEdit(client)}
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
                        {t("mcpDeleteConfirm", { name: client.name })}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {t("mcpDeleteWarning")}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
                      <AlertDialogAction onClick={() => handleDelete(client.id)}>
                        {tCommon("delete")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={(open) => { if (!open) closeCreateDialog(); else setCreateOpen(true); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("registerMcpClient")}</DialogTitle>
          </DialogHeader>
          {newCredentials ? (
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label className="text-sm font-medium">{t("mcpClientId")}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    value={newCredentials.clientId}
                    readOnly
                    autoComplete="off"
                    className="font-mono text-xs"
                  />
                  <CopyButton getValue={() => newCredentials.clientId} />
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-sm font-medium">{t("mcpClientSecret")}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    value={newCredentials.clientSecret}
                    readOnly
                    autoComplete="off"
                    className="font-mono text-xs"
                  />
                  <CopyButton getValue={() => newCredentials.clientSecret} />
                </div>
              </div>
              <p className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                {t("mcpClientSecretWarning")}
              </p>
              <Button variant="outline" size="sm" onClick={closeCreateDialog}>
                OK
              </Button>
            </div>
          ) : (
            <>
              <div className="space-y-4 py-2">
                <div className="space-y-2">
                  <Label>{t("mcpName")}</Label>
                  <Input
                    value={createName}
                    onChange={(e) => {
                      setCreateName(e.target.value);
                      setCreateNameError("");
                    }}
                    placeholder={t("mcpNamePlaceholder")}
                  />
                  {createNameError && (
                    <p className="text-sm text-destructive">{createNameError}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label>{t("mcpRedirectUris")}</Label>
                  <Textarea
                    value={createRedirectUris}
                    onChange={(e) => {
                      setCreateRedirectUris(e.target.value);
                      setCreateUriError("");
                    }}
                    placeholder={t("mcpRedirectUrisPlaceholder")}
                    rows={3}
                  />
                  <p className="text-xs text-muted-foreground">{t("mcpRedirectUrisHint")}</p>
                  {createUriError && (
                    <p className="text-sm text-destructive">{createUriError}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label>{t("mcpAllowedScopes")}</Label>
                  <div className="border rounded-md p-3 space-y-1">
                    {MCP_SCOPES.map((scope) => (
                      <label
                        key={scope}
                        className="flex items-center gap-2 text-sm py-0.5"
                      >
                        <Checkbox
                          checked={createScopes.has(scope)}
                          onCheckedChange={(checked) =>
                            toggleCreateScope(scope, !!checked)
                          }
                        />
                        {scope}
                      </label>
                    ))}
                  </div>
                  {createScopeError && (
                    <p className="text-sm text-destructive">{createScopeError}</p>
                  )}
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={closeCreateDialog}>
                  {tCommon("cancel")}
                </Button>
                <Button onClick={handleCreate} disabled={creating}>
                  {creating && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                  {tCommon("create")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog
        open={editOpen}
        onOpenChange={(open) => {
          setEditOpen(open);
          if (!open) {
            setEditClient(null);
            setEditNameError("");
            setEditUriError("");
            setEditScopeError("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("editMcpClient")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>{t("mcpName")}</Label>
              <Input
                value={editName}
                onChange={(e) => {
                  setEditName(e.target.value);
                  setEditNameError("");
                }}
                placeholder={t("mcpNamePlaceholder")}
              />
              {editNameError && (
                <p className="text-sm text-destructive">{editNameError}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>{t("mcpRedirectUris")}</Label>
              <Textarea
                value={editRedirectUris}
                onChange={(e) => {
                  setEditRedirectUris(e.target.value);
                  setEditUriError("");
                }}
                placeholder={t("mcpRedirectUrisPlaceholder")}
                rows={3}
              />
              <p className="text-xs text-muted-foreground">{t("mcpRedirectUrisHint")}</p>
              {editUriError && (
                <p className="text-sm text-destructive">{editUriError}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>{t("mcpAllowedScopes")}</Label>
              <div className="border rounded-md p-3 space-y-1">
                {MCP_SCOPES.map((scope) => (
                  <label
                    key={scope}
                    className="flex items-center gap-2 text-sm py-0.5"
                  >
                    <Checkbox
                      checked={editScopes.has(scope)}
                      onCheckedChange={(checked) =>
                        toggleEditScope(scope, !!checked)
                      }
                    />
                    {scope}
                  </label>
                ))}
              </div>
              {editScopeError && (
                <p className="text-sm text-destructive">{editScopeError}</p>
              )}
            </div>
            <div className="flex items-center gap-3">
              <Switch
                id="mcp-active"
                checked={editIsActive}
                onCheckedChange={setEditIsActive}
              />
              <Label htmlFor="mcp-active">
                {editIsActive ? t("mcpActive") : t("mcpInactive")}
              </Label>
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
    </Card>
  );
}
