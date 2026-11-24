"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useRouter } from "@/i18n/navigation";
import { useVault } from "@/lib/vault/vault-context";
import { VAULT_STATUS, API_PATH } from "@/lib/constants";
import {
  generateECDHKeyPair,
  exportPublicKey,
  exportPrivateKey,
  encryptPrivateKey,
} from "@/lib/crypto/crypto-emergency";
import { API_ERROR, eaErrorToI18nKey } from "@/lib/http/api-error-codes";
import { fetchApi } from "@/lib/url-helpers";
import { readApiErrorBody } from "@/lib/http/read-api-error-body";

/** Accept or decline an emergency-access invitation identified by its token. */
export function useEmergencyInviteResponse(token: string) {
  const t = useTranslations("EmergencyAccess");
  const router = useRouter();
  const { status: vaultStatus, encryptionKey } = useVault();
  const [loading, setLoading] = useState(false);

  const showResponseError = async (res: Response) => {
    const body = await readApiErrorBody(res);
    // Token-based NOT_FOUND means invalid/expired invitation (better UX message)
    if (body?.error === API_ERROR.NOT_FOUND) {
      toast.error(t("invalidInvitation"));
    } else {
      toast.error(t(eaErrorToI18nKey(body?.error)));
    }
  };

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

      // Encrypt private key with grantee's vault encryption key, then wipe the
      // plaintext PKCS#8 whether or not encryption succeeded.
      const encryptedPrivKey = await encryptPrivateKey(privateKeyBytes, encryptionKey).finally(
        () => privateKeyBytes.fill(0),
      );

      const res = await fetchApi(API_PATH.EMERGENCY_ACCESS_ACCEPT, {
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
        await showResponseError(res);
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
      const res = await fetchApi(API_PATH.EMERGENCY_ACCESS_REJECT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });

      if (!res.ok) {
        await showResponseError(res);
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

  const vaultLocked = vaultStatus !== VAULT_STATUS.UNLOCKED;

  return { loading, vaultLocked, handleAccept, handleDecline };
}
