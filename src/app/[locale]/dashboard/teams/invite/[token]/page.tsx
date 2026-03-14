"use client";

import { useEffect, useState, useRef, use } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { useVault } from "@/lib/vault-context";
import { VAULT_STATUS, API_PATH } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { Building2, CheckCircle2, XCircle, Loader2, Lock, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { fetchApi } from "@/lib/url-helpers";
import { notifyTeamDataChanged } from "@/lib/events";

interface InviteInfo {
  team: { id: string; name: string; slug: string };
  role?: string;
  alreadyMember: boolean;
}

export default function AcceptInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const t = useTranslations("Team");
  const router = useRouter();
  const { status: vaultStatus } = useVault();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InviteInfo | null>(null);
  const acceptedRef = useRef(false);

  const handleAccept = async () => {
    if (acceptedRef.current) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetchApi(API_PATH.TEAMS_INVITATIONS_ACCEPT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });

      if (!res.ok) {
        if (res.status === 410) {
          setError(t("inviteExpired"));
        } else if (res.status === 403 || res.status === 404) {
          setError(t("inviteInvalid"));
        } else {
          setError(t("acceptFailed"));
        }
        setLoading(false);
        return;
      }

      const data: InviteInfo = await res.json();
      acceptedRef.current = true;
      setResult(data);
      notifyTeamDataChanged();
      toast.success(t("accepted"));
    } catch {
      setError(t("networkError"));
      setLoading(false);
    }
  };

  // Auto-accept when vault is unlocked.
  // VaultGate blocks this component from mounting until vault is UNLOCKED,
  // so this effect only fires after vault setup/unlock is complete.
  useEffect(() => {
    if (vaultStatus === VAULT_STATUS.UNLOCKED && !acceptedRef.current) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      handleAccept();
    }
  }, [vaultStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Defense-in-depth: if this component somehow renders while vault is not unlocked,
  // show a message instead of attempting the accept API call.
  if (vaultStatus !== VAULT_STATUS.UNLOCKED) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center">
        <Lock className="h-16 w-16 text-muted-foreground mb-4" />
        <h1 className="text-2xl font-bold mb-2">{t("acceptInvite")}</h1>
        <p className="text-muted-foreground mb-6">{t("vaultRequiredForInvite")}</p>
      </div>
    );
  }

  if (result) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center">
        <CheckCircle2 className="h-16 w-16 text-green-500 mb-4" />
        <h1 className="text-2xl font-bold mb-2">{t("accepted")}</h1>
        <p className="text-muted-foreground mb-6">
          {result.alreadyMember
            ? t("alreadyMember")
            : t("acceptInviteDesc", {
                teamName: result.team.name,
                role: result.role ?? "",
              })}
        </p>
        <Button onClick={() => router.push(`/dashboard/teams/${result.team.id}`)}>
          {result.team.name}
        </Button>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center">
        <XCircle className="h-16 w-16 text-destructive mb-4" />
        <h1 className="text-2xl font-bold mb-2">{t("inviteInvalid")}</h1>
        <p className="text-muted-foreground mb-6">{error}</p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleAccept}>
            <RefreshCw className="h-4 w-4 mr-2" />
            {t("retryAccept")}
          </Button>
          <Button variant="outline" onClick={() => router.push("/dashboard")}>
            {t("passwords")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full p-6 text-center">
      <Building2 className="h-16 w-16 text-muted-foreground mb-4" />
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
      <p className="text-muted-foreground mt-4">{t("acceptInvite")}...</p>
    </div>
  );
}
