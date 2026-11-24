"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useVault } from "@/lib/vault/vault-context";
import { PRE_ROUTE_AND_PRE_TX_REFUSALS } from "@/lib/vault/pre-commit-refusals";
import { computePassphraseVerifier } from "@/lib/crypto/crypto-client";
import {
  generateRecoveryKey,
  formatRecoveryKey,
  wrapSecretKeyWithRecovery,
} from "@/lib/crypto/crypto-recovery";
import { apiErrorToI18nKey, API_ERROR } from "@/lib/http/api-error-codes";
import { readApiErrorBody } from "@/lib/http/read-api-error-body";
import { preventIMESubmit } from "@/lib/ui/ime-guard";
import { copySecretWithoutClear } from "@/lib/clipboard/copy-secret";
import { reportCopyOutcome } from "@/lib/clipboard/report-copy-outcome";
import { API_PATH, LOCAL_STORAGE_KEY } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Copy, AlertTriangle } from "lucide-react";
import { fetchApi, SessionChangedError } from "@/lib/url-helpers";

// ── Core logic (exported for testing) ───────────────────────────

type FlowSuccess = { ok: true; formattedKey: string };
/** Nothing was stored: the POST was refused before the write, or never sent. */
type FlowError = { ok: false; errorCode: string | null };
/**
 * The POST was sent but whether the server stored the new wrap is unknown. If
 * it did, the previous recovery key no longer works and the new one was never
 * shown, so the user must generate another.
 */
type FlowOutcomeUnknown = { ok: false; outcomeUnknown: true };
/** The vault was locked before the POST was sent: nothing was stored. */
type FlowNotStartedVaultLocked = { ok: false; notStartedVaultLocked: true };
/**
 * The server stored the new wrap, but the vault was locked after the POST was
 * sent: the key is not returned (the dialog that would show it is gone), so
 * the previous recovery key no longer works and no one has seen the new one.
 */
type FlowCommittedVaultLocked = { ok: false; committedVaultLocked: true };

/** @internal Exported for testing */
export type GenerateFlowResult =
  | FlowSuccess
  | FlowError
  | FlowOutcomeUnknown
  | FlowNotStartedVaultLocked
  | FlowCommittedVaultLocked;

// Codes that prove the generate POST was refused before its write: the shared
// PRE_ROUTE_AND_PRE_TX_REFUSALS plus VAULT_WRAP_CONFLICT, which
// recovery-key/generate returns when the compare-and-swap matched no
// row — that transaction wrote nothing and committed no audit row. After a
// committed write it only returns 200; a throw inside or after the
// transaction is not an envelope.
const GENERATE_REFUSALS: ReadonlySet<string> = new Set([
  ...PRE_ROUTE_AND_PRE_TX_REFUSALS,
  API_ERROR.VAULT_WRAP_CONFLICT,
]);

/**
 * Pure async flow: generate Recovery Key, wrap secretKey, send to server.
 * Guarantees both `secretKey` and `recoveryKey` are zeroed in `finally`.
 * `vaultLockedSinceStart` reports a vault lock since the caller started: then
 * nothing is sent, and a committed key is not returned.
 *
 * @internal Exported for testing — the component delegates to this function.
 */
export async function generateRecoveryKeyFlow(
  passphrase: string,
  secretKey: Uint8Array,
  accountSalt: Uint8Array,
  vaultLockedSinceStart: () => boolean,
): Promise<GenerateFlowResult> {
  let recoveryKey: Uint8Array | null = null;
  let sent = false;
  try {
    const currentVerifierHash = await computePassphraseVerifier(
      passphrase,
      accountSalt,
    );

    recoveryKey = generateRecoveryKey();
    const wrapped = await wrapSecretKeyWithRecovery(secretKey, recoveryKey);

    if (vaultLockedSinceStart()) return { ok: false, notStartedVaultLocked: true };
    let res: Response;
    sent = true;
    try {
      res = await fetchApi(API_PATH.VAULT_RECOVERY_KEY_GENERATE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentVerifierHash,
          encryptedSecretKey: wrapped.encryptedSecretKey,
          secretKeyIv: wrapped.iv,
          secretKeyAuthTag: wrapped.authTag,
          hkdfSalt: wrapped.hkdfSalt,
          verifierHash: wrapped.verifierHash,
        }),
      });
    } catch (e) {
      // Refused by the proxy before the route ran: nothing was stored.
      if (e instanceof SessionChangedError) return { ok: false, errorCode: API_ERROR.SESSION_CHANGED };
      return { ok: false, outcomeUnknown: true };
    }

    if (!res.ok) {
      const err = await readApiErrorBody(res);
      if (!err || !GENERATE_REFUSALS.has(err.error)) {
        return { ok: false, outcomeUnknown: true };
      }
      // Refused before the write, but there is no dialog left to say why.
      if (vaultLockedSinceStart()) return { ok: false, notStartedVaultLocked: true };
      return { ok: false, errorCode: err.error };
    }

    // Committed. Checked before formatting (no key string is made) and again
    // after the last await, synchronously with the return.
    if (vaultLockedSinceStart()) return { ok: false, committedVaultLocked: true };
    const formattedKey = await formatRecoveryKey(recoveryKey);
    if (vaultLockedSinceStart()) return { ok: false, committedVaultLocked: true };
    return { ok: true, formattedKey };
  } catch {
    // A throw once the POST was sent (formatting a committed key) leaves the
    // user without the key the server may hold. Before it, nothing was stored.
    if (sent) return { ok: false, outcomeUnknown: true };
    if (vaultLockedSinceStart()) return { ok: false, notStartedVaultLocked: true };
    return { ok: false, errorCode: null };
  } finally {
    recoveryKey?.fill(0);
    secretKey.fill(0);
  }
}

// ── Component ───────────────────────────────────────────────────

interface RecoveryKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Step = "passphrase" | "display";

export function RecoveryKeyDialog({
  open,
  onOpenChange,
}: RecoveryKeyDialogProps) {
  const t = useTranslations("Vault");
  const tApi = useTranslations("ApiErrors");
  const tCopy = useTranslations("CopyButton");
  const {
    getSecretKey,
    getAccountSalt,
    verifyPassphrase,
    lock,
    getLockEpoch,
    lockedSince,
    hasRecoveryKey,
    recoveryKeyInvalidated,
    setHasRecoveryKey,
  } = useVault();

  const [step, setStep] = useState<Step>("passphrase");
  const [passphrase, setPassphrase] = useState("");
  const [formattedKey, setFormattedKey] = useState("");
  const [savedConfirm, setSavedConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function resetForm() {
    setStep("passphrase");
    setPassphrase("");
    setFormattedKey("");
    setSavedConfirm(false);
    setError("");
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) resetForm();
    onOpenChange(nextOpen);
  }

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    if (!passphrase) return;

    // A lock from here on unmounts this dialog: what it would show must go
    // to a persistent toast instead, and nothing is sent once it happened.
    const lockEpoch = getLockEpoch();
    const vaultLockedSinceStart = () => lockedSince(lockEpoch);
    // Whether a recovery key existed before this one, for the notices that say
    // the previous one no longer works.
    const hadRecoveryKey = hasRecoveryKey || recoveryKeyInvalidated;

    setLoading(true);
    setError("");

    // Refuse a mistyped passphrase locally, with the vault left unlocked, so
    // that a server INVALID_PASSPHRASE after this check passed is unambiguous.
    const passphraseOk = await verifyPassphrase(passphrase);
    if (vaultLockedSinceStart()) {
      toast.warning(t("recoveryKeyNotStartedVaultLocked"), { duration: Infinity });
      handleOpenChange(false);
      setLoading(false);
      return;
    }
    if (!passphraseOk) {
      setError(tApi("invalidPassphrase"));
      setLoading(false);
      return;
    }

    const secretKey = getSecretKey();
    const accountSalt = getAccountSalt();
    if (!secretKey || !accountSalt) {
      setError(t("vaultMustBeUnlocked"));
      setLoading(false);
      return;
    }

    const result = await generateRecoveryKeyFlow(passphrase, secretKey, accountSalt, vaultLockedSinceStart);

    if (result.ok) {
      setFormattedKey(result.formattedKey);
      setStep("display");
    } else if ("notStartedVaultLocked" in result) {
      toast.warning(t("recoveryKeyNotStartedVaultLocked"), { duration: Infinity });
      handleOpenChange(false);
    } else if ("committedVaultLocked" in result) {
      toast.error(
        t(hadRecoveryKey ? "recoveryKeyCommittedVaultLocked" : "recoveryKeyCommittedVaultLockedFirstKey"),
        { duration: Infinity },
      );
      handleOpenChange(false);
    } else if ("outcomeUnknown" in result) {
      const notice = t(hadRecoveryKey ? "recoveryKeyOutcomeUnknown" : "recoveryKeyOutcomeUnknownFirstKey");
      if (vaultLockedSinceStart()) {
        // The lock unmounted this dialog: the notice must outlive it.
        toast.error(notice, { duration: Infinity });
        handleOpenChange(false);
      } else {
        setError(notice);
      }
    } else if (
      result.errorCode === API_ERROR.VAULT_WRAP_CONFLICT ||
      result.errorCode === API_ERROR.INVALID_PASSPHRASE
    ) {
      // Another writer moved the wrap (a lost compare-and-swap), or the
      // server's verifier refused the passphrase the local wrap accepted:
      // this tab's salt, wrap and key are stale. Lock, as the key-changing
      // flows do; locking unmounts this dialog, so the notice is a toast.
      lock();
      toast.error(t("vaultChangedElsewhere"), { duration: Infinity });
      handleOpenChange(false);
    } else if (result.errorCode) {
      setError(tApi(apiErrorToI18nKey(result.errorCode)));
    } else {
      setError(tApi("unknownError"));
    }

    setLoading(false);
  }

  async function handleCopy() {
    // copySecretWithoutClear, not copySecretToClipboard: the user is told to
    // store the recovery key somewhere permanent, so blanking the clipboard 30s
    // later would break the dialog's own instruction.
    //
    // The previous `catch { // Fallback: select text }` described a fallback the
    // function did not implement — a failed copy of the one secret shown exactly
    // once was completely silent.
    const outcome = await copySecretWithoutClear(() => formattedKey);
    reportCopyOutcome(outcome, {
      tCopy,
      onOk: () => toast.success(t("recoveryKeyCopySuccess")),
    });
  }

  function handleClose() {
    setHasRecoveryKey(true);
    // Remove banner dismiss timestamp so banner won't re-show
    try {
      localStorage.removeItem(LOCAL_STORAGE_KEY.RECOVERY_KEY_BANNER_DISMISSED);
    } catch {
      // Ignore
    }
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("recoveryKeyDialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("recoveryKeyDialogDescription")}
          </DialogDescription>
        </DialogHeader>

        {step === "passphrase" && (
          <form onSubmit={handleGenerate} onKeyDown={preventIMESubmit} className="space-y-4 rounded-lg border bg-muted/20 p-4">
            {(hasRecoveryKey || recoveryKeyInvalidated) && (
              <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-700 dark:text-yellow-400">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  {recoveryKeyInvalidated
                    ? t("recoveryKeyRegenerateInvalidatedWarning")
                    : t("recoveryKeyRegenerateWarning")}
                </p>
              </div>
            )}

            <p className="text-sm text-muted-foreground">
              {t("recoveryKeyEnterPassphrase")}
            </p>

            <div className="space-y-2">
              <Label htmlFor="rk-passphrase">{t("currentPassphrase")}</Label>
              <Input
                id="rk-passphrase"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder={t("currentPassphrasePlaceholder")}
                autoComplete="current-password"
                required
              />
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            <DialogFooter>
              <Button type="submit" disabled={!passphrase || loading}>
                {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {loading ? t("recoveryKeyGenerating") : t("recoveryKey")}
              </Button>
            </DialogFooter>
          </form>
        )}

        {step === "display" && (
          <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
            <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-700 dark:text-yellow-400">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>{t("recoveryKeyWarning")}</p>
            </div>

            <div className="relative rounded-md border bg-background p-3">
              <code className="block break-all font-mono text-sm leading-relaxed">
                {formattedKey}
              </code>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-2 top-2 h-7 w-7"
                onClick={handleCopy}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="rk-saved"
                checked={savedConfirm}
                onCheckedChange={(checked) =>
                  setSavedConfirm(checked === true)
                }
              />
              <Label htmlFor="rk-saved" className="text-sm font-normal">
                {t("recoveryKeySavedConfirm")}
              </Label>
            </div>

            <DialogFooter>
              <Button
                type="button"
                disabled={!savedConfirm}
                onClick={handleClose}
              >
                {t("recoveryKeyClose")}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
