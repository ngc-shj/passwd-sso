"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
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
import { SectionCardHeader } from "@/components/settings/section-card-header";
import { fetchApi } from "@/lib/url-helpers";
import { apiPath } from "@/lib/constants";
import { MAX_AUDIT_DELIVERY_TARGETS } from "@/lib/validations/common";
import { formatDateTime } from "@/lib/format-datetime";
import { toast } from "sonner";
import { ChevronDown, Loader2, Plus, RotateCcw, Send, Trash2 } from "lucide-react";

type Kind = "WEBHOOK" | "SIEM_HEC" | "S3_OBJECT";

interface TargetItem {
  id: string;
  kind: string;
  isActive: boolean;
  failCount: number;
  lastError: string | null;
  lastDeliveredAt: string | null;
  createdAt: string;
}

interface ConfigState {
  // WEBHOOK
  url: string;
  secret: string;
  // SIEM_HEC
  hecToken: string;
  index: string;
  sourcetype: string;
  // S3_OBJECT
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}

const defaultConfig: ConfigState = {
  url: "",
  secret: "",
  hecToken: "",
  index: "",
  sourcetype: "",
  bucket: "",
  region: "",
  accessKeyId: "",
  secretAccessKey: "",
  prefix: "",
};

export function AuditDeliveryTargetCard() {
  const t = useTranslations("AuditDeliveryTarget");
  const tCommon = useTranslations("Common");
  const locale = useLocale();

  const [targets, setTargets] = useState<TargetItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<Kind | "">("");
  const [config, setConfig] = useState<ConfigState>(defaultConfig);
  const [urlError, setUrlError] = useState("");
  const [showInactive, setShowInactive] = useState(false);

  const fetchTargets = useCallback(async () => {
    try {
      const res = await fetchApi(apiPath.tenantAuditDeliveryTargets());
      if (res.ok) {
        const data = await res.json();
        setTargets(data.targets ?? []);
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTargets();
  }, [fetchTargets]);

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

  const buildPayload = (): Record<string, string> => {
    if (kind === "WEBHOOK") {
      const p: Record<string, string> = { kind, url: config.url.trim() };
      if (config.secret.trim()) p.secret = config.secret.trim();
      return p;
    }
    if (kind === "SIEM_HEC") {
      const p: Record<string, string> = {
        kind,
        url: config.url.trim(),
        token: config.hecToken.trim(),
      };
      if (config.index.trim()) p.index = config.index.trim();
      if (config.sourcetype.trim()) p.sourcetype = config.sourcetype.trim();
      return p;
    }
    if (kind === "S3_OBJECT") {
      const p: Record<string, string> = {
        kind,
        bucket: config.bucket.trim(),
        region: config.region.trim(),
        accessKeyId: config.accessKeyId.trim(),
        secretAccessKey: config.secretAccessKey.trim(),
      };
      if (config.prefix.trim()) p.prefix = config.prefix.trim();
      return p;
    }
    return {};
  };

  const isCreateDisabled = (): boolean => {
    if (!kind || creating) return true;
    if (kind === "WEBHOOK") return !config.url.trim();
    if (kind === "SIEM_HEC") return !config.url.trim() || !config.hecToken.trim();
    if (kind === "S3_OBJECT") {
      return (
        !config.bucket.trim() ||
        !config.region.trim() ||
        !config.accessKeyId.trim() ||
        !config.secretAccessKey.trim()
      );
    }
    return true;
  };

  const handleCreate = async () => {
    if (!kind) return;

    if (kind === "WEBHOOK" || kind === "SIEM_HEC") {
      const urlValidationError = validateUrl(config.url);
      if (urlValidationError) {
        setUrlError(urlValidationError);
        return;
      }
    }

    setCreating(true);
    setUrlError("");
    try {
      const res = await fetchApi(apiPath.tenantAuditDeliveryTargets(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      if (!res.ok) {
        toast.error(t("createFailed"));
        return;
      }
      toast.success(t("created"));
      setKind("");
      setConfig(defaultConfig);
      fetchTargets();
    } catch {
      toast.error(t("createFailed"));
    } finally {
      setCreating(false);
    }
  };

  const handleToggleActive = async (target: TargetItem) => {
    try {
      const res = await fetchApi(apiPath.tenantAuditDeliveryTargetById(target.id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !target.isActive }),
      });
      if (!res.ok) {
        toast.error(t("updateFailed"));
        return;
      }
      toast.success(target.isActive ? t("deactivated") : t("reactivated"));
      fetchTargets();
    } catch {
      toast.error(t("updateFailed"));
    }
  };

  const setConfigField = (field: keyof ConfigState, value: string) => {
    setConfig((prev) => ({ ...prev, [field]: value }));
    if (field === "url") setUrlError("");
  };

  const kindBadgeVariant = (k: string): "default" | "secondary" | "outline" => {
    if (k === "WEBHOOK") return "default";
    if (k === "SIEM_HEC") return "secondary";
    return "outline";
  };

  const kindLabel = (k: string): string => {
    if (k === "WEBHOOK") return t("kindWebhook");
    if (k === "SIEM_HEC") return t("kindSiemHec");
    if (k === "S3_OBJECT") return t("kindS3Object");
    return k;
  };

  const activeTargets = targets.filter((tgt) => tgt.isActive);
  const inactiveTargets = targets.filter((tgt) => !tgt.isActive);
  const limitReached = targets.length >= MAX_AUDIT_DELIVERY_TARGETS;

  const renderTargetItem = (target: TargetItem) => (
    <div
      key={target.id}
      className="flex items-start justify-between border rounded-md p-3"
    >
      <div className="space-y-1 min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant={kindBadgeVariant(target.kind)} className="shrink-0">
            {kindLabel(target.kind)}
          </Badge>
          <Badge
            variant={target.isActive ? "default" : "destructive"}
            className="shrink-0"
          >
            {target.isActive ? t("active") : t("inactive")}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {formatDateTime(target.createdAt, locale)}
          </span>
        </div>
        <div className="text-xs text-muted-foreground space-x-3">
          {target.failCount > 0 && (
            <span className="text-amber-600 dark:text-amber-400">
              {t("failCount", { count: target.failCount })}
            </span>
          )}
          {target.lastDeliveredAt && (
            <span>
              {t("lastDelivered")}: {formatDateTime(target.lastDeliveredAt, locale)}
            </span>
          )}
        </div>
        {target.lastError && (
          <p className="text-xs text-destructive truncate max-w-xs">
            {t("lastError")}: {target.lastError}
          </p>
        )}
      </div>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 mt-0.5">
            {target.isActive ? (
              <Trash2 className="h-4 w-4 text-destructive" />
            ) : (
              <RotateCcw className="h-4 w-4 text-muted-foreground" />
            )}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {target.isActive ? t("deactivateConfirm") : t("reactivateConfirm")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {kindLabel(target.kind)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => handleToggleActive(target)}>
              {target.isActive ? t("deactivate") : t("activate")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );

  return (
    <Card>
      <SectionCardHeader
        icon={Send}
        title={t("title")}
        description={t("description")}
      />
      <CardContent className="space-y-6">
        {/* Create form */}
        <section className="space-y-4">
          <h3 className="text-sm font-medium">{t("addTarget")}</h3>

          {limitReached ? (
            <p className="text-sm text-muted-foreground">
              {t("limitReached", { limit: MAX_AUDIT_DELIVERY_TARGETS })}
            </p>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="target-kind">{t("kind")}</Label>
                <Select
                  value={kind}
                  onValueChange={(v) => {
                    setKind(v as Kind);
                    setConfig(defaultConfig);
                    setUrlError("");
                  }}
                >
                  <SelectTrigger id="target-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="WEBHOOK">{t("kindWebhook")}</SelectItem>
                    <SelectItem value="SIEM_HEC">{t("kindSiemHec")}</SelectItem>
                    <SelectItem value="S3_OBJECT">{t("kindS3Object")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {kind === "WEBHOOK" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="webhook-url">{t("url")}</Label>
                    <Input
                      id="webhook-url"
                      type="url"
                      value={config.url}
                      onChange={(e) => setConfigField("url", e.target.value)}
                      placeholder={t("urlPlaceholder")}
                    />
                    {urlError && (
                      <p className="text-sm text-destructive">{urlError}</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="webhook-secret">{t("secret")}</Label>
                    <Input
                      id="webhook-secret"
                      type="password"
                      value={config.secret}
                      onChange={(e) => setConfigField("secret", e.target.value)}
                      placeholder={t("secretPlaceholder")}
                    />
                  </div>
                </>
              )}

              {kind === "SIEM_HEC" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="hec-url">{t("url")}</Label>
                    <Input
                      id="hec-url"
                      type="url"
                      value={config.url}
                      onChange={(e) => setConfigField("url", e.target.value)}
                      placeholder={t("urlPlaceholder")}
                    />
                    {urlError && (
                      <p className="text-sm text-destructive">{urlError}</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="hec-token">{t("hecToken")}</Label>
                    <Input
                      id="hec-token"
                      type="password"
                      value={config.hecToken}
                      onChange={(e) => setConfigField("hecToken", e.target.value)}
                      placeholder={t("hecTokenPlaceholder")}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="hec-index">{t("index")}</Label>
                    <Input
                      id="hec-index"
                      value={config.index}
                      onChange={(e) => setConfigField("index", e.target.value)}
                      placeholder={t("indexPlaceholder")}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="hec-sourcetype">{t("sourcetype")}</Label>
                    <Input
                      id="hec-sourcetype"
                      value={config.sourcetype}
                      onChange={(e) => setConfigField("sourcetype", e.target.value)}
                      placeholder={t("sourcetypePlaceholder")}
                    />
                  </div>
                </>
              )}

              {kind === "S3_OBJECT" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="s3-bucket">{t("bucket")}</Label>
                    <Input
                      id="s3-bucket"
                      value={config.bucket}
                      onChange={(e) => setConfigField("bucket", e.target.value)}
                      placeholder={t("bucketPlaceholder")}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="s3-region">{t("region")}</Label>
                    <Input
                      id="s3-region"
                      value={config.region}
                      onChange={(e) => setConfigField("region", e.target.value)}
                      placeholder={t("regionPlaceholder")}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="s3-access-key-id">{t("accessKeyId")}</Label>
                    <Input
                      id="s3-access-key-id"
                      value={config.accessKeyId}
                      onChange={(e) => setConfigField("accessKeyId", e.target.value)}
                      placeholder={t("accessKeyIdPlaceholder")}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="s3-secret-access-key">{t("secretAccessKey")}</Label>
                    <Input
                      id="s3-secret-access-key"
                      type="password"
                      value={config.secretAccessKey}
                      onChange={(e) => setConfigField("secretAccessKey", e.target.value)}
                      placeholder={t("secretAccessKeyPlaceholder")}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="s3-prefix">{t("prefix")}</Label>
                    <Input
                      id="s3-prefix"
                      value={config.prefix}
                      onChange={(e) => setConfigField("prefix", e.target.value)}
                      placeholder={t("prefixPlaceholder")}
                    />
                  </div>
                </>
              )}

              {kind && (
                <Button
                  onClick={handleCreate}
                  disabled={isCreateDisabled()}
                  size="sm"
                >
                  {creating ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  {t("addTarget")}
                </Button>
              )}
            </>
          )}
        </section>

        <Separator />

        {/* Target list */}
        <section className="space-y-4">
          <h3 className="text-sm font-medium">{t("registeredTargets")}</h3>
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : targets.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noTargets")}</p>
          ) : (
            <div className="space-y-3">
              {activeTargets.length === 0 && inactiveTargets.length > 0 && (
                <p className="text-sm text-muted-foreground">{t("noActiveTargets")}</p>
              )}
              {activeTargets.map(renderTargetItem)}
              {inactiveTargets.length > 0 && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowInactive((v) => !v)}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ChevronDown
                      className={`h-3 w-3 transition-transform ${showInactive ? "rotate-0" : "-rotate-90"}`}
                    />
                    {t("inactiveTargets", { count: inactiveTargets.length })}
                  </button>
                  {showInactive && (
                    <div className="mt-2 space-y-3">
                      {inactiveTargets.map(renderTargetItem)}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
