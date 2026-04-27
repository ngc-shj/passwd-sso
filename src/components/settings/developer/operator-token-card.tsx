"use client";

import { useEffect, useState, useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SectionCardHeader } from "@/components/settings/account/section-card-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyButton } from "@/components/passwords/shared/copy-button";
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
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { KeyRound, Loader2, Plus, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";
import { apiPath } from "@/lib/constants";
import { formatDate } from "@/lib/format/format-datetime";
import { fetchApi } from "@/lib/url-helpers";
import {
  OPERATOR_TOKEN_DEFAULT_EXPIRES_DAYS,
  OPERATOR_TOKEN_NAME_MAX_LENGTH,
} from "@/lib/constants/auth/operator-token";
import { API_ERROR } from "@/lib/http/api-error-codes";

const TOKEN_STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  active: "default",
  expired: "secondary",
  revoked: "destructive",
};

interface OperatorToken {
  id: string;
  prefix: string;
  name: string;
  scope: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  subjectUserId: string;
  createdByUserId: string;
  subjectUser: { id: string; name: string | null; email: string | null } | null;
  createdBy: { id: string; name: string | null; email: string | null } | null;
}

interface CreatedToken {
  id: string;
  prefix: string;
  plaintext: string;
  name: string;
  scope: string;
  expiresAt: string;
  createdAt: string;
}

export function OperatorTokenCard() {
  const t = useTranslations("OperatorToken");
  const locale = useLocale();

  const [tokens, setTokens] = useState<OperatorToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createdToken, setCreatedToken] = useState<CreatedToken | null>(null);
  const [tokenName, setTokenName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState<string>(
    String(OPERATOR_TOKEN_DEFAULT_EXPIRES_DAYS),
  );
  const [showInactive, setShowInactive] = useState(false);

  const fetchTokens = useCallback(async () => {
    try {
      const res = await fetchApi(apiPath.tenantOperatorTokens());
      if (res.ok) {
        const data = (await res.json()) as { tokens: OperatorToken[] };
        setTokens(data.tokens);
      } else {
        toast.error(t("networkError"));
      }
    } catch {
      toast.error(t("networkError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchTokens();
  }, [fetchTokens]);

  const handleCreate = async () => {
    if (!tokenName.trim()) return;
    setCreating(true);
    try {
      const res = await fetchApi(apiPath.tenantOperatorTokens(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: tokenName.trim(),
          expiresInDays: parseInt(expiresInDays, 10),
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as CreatedToken;
        setCreatedToken(data);
        setTokenName("");
        setExpiresInDays(String(OPERATOR_TOKEN_DEFAULT_EXPIRES_DAYS));
        toast.success(t("tokenCreated"));
        fetchTokens();
      } else {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        if (errBody.error === API_ERROR.OPERATOR_TOKEN_STALE_SESSION) {
          toast.error(t("staleSession"));
        } else if (errBody.error === API_ERROR.OPERATOR_TOKEN_LIMIT_EXCEEDED) {
          toast.error(t("limitExceeded"));
        } else {
          toast.error(t("networkError"));
        }
      }
    } catch {
      toast.error(t("networkError"));
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (tokenId: string) => {
    try {
      const res = await fetchApi(apiPath.tenantOperatorTokenById(tokenId), {
        method: "DELETE",
      });
      if (res.ok) {
        toast.success(t("tokenRevoked"));
        fetchTokens();
      } else {
        toast.error(t("networkError"));
      }
    } catch {
      toast.error(t("networkError"));
    }
  };

  const getTokenStatus = (token: OperatorToken): string => {
    if (token.revokedAt) return "revoked";
    if (new Date(token.expiresAt) < new Date()) return "expired";
    return "active";
  };

  const tokenStatusLabel = (status: string): string => {
    if (status === "active") return t("tokenActive");
    if (status === "expired") return t("tokenExpired");
    return t("tokenRevokedStatus");
  };

  const activeTokens = tokens.filter((tk) => getTokenStatus(tk) === "active");
  const inactiveTokens = tokens.filter((tk) => getTokenStatus(tk) !== "active");

  const renderTokenRow = (token: OperatorToken) => {
    const status = getTokenStatus(token);
    const subjectName =
      token.subjectUser?.name ?? token.subjectUser?.email ?? "—";
    const creatorName =
      token.createdBy?.name ?? token.createdBy?.email ?? "—";
    return (
      <div
        key={token.id}
        className="flex items-center justify-between border rounded-md p-3"
      >
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium font-mono">{token.prefix}…</span>
            <span className="text-sm">{token.name}</span>
            <Badge
              variant={TOKEN_STATUS_VARIANT[status] ?? "outline"}
              className="text-xs"
            >
              {tokenStatusLabel(status)}
            </Badge>
          </div>
          <div className="text-xs text-muted-foreground space-x-3">
            <span>{t("subjectUser", { name: subjectName })}</span>
            {token.subjectUserId !== token.createdByUserId && (
              <span>{t("createdBy", { name: creatorName })}</span>
            )}
            <span>
              {token.lastUsedAt
                ? t("lastUsed", { date: formatDate(token.lastUsedAt, locale) })
                : t("neverUsed")}
            </span>
            <span>
              {t("expiresAt", { date: formatDate(token.expiresAt, locale) })}
            </span>
          </div>
        </div>
        {status === "active" && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm">
                {t("tokenRevoke")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("tokenRevoke")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("tokenRevokeConfirm")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={() => handleRevoke(token.id)}>
                  {t("tokenRevoke")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
    );
  };

  return (
    <Card>
      <SectionCardHeader
        icon={KeyRound}
        title={t("title")}
        description={t("description")}
      />
      <CardContent className="space-y-6">
        <p className="text-xs text-muted-foreground">{t("tenantScopeNote")}</p>

        {/* Create form */}
        <section className="space-y-3 border-t pt-4">
          <h3 className="text-sm font-medium">{t("createToken")}</h3>
          <div className="space-y-2">
            <Label htmlFor="op-token-name">{t("tokenName")}</Label>
            <Input
              id="op-token-name"
              value={tokenName}
              onChange={(e) => setTokenName(e.target.value)}
              placeholder={t("tokenNamePlaceholder")}
              maxLength={OPERATOR_TOKEN_NAME_MAX_LENGTH}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="op-token-expiry">{t("tokenExpiry")}</Label>
            <Select value={expiresInDays} onValueChange={setExpiresInDays}>
              <SelectTrigger id="op-token-expiry">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">{t("expiry7")}</SelectItem>
                <SelectItem value="30">{t("expiry30")}</SelectItem>
                <SelectItem value="60">{t("expiry60")}</SelectItem>
                <SelectItem value="90">{t("expiry90")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            onClick={handleCreate}
            disabled={creating || !tokenName.trim()}
            size="sm"
          >
            {creating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            {t("createToken")}
          </Button>
        </section>

        {/* One-time plaintext display */}
        {createdToken && (
          <section className="border rounded-md p-4 bg-muted/50 space-y-2">
            <p className="text-sm font-medium">{t("tokenCreated")}</p>
            <div className="flex items-center gap-2">
              <Input
                value={createdToken.plaintext}
                readOnly
                className="font-mono text-xs"
              />
              <CopyButton getValue={() => createdToken.plaintext} />
            </div>
            <p className="text-xs text-muted-foreground">{t("usageHint")}</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCreatedToken(null)}
            >
              OK
            </Button>
          </section>
        )}

        {/* Token list */}
        <section className="space-y-3 border-t pt-4">
          <h3 className="text-sm font-medium">{t("tokens")}</h3>
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : tokens.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noTokens")}</p>
          ) : (
            <div className="space-y-3">
              {activeTokens.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("noTokens")}</p>
              ) : (
                activeTokens.map(renderTokenRow)
              )}

              {inactiveTokens.length > 0 && (
                <Collapsible open={showInactive} onOpenChange={setShowInactive}>
                  <CollapsibleTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs gap-1"
                    >
                      {showInactive ? (
                        <ChevronUp className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5" />
                      )}
                      {t("inactiveTokens", { count: inactiveTokens.length })}
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-3 pt-2">
                    {inactiveTokens.map(renderTokenRow)}
                  </CollapsibleContent>
                </Collapsible>
              )}
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
