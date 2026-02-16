"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useVault } from "@/lib/vault-context";
import {
  parseRecoveryKey,
  computeRecoveryVerifierHash,
  unwrapSecretKeyWithRecovery,
  wrapSecretKeyWithRecovery,
} from "@/lib/crypto-recovery";
import {
  deriveWrappingKey,
  wrapSecretKey,
  computePassphraseVerifier,
  generateAccountSalt,
  hexEncode,
} from "@/lib/crypto-client";
import { apiErrorToI18nKey } from "@/lib/api-error-codes";
import { API_PATH } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getStrength, STRENGTH_COLORS } from "@/components/vault/passphrase-strength";
import { Link } from "@/i18n/navigation";
import { ArrowLeft, Loader2, ShieldCheck } from "lucide-react";

type Step = "input" | "new-passphrase";

interface VerifiedData {
  encryptedSecretKey: string;
  iv: string;
  authTag: string;
  hkdfSalt: string;
  accountSalt: string;
  keyVersion: number;
}

export default function RecoveryPage() {
  const tCommon = useTranslations("Common");
  const t = useTranslations("Recovery");
  const tVault = useTranslations("Vault");
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
  const [recoveryKeyBytes, setRecoveryKeyBytes] = useState<Uint8Array | null>(null);

  const strength = getStrength(newPassphrase);
  const isValid =
    newPassphrase.length >= 10 && newPassphrase === confirmPassphrase;

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      // 1. Parse recovery key (validates checksum)
      let key: Uint8Array;
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
      const res = await fetch(API_PATH.VAULT_RECOVERY_KEY_RECOVER, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: "verify", verifierHash }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (err.error === "RECOVERY_KEY_NOT_SET") {
          setError(t("recoveryKeyNotSet"));
        } else if (err.error === "INVALID_RECOVERY_KEY") {
          setError(t("invalidRecoveryKey"));
        } else if (err.error) {
          setError(tApi(apiErrorToI18nKey(err.error)));
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
      setRecoveryKeyBytes(key);
      setStep("new-passphrase");
    } catch {
      setError(tApi("unknownError"));
    } finally {
      setLoading(false);
    }
  }

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid || !verifiedData || !recoveryKeyBytes) return;

    setLoading(true);
    setError("");

    try {
      // 1. Unwrap secretKey using recovery key
      const secretKey = await unwrapSecretKeyWithRecovery(
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
      const res = await fetch(API_PATH.VAULT_RECOVERY_KEY_RECOVER, {
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

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (err.error) {
          setError(tApi(apiErrorToI18nKey(err.error)));
        } else {
          setError(tApi("unknownError"));
        }
        return;
      }

      // Zero sensitive data
      secretKey.fill(0);
      recoveryKeyBytes.fill(0);
      setRecoveryKeyBytes(null);

      setHasRecoveryKey(true);

      // Full reload to re-initialize VaultProvider (client-side nav keeps stale state)
      window.location.href = "/dashboard";
    } catch {
      setError(tApi("unknownError"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {tCommon("back")}
        </Link>

        <div className="flex flex-col items-center gap-2 text-center">
          <ShieldCheck className="h-10 w-10 text-muted-foreground" />
          <h1 className="text-2xl font-bold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>

        {step === "input" && (
          <form onSubmit={handleVerify} className="space-y-4 rounded-lg border bg-card p-6 shadow-sm">
            <div className="space-y-2">
              <Label htmlFor="recovery-key">{t("recoveryKeyLabel")}</Label>
              <Input
                id="recovery-key"
                type="text"
                value={recoveryKeyInput}
                onChange={(e) => setRecoveryKeyInput(e.target.value)}
                placeholder={t("recoveryKeyPlaceholder")}
                className="font-mono"
                autoComplete="off"
                required
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button type="submit" className="w-full" disabled={!recoveryKeyInput || loading}>
              {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {loading ? t("verifying") : t("verified").replace(".", "")}
            </Button>
          </form>
        )}

        {step === "new-passphrase" && (
          <form onSubmit={handleReset} className="space-y-4 rounded-lg border bg-card p-6 shadow-sm">
            <p className="text-sm text-green-600 dark:text-green-400 font-medium">
              {t("verified")}
            </p>

            <div className="space-y-2">
              <Label htmlFor="new-pass">{t("newPassphrase")}</Label>
              <Input
                id="new-pass"
                type="password"
                value={newPassphrase}
                onChange={(e) => setNewPassphrase(e.target.value)}
                placeholder={t("newPassphrasePlaceholder")}
                autoComplete="new-password"
                required
              />
              {newPassphrase && (
                <div className="space-y-1">
                  <div className="flex gap-1">
                    {[0, 1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className={`h-1 flex-1 rounded-full ${
                          i < strength.level
                            ? STRENGTH_COLORS[strength.level]
                            : "bg-muted"
                        }`}
                      />
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {strength.labelKey ? tVault(strength.labelKey) : ""}
                  </p>
                </div>
              )}
              {newPassphrase && newPassphrase.length < 10 && (
                <p className="text-xs text-destructive">
                  {tVault("passphraseMinLength")}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm-pass">{t("confirmNewPassphrase")}</Label>
              <Input
                id="confirm-pass"
                type="password"
                value={confirmPassphrase}
                onChange={(e) => setConfirmPassphrase(e.target.value)}
                placeholder={t("confirmNewPassphrasePlaceholder")}
                autoComplete="new-password"
                required
              />
              {confirmPassphrase && newPassphrase !== confirmPassphrase && (
                <p className="text-xs text-destructive">
                  {tVault("passphraseMismatch")}
                </p>
              )}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button type="submit" className="w-full" disabled={!isValid || loading}>
              {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {loading ? t("resetting") : t("resetPassphrase")}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
