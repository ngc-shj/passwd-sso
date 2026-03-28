"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useLocale } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { CopyButton } from "@/components/passwords/copy-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Loader2, CheckCircle, XCircle, Plus } from "lucide-react";
import { toast } from "sonner";
import { apiPath } from "@/lib/constants";
import { SA_TOKEN_SCOPES } from "@/lib/constants/service-account";
import { formatDateTime } from "@/lib/format-datetime";
import { fetchApi } from "@/lib/url-helpers";

type AccessRequestStatus = "PENDING" | "APPROVED" | "DENIED" | "EXPIRED";

interface ServiceAccountRef {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

interface AccessRequest {
  id: string;
  requestedScope: string;
  status: AccessRequestStatus;
  justification: string | null;
  createdAt: string;
  serviceAccount: ServiceAccountRef | null;
}

const STATUS_VARIANTS: Record<
  AccessRequestStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  PENDING: "default",
  APPROVED: "secondary",
  DENIED: "destructive",
  EXPIRED: "outline",
};

export function AccessRequestCard() {
  const t = useTranslations("UnifiedAccess");
  const tCommon = useTranslations("Common");
  const locale = useLocale();

  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<"ALL" | AccessRequestStatus>("ALL");
  const [approving, setApproving] = useState<string | null>(null);
  const [jitToken, setJitToken] = useState<string | null>(null);
  const [jitTokenOpen, setJitTokenOpen] = useState(false);

  // Create dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [saList, setSaList] = useState<ServiceAccountRef[]>([]);
  const [selectedSaId, setSelectedSaId] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<Set<string>>(new Set());
  const [justification, setJustification] = useState("");
  const [expiresInMinutes, setExpiresInMinutes] = useState("60");

  const fetchRequests = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "ALL") params.set("status", statusFilter);
      const url = `${apiPath.tenantAccessRequests()}?${params.toString()}`;
      const res = await fetchApi(url);
      if (res.ok) {
        const data = await res.json();
        const raw = Array.isArray(data) ? data : data.requests ?? [];
        setRequests(raw);
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    setLoading(true);
    fetchRequests();
  }, [fetchRequests]);

  // Fetch active SAs for create dialog
  const fetchSaList = useCallback(async () => {
    try {
      const res = await fetchApi(apiPath.tenantServiceAccounts());
      if (res.ok) {
        const data = await res.json();
        const list: ServiceAccountRef[] = Array.isArray(data) ? data : data.serviceAccounts ?? [];
        setSaList(list.filter((sa) => sa.isActive));
      }
    } catch {
      // silently fail
    }
  }, []);

  const openCreate = () => {
    setSelectedSaId("");
    setSelectedScopes(new Set());
    setJustification("");
    setExpiresInMinutes("60");
    fetchSaList();
    setCreateOpen(true);
  };

  const handleCreate = async () => {
    if (!selectedSaId || selectedScopes.size === 0) return;
    setCreating(true);
    try {
      const res = await fetchApi(apiPath.tenantAccessRequests(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceAccountId: selectedSaId,
          requestedScope: Array.from(selectedScopes),
          justification: justification.trim() || undefined,
          expiresInMinutes: parseInt(expiresInMinutes, 10) || 60,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        if (res.status === 404) {
          toast.error(t("arSaNotFound"));
        } else if (res.status === 400) {
          toast.error(t("arCreateValidationError"));
        } else {
          toast.error(data?.message ?? t("arCreateFailed"));
        }
        return;
      }
      toast.success(t("arCreated"));
      setCreateOpen(false);
      fetchRequests();
    } catch {
      toast.error(t("arCreateFailed"));
    } finally {
      setCreating(false);
    }
  };

  const handleApprove = async (requestId: string) => {
    setApproving(requestId);
    try {
      const res = await fetchApi(apiPath.tenantAccessRequestApprove(requestId), {
        method: "POST",
        cache: "no-store",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        const code = data?.error ?? "";
        if (res.status === 409 && code === "SA_TOKEN_LIMIT_EXCEEDED") {
          toast.error(t("arTokenLimitExceeded"));
        } else if (res.status === 409 && (code === "SA_NOT_FOUND")) {
          toast.error(t("arSaInactive"));
        } else if (res.status === 409) {
          toast.error(t("arAlreadyProcessed"));
        } else if (res.status === 400 && code === "INVALID_SCOPE") {
          toast.error(t("arInvalidScope"));
        } else {
          toast.error(t("arApproveFailed"));
        }
        return;
      }
      const data = await res.json();
      toast.success(t("arApproved"));
      setJitToken(data.token ?? null);
      setJitTokenOpen(true);
      fetchRequests();
    } catch {
      toast.error(t("arApproveFailed"));
    } finally {
      setApproving(null);
    }
  };

  const handleDeny = async (requestId: string) => {
    try {
      const res = await fetchApi(apiPath.tenantAccessRequestDeny(requestId), {
        method: "POST",
      });
      if (res.ok) {
        toast.success(t("arDenied"));
        fetchRequests();
      } else {
        toast.error(t("arDenyFailed"));
      }
    } catch {
      toast.error(t("arDenyFailed"));
    }
  };

  const statusLabel = (status: AccessRequestStatus) => {
    const map: Record<AccessRequestStatus, string> = {
      PENDING: "arStatusPending",
      APPROVED: "arStatusApproved",
      DENIED: "arStatusDenied",
      EXPIRED: "arStatusExpired",
    };
    return t(map[status]);
  };

  const parseScopes = (scope: string): string[] =>
    typeof scope === "string" ? scope.split(",").filter(Boolean) : [];

  const toggleScope = (scope: string, checked: boolean) => {
    setSelectedScopes((prev) => {
      const next = new Set(prev);
      if (checked) next.add(scope);
      else next.delete(scope);
      return next;
    });
  };

  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{t("accessRequests")}</h3>
        <div className="flex items-center gap-2">
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as "ALL" | AccessRequestStatus)}
          >
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t("arStatusAll")}</SelectItem>
              <SelectItem value="PENDING">{t("arStatusPending")}</SelectItem>
              <SelectItem value="APPROVED">{t("arStatusApproved")}</SelectItem>
              <SelectItem value="DENIED">{t("arStatusDenied")}</SelectItem>
              <SelectItem value="EXPIRED">{t("arStatusExpired")}</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1" />
            {t("arCreate")}
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-4">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : requests.length === 0 ? (
        <p className="text-center text-muted-foreground">{t("noAccessRequests")}</p>
      ) : (
        <div className="space-y-2">
          {requests.map((req) => (
            <div key={req.id} className="border rounded-md p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-1 min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">
                      {req.serviceAccount?.name ?? "—"}
                    </span>
                    <Badge variant={STATUS_VARIANTS[req.status]} className="shrink-0">
                      {statusLabel(req.status)}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {parseScopes(req.requestedScope).map((s) => (
                      <Badge key={s} variant="outline" className="text-xs font-normal">
                        {s}
                      </Badge>
                    ))}
                  </div>
                  {req.justification && (
                    <p className="text-xs text-muted-foreground">{req.justification}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {formatDateTime(req.createdAt, locale)}
                  </p>
                </div>
                {req.status === "PENDING" && (
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => handleApprove(req.id)}
                      disabled={approving === req.id}
                    >
                      {approving === req.id ? (
                        <Loader2 className="h-3 w-3 animate-spin mr-1" />
                      ) : (
                        <CheckCircle className="h-3 w-3 mr-1" />
                      )}
                      {t("arApprove")}
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive">
                          <XCircle className="h-3 w-3 mr-1" />
                          {t("arDeny")}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t("arDenyConfirm")}</AlertDialogTitle>
                          <AlertDialogDescription>{t("arDenyWarning")}</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
                          <AlertDialogAction onClick={() => handleDeny(req.id)}>
                            {t("arDeny")}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create access request dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("arCreateTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>{t("arServiceAccount")}</Label>
              {saList.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("arNoActiveSa")}</p>
              ) : (
                <Select value={selectedSaId} onValueChange={setSelectedSaId}>
                  <SelectTrigger>
                    <SelectValue placeholder={t("arSelectSa")} />
                  </SelectTrigger>
                  <SelectContent>
                    {saList.map((sa) => (
                      <SelectItem key={sa.id} value={sa.id}>
                        {sa.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="space-y-2">
              <Label>{t("arScope")}</Label>
              <div className="border rounded-md p-3 space-y-1 max-h-48 overflow-y-auto">
                {SA_TOKEN_SCOPES.map((scope) => (
                  <label key={scope} className="flex items-center gap-2 text-sm py-0.5">
                    <Checkbox
                      checked={selectedScopes.has(scope)}
                      onCheckedChange={(checked) => toggleScope(scope, !!checked)}
                    />
                    {scope}
                  </label>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label>{t("arJustification")}</Label>
              <Input
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                placeholder={t("arJustificationPlaceholder")}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("arExpiresIn")}</Label>
              <Select value={expiresInMinutes} onValueChange={setExpiresInMinutes}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="30">{t("arExpiry30m")}</SelectItem>
                  <SelectItem value="60">{t("arExpiry1h")}</SelectItem>
                  <SelectItem value="240">{t("arExpiry4h")}</SelectItem>
                  <SelectItem value="480">{t("arExpiry8h")}</SelectItem>
                  <SelectItem value="1440">{t("arExpiry24h")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {tCommon("cancel")}
            </Button>
            <Button
              onClick={handleCreate}
              disabled={creating || !selectedSaId || selectedScopes.size === 0}
            >
              {creating && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              {t("arCreate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* JIT token display dialog */}
      <Dialog
        open={jitTokenOpen}
        onOpenChange={(open) => {
          setJitTokenOpen(open);
          if (!open) setJitToken(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("arJitToken")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {jitToken && (
              <div className="flex items-center gap-2">
                <Input value={jitToken} readOnly autoComplete="off" className="font-mono text-xs" />
                <CopyButton getValue={() => jitToken} />
              </div>
            )}
            <p className="text-xs text-amber-600 dark:text-amber-400 font-medium">
              {t("arJitTokenWarning")}
            </p>
            <p className="text-xs text-muted-foreground">{t("arJitTokenTtl")}</p>
            <Button variant="outline" size="sm" onClick={() => { setJitTokenOpen(false); setJitToken(null); }}>
              OK
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
