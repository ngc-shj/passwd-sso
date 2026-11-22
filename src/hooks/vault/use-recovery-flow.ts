"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useVault } from "@/lib/vault/vault-context";
import {
  parseRecoveryKey,
  computeRecoveryVerifierHash,
  unwrapSecretKeyWithRecovery,
  wrapSecretKeyWithRecovery,
} from "@/lib/crypto/crypto-recovery";
import {
  deriveWrappingKey,
  wrapSecretKey,
  computePassphraseVerifier,
  generateAccountSalt,
  hexEncode,
} from "@/lib/crypto/crypto-client";
import { API_ERROR, apiErrorToI18nKey } from "@/lib/http/api-error-codes";
import { readApiErrorBody } from "@/lib/http/read-api-error-body";
import { API_PATH } from "@/lib/constants";
import { getStrength } from "@/components/vault/passphrase-strength";
import { fetchApi, hardNavigate } from "@/lib/url-helpers";

// "reset-invalidation-failed": the reset committed but the server could not
// sign out other sessions (SESSION_INVALIDATE_FAILED); the user is told so
// before continuing to the dashboard.
type Step = "input" | "new-passphrase" | "reset-invalidation-failed";

interface VerifiedData {
  encryptedSecretKey: string;
  iv: string;
  authTag: string;
  hkdfSalt: string;
  accountSalt: string;
  keyVersion: number;
}

/**
 * Two-step vault recovery: verify a recovery key with the server, then re-wrap
 * the vault secret key under a new passphrase and a fresh recovery wrapping.
 */
export function useRecoveryFlow() {
  const locale = useLocale();
  const t = useTranslations("Recovery");
  const tApi = useTranslations("ApiErrors");
  const { setHasRecoveryKey } = useVault();

  const [step, setStep] = useState<Step>("input");
  const [recoveryKeyInput, setRecoveryKeyInput] = useState("");
  const [newPassphrase, setNewPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Stored after verify step
  const [verifiedData, setVerifiedData] = useState<VerifiedData | null>(null);
  // A ref, not state: the unmount cleanup must reach the live buffer to wipe it
  // when the user abandons the flow between verify and reset.
  const recoveryKeyRef = useRef<Uint8Array | null>(null);

  useEffect(
    () => () => {
      recoveryKeyRef.current?.fill(0);
      recoveryKeyRef.current = null;
    },
    [],
  );

  const strength = getStrength(newPassphrase);
  const isValid =
    newPassphrase.length >= 10 && newPassphrase === confirmPassphrase;

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    // Wiped on every exit except the hand-off to the reset step.
    let key: Uint8Array | null = null;
    try {
      // 1. Parse recovery key (validates checksum)
      try {
        key = await parseRecoveryKey(recoveryKeyInput);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg === "INVALID_CHECKSUM") {
          setError(t("invalidChecksum"));
        } else {
          setError(t("invalidRecoveryKey"));
        }
        return;
      }

      // 2. Compute verifier hash
      const verifierHash = await computeRecoveryVerifierHash(key);

      // 3. Verify with server
      const res = await fetchApi(API_PATH.VAULT_RECOVERY_KEY_RECOVER, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: "verify", verifierHash }),
      });

      if (!res.ok) {
        const body = await readApiErrorBody(res);
        if (body?.error === "RECOVERY_KEY_NOT_SET") {
          setError(t("recoveryKeyNotSet"));
        } else if (body?.error === "INVALID_RECOVERY_KEY") {
          setError(t("invalidRecoveryKey"));
        } else if (body?.error) {
          setError(tApi(apiErrorToI18nKey(body.error)));
        } else {
          setError(tApi("unknownError"));
        }
        return;
      }

      const data = await res.json();
      setVerifiedData({
        encryptedSecretKey: data.encryptedSecretKey,
        iv: data.iv,
        authTag: data.authTag,
        hkdfSalt: data.hkdfSalt,
        accountSalt: data.accountSalt,
        keyVersion: data.keyVersion,
      });
      recoveryKeyRef.current?.fill(0);
      recoveryKeyRef.current = key;
      key = null;
      setStep("new-passphrase");
    } catch {
      setError(tApi("unknownError"));
    } finally {
      key?.fill(0);
      setLoading(false);
    }
  }

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    const recoveryKeyBytes = recoveryKeyRef.current;
    if (!isValid || !verifiedData || !recoveryKeyBytes) return;

    setLoading(true);
    setError("");

    let secretKey: Uint8Array | null = null;
    try {
      // 1. Unwrap secretKey using recovery key
      secretKey = await unwrapSecretKeyWithRecovery(
        {
          encryptedSecretKey: verifiedData.encryptedSecretKey,
          iv: verifiedData.iv,
          authTag: verifiedData.authTag,
        },
        recoveryKeyBytes,
        verifiedData.hkdfSalt,
      );

      // 2. Re-wrap secretKey with new passphrase
      const newAccountSalt = generateAccountSalt();
      const newWrappingKey = await deriveWrappingKey(newPassphrase, newAccountSalt);
      const newWrapped = await wrapSecretKey(secretKey, newWrappingKey);
      const newVerifierHash = await computePassphraseVerifier(
        newPassphrase,
        newAccountSalt,
      );

      // 3. Re-wrap recovery key data
      const recoveryWrapped = await wrapSecretKeyWithRecovery(
        secretKey,
        recoveryKeyBytes,
      );

      // 4. Compute verifier hash for the step
      const verifierHash = await computeRecoveryVerifierHash(recoveryKeyBytes);

      // 5. Send reset request
      const res = await fetchApi(API_PATH.VAULT_RECOVERY_KEY_RECOVER, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          step: "reset",
          verifierHash,
          encryptedSecretKey: newWrapped.ciphertext,
          secretKeyIv: newWrapped.iv,
          secretKeyAuthTag: newWrapped.authTag,
          accountSalt: hexEncode(newAccountSalt),
          newVerifierHash,
          recoveryEncryptedSecretKey: recoveryWrapped.encryptedSecretKey,
          recoverySecretKeyIv: recoveryWrapped.iv,
          recoverySecretKeyAuthTag: recoveryWrapped.authTag,
          recoveryHkdfSalt: recoveryWrapped.hkdfSalt,
          recoveryVerifierHash: recoveryWrapped.verifierHash,
        }),
      });

      // SESSION_INVALIDATE_FAILED is returned after the reset committed, so
      // it is a success with a warning, not a retryable failure.
      let invalidationFailed = false;
      if (!res.ok) {
        const body = await readApiErrorBody(res);
        if (body?.error === API_ERROR.SESSION_INVALIDATE_FAILED) {
          invalidationFailed = true;
        } else {
          if (body?.error) {
            setError(tApi(apiErrorToI18nKey(body.error)));
          } else {
            setError(tApi("unknownError"));
          }
          return;
        }
      }

      recoveryKeyBytes.fill(0);
      recoveryKeyRef.current = null;
      setVerifiedData(null);
      setHasRecoveryKey(true);

      if (invalidationFailed) {
        setStep("reset-invalidation-failed");
        return;
      }
      continueToDashboard();
    } catch {
      setError(tApi("unknownError"));
    } finally {
      // Always zero secretKey regardless of success/failure
      secretKey?.fill(0);
      setLoading(false);
    }
  }

  function continueToDashboard() {
    // Full reload to re-initialize VaultProvider (client-side nav keeps stale state)
    hardNavigate(`/${locale}/dashboard`);
  }

  return {
    step,
    recoveryKeyInput,
    setRecoveryKeyInput,
    newPassphrase,
    setNewPassphrase,
    confirmPassphrase,
    setConfirmPassphrase,
    loading,
    error,
    strength,
    isValid,
    handleVerify,
    handleReset,
    continueToDashboard,
  };
}
