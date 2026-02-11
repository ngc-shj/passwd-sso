"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { eaErrorToI18nKey } from "@/lib/api-error-codes";

interface CreateGrantDialogProps {
  onCreated: () => void;
}

export function CreateGrantDialog({ onCreated }: CreateGrantDialogProps) {
  const t = useTranslations("EmergencyAccess");
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [waitDays, setWaitDays] = useState("7");
  const [loading, setLoading] = useState(false);

  const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

  const handleSubmit = async () => {
    if (!email) return;
    if (!isValidEmail(email)) {
      toast.error(t("invalidEmail"));
      return;
    }
    setLoading(true);

    try {
      const res = await fetch("/api/emergency-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ granteeEmail: email, waitDays: Number(waitDays) }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast.error(t(eaErrorToI18nKey(data?.error)));
        return;
      }

      const data = await res.json();
      // Copy invite URL to clipboard
      const inviteUrl = `${window.location.origin}/dashboard/emergency-access/invite/${data.token}`;
      await navigator.clipboard.writeText(inviteUrl);

      toast.success(t("grantCreatedWithLink"));
      setOpen(false);
      setEmail("");
      setWaitDays("7");
      onCreated();
    } catch {
      toast.error(t("networkError"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1 h-4 w-4" />
          {t("addTrustedContact")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("addTrustedContact")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="grantee-email">{t("granteeEmail")}</Label>
            <Input
              id="grantee-email"
              type="email"
              placeholder={t("granteeEmailPlaceholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="wait-days">{t("waitDays")}</Label>
            <Select value={waitDays} onValueChange={setWaitDays}>
              <SelectTrigger id="wait-days">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">{t("waitDays7")}</SelectItem>
                <SelectItem value="14">{t("waitDays14")}</SelectItem>
                <SelectItem value="30">{t("waitDays30")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t("waitDaysDesc")}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t("cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={loading || !email || !isValidEmail(email)}>
            {t("createGrant")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
