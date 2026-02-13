"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { useVault } from "@/lib/vault-context";
import { VAULT_STATUS, API_PATH } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { useRouter } from "@/i18n/navigation";
import { ShieldCheck, ShieldX, Lock } from "lucide-react";
import {
  generateECDHKeyPair,
  exportPublicKey,
  exportPrivateKey,
  encryptPrivateKey,
} from "@/lib/crypto-emergency";
import { API_ERROR, eaErrorToI18nKey } from "@/lib/api-error-codes";

export default function AcceptEmergencyInvitePage() {
  const t = useTranslations("EmergencyAccess");
  const params = useParams();
  const token = params.token as string;
  const router = useRouter();
  const { status: vaultStatus, encryptionKey } = useVault();
  const [loading, setLoading] = useState(false);

  const [grantInfo, setGrantInfo] = useState<{
    ownerName: string;
    waitDays: number;
  } | null>(null);

  // We don't have a pre-flight endpoint; we'll show the token-based form directly
  useEffect(() => {
    // The grant info will be revealed after accept/reject attempt
    // For now, show a generic invitation card
    setGrantInfo({ ownerName: "", waitDays: 0 });
  }, [token]);

  const handleAccept = async () => {
    if (!encryptionKey) {
      toast.error(t("vaultUnlockRequired"));
      return;
    }

    setLoading(true);
    try {
      // Generate ECDH key pair
      const keyPair = await generateECDHKeyPair();
      const publicKeyJwk = await exportPublicKey(keyPair.publicKey);
      const privateKeyBytes = await exportPrivateKey(keyPair.privateKey);

      // Encrypt private key with grantee's vault encryption key
      const encryptedPrivKey = await encryptPrivateKey(privateKeyBytes, encryptionKey);

      const res = await fetch(API_PATH.EMERGENCY_ACCESS_ACCEPT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          granteePublicKey: publicKeyJwk,
          encryptedPrivateKey: {
            ciphertext: encryptedPrivKey.ciphertext,
            iv: encryptedPrivKey.iv,
            authTag: encryptedPrivKey.authTag,
          },
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        // Token-based NOT_FOUND means invalid/expired invitation (better UX message)
        if (data?.error === API_ERROR.NOT_FOUND) {
          toast.error(t("invalidInvitation"));
        } else {
          toast.error(t(eaErrorToI18nKey(data?.error)));
        }
        return;
      }

      toast.success(t("accepted"));
      router.push("/dashboard/emergency-access");
    } catch {
      toast.error(t("networkError"));
    } finally {
      setLoading(false);
    }
  };

  const handleDecline = async () => {
    setLoading(true);
    try {
      const res = await fetch(API_PATH.EMERGENCY_ACCESS_REJECT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        if (data?.error === API_ERROR.NOT_FOUND) {
          toast.error(t("invalidInvitation"));
        } else {
          toast.error(t(eaErrorToI18nKey(data?.error)));
        }
        return;
      }

      toast.success(t("declined"));
      router.push("/dashboard/emergency-access");
    } catch {
      toast.error(t("networkError"));
    } finally {
      setLoading(false);
    }
  };

  if (!grantInfo) return null;

  const vaultLocked = vaultStatus !== VAULT_STATUS.UNLOCKED;

  return (
    <div className="mx-auto flex max-w-md items-center justify-center p-4 pt-20">
      <Card className="w-full">
        <CardHeader className="text-center">
          <CardTitle className="flex items-center justify-center gap-2">
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
  );
}
