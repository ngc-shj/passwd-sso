"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertTriangle, Loader2, ShieldAlert } from "lucide-react";
import { apiPath, API_PATH } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import { toast } from "sonner";

interface TenantMember {
  userId: string;
  name: string | null;
  email: string | null;
}

interface BreakGlassDialogProps {
  onGrantCreated: () => void;
}

export function BreakGlassDialog({ onGrantCreated }: BreakGlassDialogProps) {
  const t = useTranslations("Breakglass");
  const tc = useTranslations("Common");
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<TenantMember[]>([]);
  const [targetUserId, setTargetUserId] = useState("");
  const [reason, setReason] = useState("");
  const [incidentRef, setIncidentRef] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (members.length > 0) return;
    fetchApi(API_PATH.TENANT_MEMBERS)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (Array.isArray(data)) {
          setMembers(data.filter((m: { deactivatedAt?: string | null }) => !m.deactivatedAt));
        }
      });
  }, [open, members.length]);

  const handleSubmit = async () => {
    if (reason.length < 10) {
      toast.error(t("reasonTooShort"));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetchApi(apiPath.tenantBreakglass(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetUserId,
          reason,
          incidentRef: incidentRef || undefined,
        }),
      });

      if (res.ok) {
        toast.success(t("grantCreated"));
        setOpen(false);
        setTargetUserId("");
        setReason("");
        setIncidentRef("");
        onGrantCreated();
        return;
      }

      if (res.status === 400) {
        const data = await res.json().catch(() => null);
        if (data?.details?.targetUserId) {
          toast.error(t("selfAccessError"));
        } else {
          toast.error(data?.error ?? t("reasonTooShort"));
        }
      } else if (res.status === 409) {
        toast.error(t("duplicateGrantError"));
      } else if (res.status === 429) {
        toast.error(t("rateLimitExceeded"));
      } else {
        const data = await res.json().catch(() => null);
        toast.error(data?.error ?? "Error");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = targetUserId && reason.length >= 10 && !submitting;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <ShieldAlert className="h-4 w-4 mr-2" />
          {t("requestAccess")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-destructive" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 p-3 flex gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-700 dark:text-amber-300">{t("warning")}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="bg-target">{t("targetUser")}</Label>
            <Select value={targetUserId} onValueChange={setTargetUserId}>
              <SelectTrigger id="bg-target">
                <SelectValue placeholder={t("targetUserPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {members.map((m) => (
                  <SelectItem key={m.userId} value={m.userId}>
                    {m.name ?? m.email ?? m.userId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="bg-reason">{t("reason")}</Label>
            <Textarea
              id="bg-reason"
              placeholder={t("reasonPlaceholder")}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="bg-incident">{t("incidentRef")}</Label>
            <Input
              id="bg-incident"
              placeholder={t("incidentRefPlaceholder")}
              value={incidentRef}
              onChange={(e) => setIncidentRef(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
            {tc("cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {submitting ? t("submitting") : t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
