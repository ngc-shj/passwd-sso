"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/passwords/copy-button";
import { TOTPField, type TOTPEntry } from "@/components/passwords/totp-field";
import { cn } from "@/lib/utils";
import { getTagColorClass } from "@/lib/dynamic-styles";
import { Eye, EyeOff, ExternalLink } from "lucide-react";

interface CustomField {
  label: string;
  value: string;
  type: "text" | "hidden" | "url";
}

interface OrgPasswordDetailProps {
  orgId: string;
  passwordId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface PasswordData {
  id: string;
  entryType?: "LOGIN" | "SECURE_NOTE";
  title: string;
  username: string | null;
  password: string;
  content?: string;
  url: string | null;
  notes: string | null;
  customFields: CustomField[];
  totp: TOTPEntry | null;
  tags: { id: string; name: string; color: string | null }[];
  createdBy: { name: string | null };
  updatedBy: { name: string | null };
  createdAt: string;
  updatedAt: string;
}

export function OrgPasswordDetail({
  orgId,
  passwordId,
  open,
  onOpenChange,
}: OrgPasswordDetailProps) {
  const t = useTranslations("PasswordDetail");
  const tf = useTranslations("PasswordForm");
  const [data, setData] = useState<PasswordData | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [hiddenFieldsVisible, setHiddenFieldsVisible] = useState<Set<number>>(
    new Set()
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !passwordId) return;
    setLoading(true);
    setShowPassword(false);
    setHiddenFieldsVisible(new Set());

    fetch(`/api/orgs/${orgId}/passwords/${passwordId}`)
      .then((res) => {
        if (!res.ok) throw new Error("Not found");
        return res.json();
      })
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [open, passwordId, orgId]);

  // Auto-hide password after 30 seconds
  useEffect(() => {
    if (!showPassword) return;
    const timer = setTimeout(() => setShowPassword(false), 30_000);
    return () => clearTimeout(timer);
  }, [showPassword]);

  const toggleHiddenField = (idx: number) => {
    setHiddenFieldsVisible((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{data?.title ?? "..."}</DialogTitle>
          <DialogDescription className="sr-only">
            {data?.title ?? "..."}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : data ? (
          <div className="space-y-4">
            {data.entryType === "SECURE_NOTE" ? (
              /* Secure Note: show content */
              <div>
                <p className="text-xs text-muted-foreground mb-1">
                  {t("content")}
                </p>
                <div className="flex items-start gap-2">
                  <p className="flex-1 text-sm whitespace-pre-wrap font-mono rounded-md bg-muted p-3 max-h-96 overflow-y-auto">
                    {data.content}
                  </p>
                  <CopyButton getValue={() => data.content ?? ""} />
                </div>
              </div>
            ) : (
              <>
                {data.username && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">
                      {t("username")}
                    </p>
                    <div className="flex items-center gap-2">
                      <p className="text-sm flex-1 font-mono">{data.username}</p>
                      <CopyButton getValue={() => data.username!} />
                    </div>
                  </div>
                )}

                <div>
                  <p className="text-xs text-muted-foreground mb-1">
                    {t("password")}
                  </p>
                  <div className="flex items-center gap-2">
                    <p className="text-sm flex-1 font-mono">
                      {showPassword
                        ? data.password
                        : "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"}
                    </p>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setShowPassword(!showPassword)}
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
                    <p className="text-xs text-muted-foreground mt-1">
                      {t("autoHide")}
                    </p>
                  )}
                </div>

                {/* TOTP */}
                {data.totp && (
                  <TOTPField mode="display" totp={data.totp} />
                )}

                {data.url && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">
                      {t("url")}
                    </p>
                    <div className="flex items-center gap-2">
                      <p className="text-sm flex-1 truncate">{data.url}</p>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => window.open(data.url!, "_blank")}
                      >
                        <ExternalLink className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}

                {data.notes && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">
                      {t("notes")}
                    </p>
                    <p className="text-sm whitespace-pre-wrap">{data.notes}</p>
                  </div>
                )}

                {/* Custom Fields */}
                {data.customFields.length > 0 && (
                  <div className="space-y-3">
                    <p className="text-xs text-muted-foreground font-medium">
                      {tf("customFields")}
                    </p>
                    {data.customFields.map((field, idx) => (
                      <div key={idx}>
                        <p className="text-xs text-muted-foreground mb-1">
                          {field.label}
                        </p>
                        <div className="flex items-center gap-2">
                          {field.type === "hidden" ? (
                            <>
                              <p className="text-sm flex-1 font-mono">
                                {hiddenFieldsVisible.has(idx)
                                  ? field.value
                                  : "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"}
                              </p>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => toggleHiddenField(idx)}
                              >
                                {hiddenFieldsVisible.has(idx) ? (
                                  <EyeOff className="h-4 w-4" />
                                ) : (
                                  <Eye className="h-4 w-4" />
                                )}
                              </Button>
                            </>
                          ) : field.type === "url" ? (
                            <>
                              <p className="text-sm flex-1 truncate">
                                {field.value}
                              </p>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() =>
                                  window.open(field.value, "_blank")
                                }
                              >
                                <ExternalLink className="h-4 w-4" />
                              </Button>
                            </>
                          ) : (
                            <p className="text-sm flex-1">{field.value}</p>
                          )}
                          <CopyButton getValue={() => field.value} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* Tags */}
            {data.tags.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">
                  {tf("tags")}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {data.tags.map((tag) => {
                    const colorClass = getTagColorClass(tag.color);
                    return (
                      <Badge
                        key={tag.id}
                        variant="secondary"
                        className={cn(
                          colorClass && "tag-color",
                          colorClass
                        )}
                      >
                        {tag.name}
                      </Badge>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="border-t pt-3 space-y-1 text-xs text-muted-foreground">
              <p>
                {t("created")}:{" "}
                {new Date(data.createdAt).toLocaleString()}
                {data.createdBy.name && ` (${data.createdBy.name})`}
              </p>
              <p>
                {t("updated")}:{" "}
                {new Date(data.updatedAt).toLocaleString()}
                {data.updatedBy.name && ` (${data.updatedBy.name})`}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-center text-muted-foreground py-8">
            {t("notFound")}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
