"use client";

import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { useEmergencyInviteResponse } from "@/hooks/vault/use-emergency-invite-response";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ShieldCheck, ShieldX, Lock } from "lucide-react";

export default function AcceptEmergencyInvitePage() {
  const t = useTranslations("EmergencyAccess");
  const params = useParams();
  const token = params.token as string;
  const { loading, vaultLocked, handleAccept, handleDecline } = useEmergencyInviteResponse(token);

  // We don't have a pre-flight endpoint; we show a generic token-based form
  // directly. The grant info is revealed after an accept/reject attempt.

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6">
      <div className="mx-auto flex max-w-md items-center justify-center pt-16">
        <Card className="w-full rounded-xl border">
          <CardHeader className="text-center">
            <CardTitle className="flex items-center justify-center gap-2 text-xl">
              <ShieldCheck className="h-5 w-5" />
              {t("acceptInvite")}
            </CardTitle>
            <CardDescription>{t("acceptInviteDesc", { ownerName: "" })}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {vaultLocked && (
              <div className="flex items-center gap-2 rounded-lg bg-yellow-500/10 p-3 text-sm text-yellow-700 dark:text-yellow-400">
                <Lock className="h-4 w-4" />
                {t("vaultUnlockRequired")}
              </div>
            )}

            <div className="flex gap-2">
              <Button
                className="flex-1"
                onClick={handleAccept}
                disabled={loading || vaultLocked}
              >
                <ShieldCheck className="mr-1 h-4 w-4" />
                {t("accept")}
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                onClick={handleDecline}
                disabled={loading}
              >
                <ShieldX className="mr-1 h-4 w-4" />
                {t("decline")}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
