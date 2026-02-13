"use client";

import { useEffect, useState, use } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { OrgRoleBadge } from "@/components/org/org-role-badge";
import { Building2, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { API_PATH } from "@/lib/constants";

interface InviteInfo {
  org: { id: string; name: string; slug: string };
  role: string;
  alreadyMember: boolean;
}

export default function AcceptInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const t = useTranslations("Org");
  const router = useRouter();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InviteInfo | null>(null);

  const handleAccept = async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(API_PATH.ORGS_INVITATIONS_ACCEPT, {
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
      setResult(data);
      window.dispatchEvent(new CustomEvent("org-data-changed"));
      toast.success(t("accepted"));
    } catch {
      setError(t("networkError"));
      setLoading(false);
    }
  };

  useEffect(() => {
    // Auto-accept when page loads
    handleAccept();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (result) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center">
        <CheckCircle2 className="h-16 w-16 text-green-500 mb-4" />
        <h1 className="text-2xl font-bold mb-2">{t("accepted")}</h1>
        <p className="text-muted-foreground mb-6">
          {t("acceptInviteDesc", {
            orgName: result.org.name,
            role: result.role,
          })}
        </p>
        <Button onClick={() => router.push(`/dashboard/orgs/${result.org.id}`)}>
          {result.org.name}
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
        <Button variant="outline" onClick={() => router.push("/dashboard")}>
          {t("passwords")}
        </Button>
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
