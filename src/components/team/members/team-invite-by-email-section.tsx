"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
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
import { Loader2, Mail } from "lucide-react";
import { toast } from "sonner";
import { TEAM_ROLE, apiPath } from "@/lib/constants";
import { fetchApi, appUrl } from "@/lib/url-helpers";

interface Props {
  teamId: string;
  onSuccess: () => void;
}

export function TeamInviteByEmailSection({ teamId, onSuccess }: Props) {
  const t = useTranslations("Team");
  const [invEmail, setInvEmail] = useState("");
  const [invRole, setInvRole] = useState<string>(TEAM_ROLE.MEMBER);
  const [inviting, setInviting] = useState(false);

  const handleInvite = async () => {
    if (!invEmail.trim()) return;
    setInviting(true);
    try {
      const res = await fetchApi(apiPath.teamInvitations(teamId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: invEmail.trim(), role: invRole }),
      });
      if (res.status === 409) {
        const data = await res.json();
        toast.error(
          data.error === "ALREADY_A_MEMBER"
            ? t("alreadyMember")
            : t("alreadyInvited")
        );
        setInviting(false);
        return;
      }
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      const inviteUrl = appUrl(`/dashboard/teams/invite/${data.token}`);
      await navigator.clipboard.writeText(inviteUrl);
      toast.success(t("invitedWithLink"));
      setInvEmail("");
      onSuccess();
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
    </section>
  );
}
