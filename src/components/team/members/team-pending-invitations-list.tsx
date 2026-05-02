"use client";

import { useLocale, useTranslations } from "next-intl";
import { TeamRoleBadge } from "@/components/team/management/team-role-badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/passwords/shared/copy-button";
import { LinkIcon, X } from "lucide-react";
import { toast } from "sonner";
import { apiPath } from "@/lib/constants";
import { fetchApi, appUrl } from "@/lib/url-helpers";
import { formatDate } from "@/lib/format/format-datetime";

export interface Invitation {
  id: string;
  email: string;
  role: string;
  token: string;
  expiresAt: string;
  invitedBy: { name: string | null };
}

interface Props {
  invitations: Invitation[];
  teamId: string;
  onCancel: () => void;
}

export function TeamPendingInvitationsList({ invitations, teamId, onCancel }: Props) {
  const t = useTranslations("Team");
  const locale = useLocale();

  const handleCancelInvitation = async (invId: string) => {
    try {
      await fetchApi(apiPath.teamInvitationById(teamId, invId), {
        method: "DELETE",
      });
      toast.success(t("invitationCancelled"));
      onCancel();
    } catch {
      toast.error(t("networkError"));
    }
  };

  if (invitations.length === 0) return null;

  return (
    <section className="space-y-4">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <LinkIcon className="h-4 w-4 text-muted-foreground" />
        {t("pendingInvitations")}
      </h3>
      <div className="space-y-2">
        {invitations.map((inv) => (
          <div
            key={inv.id}
            className="flex items-center gap-3 rounded-xl border bg-card/80 p-3 transition-colors hover:bg-accent/30 dark:hover:bg-accent/50"
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{inv.email}</p>
              <p className="text-xs text-muted-foreground">
                {t("expiresAt", { date: formatDate(inv.expiresAt, locale) })}
              </p>
            </div>
            <TeamRoleBadge role={inv.role} />
            <CopyButton
              getValue={() => appUrl(`/dashboard/teams/invite/${inv.token}`)}
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => handleCancelInvitation(inv.id)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}
