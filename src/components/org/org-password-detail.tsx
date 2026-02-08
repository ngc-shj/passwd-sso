"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/passwords/copy-button";
import { Eye, EyeOff, ExternalLink } from "lucide-react";

interface OrgPasswordDetailProps {
  orgId: string;
  passwordId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface PasswordData {
  id: string;
  title: string;
  username: string | null;
  password: string;
  url: string | null;
  notes: string | null;
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
  const [data, setData] = useState<PasswordData | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !passwordId) return;
    setLoading(true);
    setShowPassword(false);

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{data?.title ?? "..."}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : data ? (
          <div className="space-y-4">
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
                  {showPassword ? data.password : "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"}
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
