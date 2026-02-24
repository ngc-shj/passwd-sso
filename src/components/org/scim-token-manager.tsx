"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { Loader2, Plus, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { apiPath } from "@/lib/constants";
import { formatDate } from "@/lib/format-datetime";

interface ScimToken {
  id: string;
  description: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdBy: { id: string; name: string | null; email: string | null } | null;
}

interface Props {
  orgId: string;
  locale: string;
}

export function ScimTokenManager({ orgId, locale }: Props) {
  const t = useTranslations("Org");
  const [tokens, setTokens] = useState<ScimToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [expiresInDays, setExpiresInDays] = useState<string>("365");

  const scimEndpoint =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/scim/v2`
      : "/api/scim/v2";

  const fetchTokens = useCallback(async () => {
    try {
      const res = await fetch(apiPath.orgScimTokens(orgId));
      if (res.ok) {
        setTokens(await res.json());
      }
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    fetchTokens();
  }, [fetchTokens]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await fetch(apiPath.orgScimTokens(orgId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: description || undefined,
          expiresInDays: expiresInDays === "null" ? null : parseInt(expiresInDays, 10),
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setNewToken(data.token);
        setDescription("");
        setExpiresInDays("365");
        toast.success(t("scimTokenCreated"));
        fetchTokens();
      }
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (tokenId: string) => {
    const res = await fetch(apiPath.orgScimTokenById(orgId, tokenId), {
      method: "DELETE",
    });
    if (res.ok) {
      toast.success(t("scimTokenRevoked"));
      fetchTokens();
    }
  };

  const getTokenStatus = (token: ScimToken) => {
    if (token.revokedAt) return "revoked";
    if (token.expiresAt && new Date(token.expiresAt) < new Date()) return "expired";
    return "active";
  };

  return (
    <Card className="p-6 space-y-6">
      <section>
        <h2 className="text-lg font-semibold">{t("scimTitle")}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t("scimDescription")}
        </p>
      </section>

      {/* SCIM Endpoint URL */}
      <section className="space-y-2">
        <Label>{t("scimEndpointUrl")}</Label>
        <div className="flex items-center gap-2">
          <Input value={scimEndpoint} readOnly className="font-mono text-sm" />
          <CopyButton getValue={() => scimEndpoint} />
        </div>
      </section>

      {/* Create Token Form */}
      <section className="space-y-3 border-t pt-4">
        <h3 className="text-sm font-medium">{t("scimCreateToken")}</h3>
        <div className="space-y-2">
          <Label>{t("scimTokenDescription")}</Label>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("scimTokenDescriptionPlaceholder")}
            maxLength={255}
          />
        </div>
        <div className="space-y-2">
          <Label>{t("scimTokenExpiry")}</Label>
          <Select value={expiresInDays} onValueChange={setExpiresInDays}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="90">{t("scimExpiry90")}</SelectItem>
              <SelectItem value="180">{t("scimExpiry180")}</SelectItem>
              <SelectItem value="365">{t("scimExpiry365")}</SelectItem>
              <SelectItem value="null">{t("scimExpiryNever")}</SelectItem>
            </SelectContent>
          </Select>
          {expiresInDays === "null" && (
            <p className="text-xs text-amber-600 flex items-center gap-1">
              <ShieldAlert className="h-3 w-3" />
              {t("scimExpiryNeverWarning")}
            </p>
          )}
        </div>
        <Button onClick={handleCreate} disabled={creating} size="sm">
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {t("scimCreateToken")}
        </Button>
      </section>

      {/* Newly created token (shown once) */}
      {newToken && (
        <section className="border rounded-md p-4 bg-muted/50 space-y-2">
          <p className="text-sm font-medium">{t("scimTokenCreated")}</p>
          <div className="flex items-center gap-2">
            <Input value={newToken} readOnly className="font-mono text-xs" />
            <CopyButton getValue={() => newToken} />
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setNewToken(null)}
          >
            OK
          </Button>
        </section>
      )}

      {/* Token List */}
      <section className="space-y-3 border-t pt-4">
        <h3 className="text-sm font-medium">{t("scimTokens")}</h3>
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("scimNoTokens")}</p>
        ) : (
          <div className="space-y-3">
            {tokens.map((token) => {
              const status = getTokenStatus(token);
              return (
                <div
                  key={token.id}
                  className="flex items-center justify-between border rounded-md p-3"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {token.description || token.id.slice(0, 8)}
                      </span>
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded ${
                          status === "active"
                            ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                            : status === "expired"
                              ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200"
                              : "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
                        }`}
                      >
                        {status === "active"
                          ? t("scimTokenActive")
                          : status === "expired"
                            ? t("scimTokenExpired")
                            : t("scimTokenRevokedStatus")}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground space-x-3">
                      {token.createdBy && (
                        <span>
                          {t("scimCreatedBy", {
                            name: token.createdBy.name ?? token.createdBy.email ?? "—",
                          })}
                        </span>
                      )}
                      <span>
                        {token.lastUsedAt
                          ? t("scimLastUsed", {
                              date: formatDate(token.lastUsedAt, locale),
                            })
                          : t("scimNeverUsed")}
                      </span>
                      {token.expiresAt && (
                        <span>
                          {t("scimExpiresAt", {
                            date: formatDate(token.expiresAt, locale),
                          })}
                        </span>
                      )}
                    </div>
                  </div>
                  {status === "active" && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="destructive" size="sm">
                          {t("scimTokenRevoke")}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            {t("scimTokenRevoke")}
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            {t("scimTokenRevokeConfirm")}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => handleRevoke(token.id)}
                          >
                            {t("scimTokenRevoke")}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </Card>
  );
}
