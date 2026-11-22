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
import { eaErrorToI18nKey } from "@/lib/http/api-error-codes";
import { parseJsonBodyOnce, readApiErrorBody } from "@/lib/http/read-api-error-body";
import { readNonEmptyStringField } from "@/lib/http/read-body-field";
import { API_PATH } from "@/lib/constants";
import { fetchApi, appUrl } from "@/lib/url-helpers";
import { COPY_OUTCOME, copySecretToClipboard } from "@/lib/clipboard/copy-secret";
import { CopyButton } from "@/components/passwords/shared/copy-button";

interface CreateGrantDialogProps {
  onCreated: () => void;
}

type CreatedMessageKey =
  | "grantCreatedWithLink"
  | "grantCreatedLinkNotCopied"
  | "grantCreatedLinkUnavailable";

interface CreatedState {
  /** Null when the response carried no usable token. */
  url: string | null;
  message: CreatedMessageKey;
}

export function CreateGrantDialog({ onCreated }: CreateGrantDialogProps) {
  const t = useTranslations("EmergencyAccess");
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [waitDays, setWaitDays] = useState("7");
  const [loading, setLoading] = useState(false);
  const [created, setCreated] = useState<CreatedState | null>(null);

  const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

  // Every close path (Cancel, Done, Esc, overlay, X) lands here. Closing while
  // the POST is in flight would let its result land in a dialog the user has
  // already dismissed, and resetting on close keeps an invite URL from
  // surviving into the next open.
  const handleOpenChange = (next: boolean) => {
    if (next) {
      setOpen(true);
      return;
    }
    if (loading) return;
    setOpen(false);
    setEmail("");
    setWaitDays("7");
    setCreated(null);
  };

  const handleSubmit = async () => {
    if (!email) return;
    if (!isValidEmail(email)) {
      toast.error(t("invalidEmail"));
      return;
    }
    setLoading(true);

    try {
      const res = await fetchApi(API_PATH.EMERGENCY_ACCESS, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ granteeEmail: email, waitDays: Number(waitDays) }),
      });

      if (!res.ok) {
        const body = await readApiErrorBody(res);
        toast.error(t(eaErrorToI18nKey(body?.error)));
        return;
      }

      // The grant exists from here on: nothing below may be reported as a
      // failed creation.
      onCreated();

      const token = readNonEmptyStringField(await parseJsonBodyOnce(res), "token");
      if (!token) {
        setCreated({ url: null, message: "grantCreatedLinkUnavailable" });
        return;
      }

      // The URL redeems the grant invitation, so it is copied with the same
      // bounded residency as any other secret. A refused write leaves the link
      // in the field below for the user to copy.
      const inviteUrl = appUrl(`/dashboard/emergency-access/invite/${token}`);
      const outcome = await copySecretToClipboard(() => inviteUrl);
      setCreated({
        url: inviteUrl,
        message:
          outcome === COPY_OUTCOME.OK ? "grantCreatedWithLink" : "grantCreatedLinkNotCopied",
      });
    } catch {
      toast.error(t("networkError"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          {t("addTrustedContact")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("addTrustedContact")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {created ? (
          <div className="grid gap-4 py-4">
            <p className="text-sm">{t(created.message)}</p>
            {created.url && (
              <div className="grid gap-2">
                <Label htmlFor="grant-invite-url">{t("inviteLinkLabel")}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="grant-invite-url"
                    value={created.url}
                    readOnly
                    className="font-mono text-xs"
                  />
                  <CopyButton getValue={() => created.url ?? ""} />
                </div>
              </div>
            )}
          </div>
        ) : (
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
        )}
        <DialogFooter>
          {created ? (
            <Button onClick={() => handleOpenChange(false)}>{t("done")}</Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={loading}
              >
                {t("cancel")}
              </Button>
              <Button onClick={handleSubmit} disabled={loading || !email || !isValidEmail(email)}>
                {t("createGrant")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
