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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { InactiveItemsSection } from "@/components/settings/shared/inactive-items-section";
import { Separator } from "@/components/ui/separator";
import { KeyRound, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { apiPath } from "@/lib/constants";
import { formatDate } from "@/lib/format/format-datetime";
import { fetchApi } from "@/lib/url-helpers";
import {
  OPERATOR_TOKEN_DEFAULT_EXPIRES_DAYS,
  OPERATOR_TOKEN_NAME_MAX_LENGTH,
} from "@/lib/constants/auth/operator-token";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { reauthenticateWithPasskey } from "@/lib/auth/webauthn/passkey-reauth-client";
import { canUsePasskeyRecovery } from "@/lib/auth/webauthn/can-use-passkey-recovery";
import { RecentSessionRequiredDialog } from "@/components/auth/recent-session-required-dialog";
import { PasskeyReauthDialog } from "@/components/auth/passkey-reauth-dialog";
import { tokenMintApiErrorKey } from "@/lib/http/token-mint-error";

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
  const tApi = useTranslations("ApiErrors");
  const tAuth = useTranslations("Auth");
  const locale = useLocale();

  const [tokens, setTokens] = useState<OperatorToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createdToken, setCreatedToken] = useState<CreatedToken | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [tokenName, setTokenName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState<string>(
    String(OPERATOR_TOKEN_DEFAULT_EXPIRES_DAYS),
  );
  const [showInactive, setShowInactive] = useState(false);
  const [reauthOpen, setReauthOpen] = useState(false);
  const [reauthenticating, setReauthenticating] = useState(false);
  const [reauthError, setReauthError] = useState<string | null>(null);
  const [recentSessionOpen, setRecentSessionOpen] = useState(false);

  const createToken = useCallback(async () => {
    return fetchApi(apiPath.tenantOperatorTokens(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: tokenName.trim(),
        expiresInDays: parseInt(expiresInDays, 10),
      }),
    });
  }, [tokenName, expiresInDays]);

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

  const closeCreateDialog = () => {
    setCreateOpen(false);
    setCreatedToken(null);
    setTokenName("");
    setExpiresInDays(String(OPERATOR_TOKEN_DEFAULT_EXPIRES_DAYS));
  };

  const handleCreate = async () => {
    if (!tokenName.trim()) return;
    setCreating(true);
    try {
      const res = await createToken();
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
          setReauthError(null);
          if (await canUsePasskeyRecovery()) {
            setReauthOpen(true);
          } else {
            setRecentSessionOpen(true);
          }
        } else if (errBody.error === API_ERROR.OPERATOR_TOKEN_LIMIT_EXCEEDED) {
          toast.error(t("limitExceeded"));
        } else {
          const apiKey = tokenMintApiErrorKey(errBody.error);
          toast.error(apiKey ? tApi(apiKey) : t("networkError"));
        }
      }
    } catch {
      toast.error(t("networkError"));
    } finally {
      setCreating(false);
    }
  };

  const handleReauthenticate = async () => {
    setReauthenticating(true);
    setReauthError(null);
    try {
      const result = await reauthenticateWithPasskey();
      if (!result.ok) {
        setReauthError(
          result.error === "AUTHENTICATION_CANCELLED"
            ? tAuth("reauthCancelled")
            : tAuth("reauthFailed"),
        );
        return;
      }

      const retryRes = await createToken();
      if (!retryRes.ok) {
        const errBody = (await retryRes.json().catch(() => ({}))) as {
          error?: string;
        };
        if (errBody.error === API_ERROR.OPERATOR_TOKEN_LIMIT_EXCEEDED) {
          setReauthOpen(false);
          toast.error(t("limitExceeded"));
        } else if (errBody.error === API_ERROR.OPERATOR_TOKEN_STALE_SESSION) {
          if (await canUsePasskeyRecovery()) {
            setReauthError(t("reauthStillRequired"));
          } else {
            setReauthOpen(false);
            setRecentSessionOpen(true);
          }
        } else {
          setReauthError(t("reauthRetryFailed"));
        }
        return;
      }

      const data = (await retryRes.json()) as CreatedToken;
      setCreatedToken(data);
      setTokenName("");
      setExpiresInDays(String(OPERATOR_TOKEN_DEFAULT_EXPIRES_DAYS));
      setReauthOpen(false);
      toast.success(t("tokenCreated"));
      fetchTokens();
    } finally {
      setReauthenticating(false);
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
        <RecentSessionRequiredDialog
          actionLabel={tAuth("recentSessionAction")}
          cancelLabel={t("cancel")}
          description={tAuth("recentSessionDescription")}
          onOpenChange={setRecentSessionOpen}
          open={recentSessionOpen}
          title={tAuth("recentSessionTitle")}
        />
        <p className="text-xs text-muted-foreground">{t("tenantScopeNote")}</p>
        <section className="space-y-3">
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 h-4 w-4" />
            {t("createToken")}
          </Button>
        </section>

        <Separator />

        {/* Token list */}
        <section className="space-y-3">
          <h3 className="text-sm font-medium">{t("issuedTokens")}</h3>
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
                <InactiveItemsSection
                  open={showInactive}
                  onOpenChange={setShowInactive}
                  triggerLabel={t("inactiveTokens", {
                    count: inactiveTokens.length,
                  })}
                >
                  {inactiveTokens.map(renderTokenRow)}
                </InactiveItemsSection>
              )}
            </div>
          )}
        </section>

        <PasskeyReauthDialog
          open={reauthOpen}
          onOpenChange={setReauthOpen}
          title={tAuth("reauthTitle")}
          description={tAuth("reauthDescription")}
          actionLabel={tAuth("reauthAction")}
          cancelLabel={t("cancel")}
          errorMessage={reauthError}
          isReauthenticating={reauthenticating}
          onAction={handleReauthenticate}
        />
      </CardContent>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open) {
            closeCreateDialog();
            return;
          }
          setCreateOpen(true);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("createToken")}</DialogTitle>
            <DialogDescription>{t("createTokenDescription")}</DialogDescription>
          </DialogHeader>

          {createdToken ? (
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label className="text-sm font-medium">{t("tokenCreated")}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    value={createdToken.plaintext}
                    readOnly
                    className="font-mono text-xs"
                  />
                  <CopyButton getValue={() => createdToken.plaintext} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{t("usageHint")}</p>
              <Button variant="outline" size="sm" onClick={closeCreateDialog}>
                OK
              </Button>
            </div>
          ) : (
            <>
              <div className="space-y-4 py-2">
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
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={closeCreateDialog}>
                  {t("cancel")}
                </Button>
                <Button
                  onClick={handleCreate}
                  disabled={creating || !tokenName.trim()}
                >
                  {creating ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  {t("createToken")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
