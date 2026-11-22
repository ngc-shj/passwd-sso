"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
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
import { Loader2, Mail } from "lucide-react";
import { toast } from "sonner";
import { TEAM_ROLE, apiPath } from "@/lib/constants";
import { fetchApi, appUrl } from "@/lib/url-helpers";
import { parseJsonBodyOnce, readApiErrorBody } from "@/lib/http/read-api-error-body";
import { readNonEmptyStringField } from "@/lib/http/read-body-field";
import { API_ERROR, apiErrorToI18nKey } from "@/lib/http/api-error-codes";
import { COPY_OUTCOME, copySecretToClipboard } from "@/lib/clipboard/copy-secret";

interface Props {
  teamId: string;
  onSuccess: () => void;
}

export function TeamInviteByEmailSection({ teamId, onSuccess }: Props) {
  const t = useTranslations("Team");
  const tApi = useTranslations("ApiErrors");
  const [invEmail, setInvEmail] = useState("");
  const [invRole, setInvRole] = useState<string>(TEAM_ROLE.MEMBER);
  const [inviting, setInviting] = useState(false);
  // The link is shown once: the server keeps only the token's digest.
  const [issuedLink, setIssuedLink] = useState<{ email: string; url: string } | null>(null);

  const handleInvite = async () => {
    const email = invEmail.trim();
    if (!email) return;
    setInviting(true);
    setIssuedLink(null);
    try {
      const res = await fetchApi(apiPath.teamInvitations(teamId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role: invRole }),
      });
      if (res.status === 409) {
        const body = await readApiErrorBody(res);
        toast.error(
          body?.error === API_ERROR.ALREADY_A_MEMBER
            ? t("alreadyMember")
            : body?.error === API_ERROR.INVITATION_ALREADY_SENT
            ? t("alreadyInvited")
            : tApi(apiErrorToI18nKey(body?.error))
        );
        setInviting(false);
        return;
      }
      if (!res.ok) {
        throw new Error("Failed");
      }
      // The invitation exists from here on: nothing below may be reported as
      // a failed invitation.
      setInvEmail("");
      onSuccess();

      const token = readNonEmptyStringField(await parseJsonBodyOnce(res), "token");
      if (!token) {
        toast.warning(t("invitedLinkUnavailable"));
        return;
      }

      const inviteUrl = appUrl(`/dashboard/teams/invite/${token}`);
      setIssuedLink({ email, url: inviteUrl });
      // A clipboard refusal, or no clipboard at all (a non-secure origin),
      // leaves the link in the field below. The URL redeems the invitation, so
      // it is copied with the same bounded residency as any other secret.
      const outcome = await copySecretToClipboard(() => inviteUrl);
      toast.success(
        t(outcome === COPY_OUTCOME.OK ? "invitedWithLink" : "invitedLinkNotCopied"),
      );
    } catch {
      toast.error(t("inviteFailed"));
    } finally {
      setInviting(false);
    }
  };

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">{t("inviteByEmailLabel")}</h3>
        <p className="text-xs text-muted-foreground mt-0.5">{t("inviteByEmailDesc")}</p>
      </div>
      <div className="flex flex-col gap-3 md:flex-row md:items-end">
        <div className="flex-1 space-y-2">
          <Label>{t("inviteEmail")}</Label>
          <Input
            type="email"
            value={invEmail}
            onChange={(e) => setInvEmail(e.target.value)}
            placeholder={t("inviteEmailPlaceholder")}
          />
        </div>
        <div className="space-y-2 md:w-32">
          <Label>{t("inviteRole")}</Label>
          <Select value={invRole} onValueChange={setInvRole}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TEAM_ROLE.ADMIN}>{t("roleAdmin")}</SelectItem>
              <SelectItem value={TEAM_ROLE.MEMBER}>{t("roleMember")}</SelectItem>
              <SelectItem value={TEAM_ROLE.VIEWER}>{t("roleViewer")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          onClick={handleInvite}
          disabled={inviting || !invEmail.trim()}
          className="md:self-end"
        >
          {inviting ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Mail className="h-4 w-4 mr-2" />
          )}
          {t("inviteSend")}
        </Button>
      </div>
      {issuedLink && (
        <div className="space-y-2">
          <p className="text-sm font-medium">{t("inviteLinkShownOnce", { email: issuedLink.email })}</p>
          <div className="flex items-center gap-2">
            <Input
              value={issuedLink.url}
              readOnly
              aria-label={t("inviteLinkShownOnce", { email: issuedLink.email })}
              className="font-mono text-xs"
            />
            <CopyButton getValue={() => issuedLink.url} />
          </div>
          {/* The field is the recovery path when the auto-copy was refused, so
              it stays until the user says they are done with it rather than
              on a timer that could hide it before it is copied. */}
          <Button variant="outline" size="sm" onClick={() => setIssuedLink(null)}>
            {t("inviteLinkDone")}
          </Button>
        </div>
      )}
    </section>
  );
}
