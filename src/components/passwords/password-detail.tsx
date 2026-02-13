"use client";

import { useState, useCallback } from "react";
import { useTranslations, useLocale } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Link } from "@/i18n/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { TagBadge } from "@/components/tags/tag-badge";
import { CopyButton } from "./copy-button";
import { Favicon } from "./favicon";
import { TOTPField, type TOTPEntry } from "./totp-field";
import { CUSTOM_FIELD_TYPE, apiPath } from "@/lib/constants";
import type { CustomFieldType } from "@/lib/constants";
import {
  ArrowLeft,
  Edit,
  Trash2,
  Eye,
  EyeOff,
  User,
  Loader2,
  Star,
  Archive,
  ArchiveRestore,
  History,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";

interface PasswordHistoryEntry {
  password: string;
  changedAt: string;
}

interface CustomField {
  label: string;
  value: string;
  type: CustomFieldType;
}

interface PasswordDetailProps {
  data: {
    id: string;
    title: string;
    username: string | null;
    password: string;
    url: string | null;
    notes: string | null;
    tags: Array<{ name: string; color: string | null }>;
    passwordHistory: PasswordHistoryEntry[];
    customFields: CustomField[];
    totp?: TOTPEntry;
    isFavorite: boolean;
    isArchived: boolean;
    createdAt: string;
    updatedAt: string;
  };
}

const REVEAL_TIMEOUT = 30_000; // 30 seconds

function extractHost(url: string | null): string | null {
  if (!url) return null;
  try { return new URL(url).hostname; } catch { return null; }
}

export function PasswordDetail({ data }: PasswordDetailProps) {
  const t = useTranslations("PasswordDetail");
  const tc = useTranslations("Common");
  const locale = useLocale();
  const router = useRouter();
  const urlHost = extractHost(data.url);
  const [showPassword, setShowPassword] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [isFavorite, setIsFavorite] = useState(data.isFavorite);
  const [isArchived, setIsArchived] = useState(data.isArchived);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [revealedHistory, setRevealedHistory] = useState<Set<number>>(new Set());
  const [revealedFields, setRevealedFields] = useState<Set<number>>(new Set());

  const handleReveal = useCallback(() => {
    setShowPassword(true);
    // Auto-hide after 30 seconds for security
    setTimeout(() => setShowPassword(false), REVEAL_TIMEOUT);
  }, []);

  const handleToggleFavorite = async () => {
    const next = !isFavorite;
    setIsFavorite(next);
    try {
      const res = await fetch(apiPath.passwordById(data.id), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isFavorite: next }),
      });
      if (!res.ok) setIsFavorite(!next);
    } catch {
      setIsFavorite(!next);
    }
  };

  const handleToggleArchive = async () => {
    const next = !isArchived;
    setIsArchived(next);
    try {
      const res = await fetch(apiPath.passwordById(data.id), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isArchived: next }),
      });
      if (res.ok) {
        toast.success(next ? t("archived") : t("unarchived"));
      } else {
        setIsArchived(!next);
      }
    } catch {
      setIsArchived(!next);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const res = await fetch(apiPath.passwordById(data.id), {
        method: "DELETE",
      });
      if (res.ok) {
        toast.success(t("deleted"));
        router.push("/dashboard");
        router.refresh();
      } else {
        toast.error(t("failedToDelete"));
      }
    } catch {
      toast.error(t("networkError"));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6">
      <div className="mx-auto max-w-4xl space-y-4">
      <Button
        variant="ghost"
        className="mb-4 gap-2"
        onClick={() => router.push("/dashboard")}
      >
        <ArrowLeft className="h-4 w-4" />
        {tc("back")}
      </Button>

      <Card className="rounded-xl border">
        <CardHeader className="flex flex-row items-center justify-between">
          <div className="space-y-1">
            <CardTitle className="text-xl flex items-center gap-2">
              <Favicon host={urlHost} size={24} className="shrink-0" />
              {data.title}
            </CardTitle>
            {data.tags.length > 0 && (
              <div className="flex gap-1 pt-1">
                {data.tags.map((tag) => (
                  <TagBadge
                    key={tag.name}
                    name={tag.name}
                    color={tag.color}
                  />
                ))}
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={handleToggleArchive}
              title={isArchived ? t("unarchive") : t("archive")}
            >
              {isArchived ? (
                <ArchiveRestore className="h-4 w-4 text-muted-foreground" />
              ) : (
                <Archive className="h-4 w-4 text-muted-foreground" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={handleToggleFavorite}
              title={isFavorite ? t("removeFromFavorites") : t("addToFavorites")}
            >
              <Star
                className={`h-4 w-4 ${isFavorite ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground"}`}
              />
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href={`/dashboard/${data.id}/edit`}>
                <Edit className="h-4 w-4 mr-1" />
                {tc("edit")}
              </Link>
            </Button>
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="destructive" size="sm">
                  <Trash2 className="h-4 w-4 mr-1" />
                  {tc("delete")}
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{t("deletePassword")}</DialogTitle>
                  <DialogDescription>
                    {t("deleteConfirm", { title: data.title })}
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
                    {deleting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    {tc("delete")}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {data.username && (
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground flex items-center gap-1">
                <User className="h-3 w-3" /> {t("username")}
              </label>
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm">{data.username}</span>
                <CopyButton getValue={() => data.username!} />
              </div>
            </div>
          )}

          <div className="space-y-1">
            <label className="text-sm text-muted-foreground">{t("password")}</label>
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm">
                {showPassword ? data.password : "••••••••••••"}
              </span>
              <Button
                variant="ghost"
                size="icon"
                onClick={showPassword ? () => setShowPassword(false) : handleReveal}
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Button>
              <CopyButton getValue={() => data.password} />
            </div>
            {showPassword && (
              <p className="text-xs text-muted-foreground">
                {t("autoHide")}
              </p>
            )}
          </div>

          {/* TOTP */}
          {data.totp && <TOTPField mode="display" totp={data.totp} />}

          {data.url && (
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground flex items-center gap-1">
                <Favicon host={urlHost} size={12} className="shrink-0" /> {t("url")}
              </label>
              <div className="flex items-center gap-2">
                <a
                  href={data.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-blue-600 hover:underline"
                >
                  {data.url}
                </a>
                <CopyButton getValue={() => data.url!} />
              </div>
            </div>
          )}

          {data.notes && (
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">{t("notes")}</label>
              <p className="rounded-lg border bg-muted/30 p-3 text-sm whitespace-pre-wrap">
                {data.notes}
              </p>
            </div>
          )}

          {/* Custom Fields */}
          {data.customFields.length > 0 &&
            data.customFields.map((field, idx) => (
              <div key={idx} className="space-y-1">
                <label className="text-sm text-muted-foreground">
                  {field.label}
                </label>
                <div className="flex items-center gap-2">
                  {field.type === CUSTOM_FIELD_TYPE.URL ? (
                    <a
                      href={field.value}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-blue-600 hover:underline"
                    >
                      {field.value}
                    </a>
                  ) : field.type === CUSTOM_FIELD_TYPE.HIDDEN ? (
                    <>
                      <span className="font-mono text-sm">
                        {revealedFields.has(idx) ? field.value : "••••••••••••"}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          setRevealedFields((prev) => {
                            const next = new Set(prev);
                            if (next.has(idx)) next.delete(idx);
                            else next.add(idx);
                            return next;
                          })
                        }
                      >
                        {revealedFields.has(idx) ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </Button>
                    </>
                  ) : (
                    <span className="text-sm">{field.value}</span>
                  )}
                  <CopyButton getValue={() => field.value} />
                </div>
              </div>
            ))}

          {/* Password History */}
          {data.passwordHistory.length > 0 && (
            <div className="space-y-1">
              <button
                className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setHistoryExpanded(!historyExpanded)}
              >
                {historyExpanded ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                <History className="h-3 w-3" />
                {t("passwordHistory")} ({data.passwordHistory.length})
              </button>
              {historyExpanded && (
                <div className="space-y-2 pl-5 pt-1">
                  {data.passwordHistory.map((entry, idx) => (
                    <div
                      key={idx}
                      className="flex items-center gap-2 rounded-lg border bg-muted/30 p-2"
                    >
                      <div className="flex-1 min-w-0">
                        <span className="font-mono text-xs">
                          {revealedHistory.has(idx)
                            ? entry.password
                            : "••••••••••••"}
                        </span>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {new Date(entry.changedAt).toLocaleString(
                            locale === "ja" ? "ja-JP" : "en-US"
                          )}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0"
                        onClick={() => {
                          setRevealedHistory((prev) => {
                            const next = new Set(prev);
                            if (next.has(idx)) next.delete(idx);
                            else next.add(idx);
                            return next;
                          });
                        }}
                      >
                        {revealedHistory.has(idx) ? (
                          <EyeOff className="h-3.5 w-3.5" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      <CopyButton getValue={() => entry.password} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="pt-4 text-xs text-muted-foreground">
            <p>
              {t("created")}: {new Date(data.createdAt).toLocaleString(locale === "ja" ? "ja-JP" : "en-US")}
            </p>
            <p>
              {t("updated")}: {new Date(data.updatedAt).toLocaleString(locale === "ja" ? "ja-JP" : "en-US")}
            </p>
          </div>
        </CardContent>
      </Card>
      </div>
    </div>
  );
}
