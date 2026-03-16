"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Fingerprint, KeyRound, Loader2, Monitor, Plus, ShieldCheck, ShieldOff, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { API_PATH, apiPath } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import { NAME_MAX_LENGTH } from "@/lib/validations";
import { formatDateTime } from "@/lib/format-datetime";
import { useVault } from "@/lib/vault-context";
import { VAULT_STATUS } from "@/lib/constants";
import {
  isWebAuthnSupported,
  startPasskeyRegistration,
  startPasskeyAuthentication,
  wrapSecretKeyWithPrf,
  generateDefaultNickname,
} from "@/lib/webauthn-client";

interface Credential {
  id: string;
  credentialId: string;
  nickname: string | null;
  deviceType: string;
  backedUp: boolean;
  discoverable: boolean | null;
  transports: string[];
  prfSupported: boolean;
  registeredDevice: string | null;
  lastUsedDevice: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export function isNonDiscoverable(cred: Pick<Credential, "discoverable" | "deviceType" | "backedUp">): boolean {
  return cred.discoverable !== null
    ? !cred.discoverable
    : (cred.deviceType === "singleDevice" && !cred.backedUp);
}

function CredentialIcon({ transports }: { transports: string[] }) {
  const isInternal = transports.includes("internal");
  const isUsb = transports.includes("usb");
  const isNfc = transports.includes("nfc");
  const isHybrid = transports.includes("hybrid");

  if (isUsb || isNfc) {
    return <KeyRound className="h-5 w-5 text-muted-foreground shrink-0" />;
  }
  if (isHybrid && !isInternal) {
    return <Smartphone className="h-5 w-5 text-muted-foreground shrink-0" />;
  }
  return <Monitor className="h-5 w-5 text-muted-foreground shrink-0" />;
}

export function PasskeyCredentialsCard() {
  const t = useTranslations("WebAuthn");
  const locale = useLocale();
  const { status, getSecretKey } = useVault();

  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [nickname, setNickname] = useState("");

  // Inline rename state
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Test credential state
  const [testingId, setTestingId] = useState<string | null>(null);

  const vaultUnlocked = status === VAULT_STATUS.UNLOCKED;
  const webAuthnAvailable = isWebAuthnSupported();

  const fetchCredentials = useCallback(async () => {
    try {
      const res = await fetchApi(API_PATH.WEBAUTHN_CREDENTIALS);
      if (res.ok) {
        setCredentials(await res.json());
      } else {
        toast.error(t("fetchError"));
      }
    } catch {
      toast.error(t("fetchError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchCredentials();
  }, [fetchCredentials]);

  const handleRegister = async () => {
    if (!webAuthnAvailable || !vaultUnlocked || registering) return;

    setRegistering(true);
    try {
      // 1. Get registration options from server
      const optionsRes = await fetchApi(API_PATH.WEBAUTHN_REGISTER_OPTIONS, {
        method: "POST",
      });
      if (!optionsRes.ok) {
        const err = await optionsRes.json().catch(() => ({}));
        if (err.error === "RATE_LIMIT_EXCEEDED") {
          toast.error(t("serviceUnavailable"));
        } else if (err.error === "SERVICE_UNAVAILABLE") {
          toast.error(t("serviceUnavailable"));
        } else {
          toast.error(t("registerError"));
        }
        return;
      }

      const { options, prfSalt } = await optionsRes.json();

      // 2. Start WebAuthn registration with PRF
      const { responseJSON, prfOutput } = await startPasskeyRegistration(
        options,
        prfSalt ?? undefined,
      );

      // 3. If PRF supported and vault unlocked, encrypt secretKey.
      //    Capture PRF availability before zeroing the buffer.
      const prfAvailable = !!prfOutput;
      let prfData: Record<string, string> = {};
      if (prfAvailable) {
        const secretKey = getSecretKey();
        if (secretKey) {
          // prfOutput is guaranteed non-null here (guarded by prfAvailable)
          const wrapped = await wrapSecretKeyWithPrf(secretKey, prfOutput!);
          prfData = {
            prfEncryptedSecretKey: wrapped.ciphertext,
            prfSecretKeyIv: wrapped.iv,
            prfSecretKeyAuthTag: wrapped.authTag,
          };
          secretKey.fill(0);
          prfOutput!.fill(0);
        }
      }

      // 4. Resolve nickname: user input or auto-generated from transports
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const transports: string[] = (responseJSON as any).response?.transports ?? [];
      const resolvedNickname = nickname || generateDefaultNickname(transports);

      // 5. Send to server
      const verifyRes = await fetchApi(API_PATH.WEBAUTHN_REGISTER_VERIFY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          response: responseJSON,
          nickname: resolvedNickname,
          ...prfData,
        }),
      });

      if (verifyRes.ok) {
        const result = await verifyRes.json();
        toast.success(t("registerSuccess"));

        if (isNonDiscoverable(result) && !prfAvailable) {
          toast.warning(t("nonDiscoverableNonPrfWarning"));
        } else if (!prfAvailable) {
          toast.warning(t("prfNotSupportedWarning"));
        }

        setNickname("");
        fetchCredentials();
      } else {
        toast.error(t("registerError"));
      }
    } catch (err) {
      if (err instanceof Error) {
        switch (err.message) {
          case "REGISTRATION_CANCELLED":
            return;
          case "REGISTRATION_PENDING":
            toast.warning(t("requestPending"));
            return;
          case "CREDENTIAL_ALREADY_REGISTERED":
            toast.error(t("alreadyRegistered"));
            return;
        }
      }
      console.error("[WebAuthn] Registration failed:", err);
      toast.error(t("registerError"));
    } finally {
      setRegistering(false);
    }
  };

  const handleDelete = async (credentialId: string) => {
    try {
      const res = await fetchApi(apiPath.webauthnCredentialById(credentialId), {
        method: "DELETE",
      });
      if (res.ok) {
        toast.success(t("deleteSuccess"));
        fetchCredentials();
      } else {
        toast.error(t("deleteError"));
      }
    } catch {
      toast.error(t("deleteError"));
    }
  };

  const handleRename = async (id: string) => {
    try {
      const res = await fetchApi(apiPath.webauthnCredentialById(id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: renameValue }),
      });
      if (res.ok) {
        toast.success(t("nicknameUpdated"));
        setRenamingId(null);
        setRenameValue("");
        fetchCredentials();
      } else {
        toast.error(t("nicknameUpdateError"));
      }
    } catch {
      toast.error(t("nicknameUpdateError"));
    }
  };

  const handleTest = async (credentialId: string) => {
    if (testingId) return;
    setTestingId(credentialId);
    try {
      const cred = credentials.find((c) => c.credentialId === credentialId);

      // 1. Get authentication options for this specific credential
      const optionsRes = await fetchApi(API_PATH.WEBAUTHN_AUTHENTICATE_OPTIONS, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentialId }),
      });
      if (!optionsRes.ok) {
        toast.error(t("testError"));
        return;
      }

      const { options, prfSalt } = await optionsRes.json();

      // 2. Authenticate (with PRF if available)
      const { responseJSON, prfOutput: authPrfOutput } = await startPasskeyAuthentication(
        options,
        cred?.prfSupported && prfSalt ? prfSalt : undefined,
      );

      // 3. Verify with server
      const verifyRes = await fetchApi(API_PATH.WEBAUTHN_AUTHENTICATE_VERIFY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: responseJSON }),
      });

      if (verifyRes.ok) {
        toast.success(authPrfOutput ? t("testSuccessWithPrf") : t("testSuccess"));
        fetchCredentials(); // Refresh lastUsedAt
      } else {
        toast.error(t("testError"));
      }
    } catch (err) {
      if (err instanceof Error && err.message === "AUTHENTICATION_CANCELLED") {
        return;
      }
      if (err instanceof Error && err.message === "AUTHENTICATION_PENDING") {
        toast.warning(t("requestPending"));
        return;
      }
      toast.error(t("testError"));
    } finally {
      setTestingId(null);
    }
  };

  const prfCount = credentials.filter((c) => c.prfSupported).length;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Fingerprint className="h-5 w-5" />
          <div>
            <CardTitle>{t("title")}</CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Register section */}
        {webAuthnAvailable && (
          <section className="space-y-3">
            <div className="space-y-2">
              <Label>{t("nickname")}</Label>
              <Input
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder={t("nicknamePlaceholder")}
                maxLength={NAME_MAX_LENGTH}
              />
            </div>
            <Button
              onClick={handleRegister}
              disabled={registering || !vaultUnlocked}
              size="sm"
            >
              {registering ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              {t("register")}
            </Button>
            {!vaultUnlocked && (
              <p className="text-xs text-muted-foreground">
                {t("vaultMustBeUnlocked")}
              </p>
            )}
          </section>
        )}

        {!webAuthnAvailable && (
          <p className="text-sm text-muted-foreground">
            {t("webauthnNotSupported")}
          </p>
        )}

        {/* Credentials list */}
        <section className="space-y-3 border-t pt-4">
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : credentials.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("noPasskeys")}
            </p>
          ) : (
            <div className="space-y-3">
              {credentials.map((cred) => (
                <div
                  key={cred.id}
                  className="flex items-start border rounded-md p-3 gap-3"
                >
                  <div className="mt-0.5">
                    <CredentialIcon transports={cred.transports} />
                  </div>
                  <div className="space-y-1 min-w-0 flex-1">
                    {/* Nickname */}
                    {renamingId === cred.id ? (
                      <div className="flex items-center gap-2">
                        <Input
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          maxLength={NAME_MAX_LENGTH}
                          className="h-7 text-sm"
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleRename(cred.id);
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                          autoFocus
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleRename(cred.id)}
                        >
                          OK
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setRenamingId(null)}
                        >
                          {t("cancel")}
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">
                          {cred.nickname || cred.id.slice(0, 8)}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-5 text-xs px-1.5"
                          onClick={() => {
                            setRenamingId(cred.id);
                            setRenameValue(cred.nickname || "");
                          }}
                        >
                          {t("rename")}
                        </Button>
                      </div>
                    )}

                    {/* Badges — ordered by user relevance:
                         1. Sign-in capability (discoverable vs email-only)
                         2. Vault unlock (PRF)
                         3. Device type */}
                    <div className="flex items-center gap-2 flex-wrap">
                      {/* Discoverable vs non-discoverable credential indicator.
                         Uses credProps.rk (WebAuthn L3) when available,
                         falls back to heuristic (singleDevice + not backed up). */}
                      {isNonDiscoverable(cred) ? (
                        <span
                          className="text-xs px-1.5 py-0.5 rounded bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200"
                          title={t("notDiscoverableDescription")}
                        >
                          {t("notDiscoverable")}
                        </span>
                      ) : (
                        <span
                          className="text-xs px-1.5 py-0.5 rounded bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
                          title={t("discoverableDescription")}
                        >
                          {t("discoverable")}
                        </span>
                      )}
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded inline-flex items-center gap-1 ${
                          cred.prfSupported
                            ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                            : "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200"
                        }`}
                      >
                        {cred.prfSupported ? (
                          <ShieldCheck className="h-3 w-3" />
                        ) : (
                          <ShieldOff className="h-3 w-3" />
                        )}
                        {t("vaultUnlock")}:{" "}
                        {cred.prfSupported
                          ? t("vaultUnlockEnabled")
                          : t("vaultUnlockDisabled")}
                      </span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-muted">
                        {cred.deviceType === "singleDevice"
                          ? t("deviceTypeSingleDevice")
                          : t("deviceTypeMultiDevice")}
                      </span>
                    </div>

                    {/* Metadata */}
                    <div className="text-xs text-muted-foreground space-y-0.5">
                      <div>
                        {t("createdAt")}:{" "}
                        {formatDateTime(cred.createdAt, locale)}
                        {cred.registeredDevice && (
                          <span className="ml-1 text-muted-foreground/70">
                            ({cred.registeredDevice})
                          </span>
                        )}
                      </div>
                      <div>
                        {t("lastUsedAt")}:{" "}
                        {cred.lastUsedAt
                          ? formatDateTime(cred.lastUsedAt, locale)
                          : t("lastUsedNever")}
                        {cred.lastUsedDevice && cred.lastUsedAt && (
                          <span className="ml-1 text-muted-foreground/70">
                            ({cred.lastUsedDevice})
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div className="flex flex-col gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!!testingId}
                      onClick={() => handleTest(cred.credentialId)}
                    >
                      {testingId === cred.credentialId ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Fingerprint className="h-3 w-3" />
                      )}
                      {t("testAuth")}
                    </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="destructive" size="sm">
                        {t("delete")}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {t("deleteConfirmTitle")}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {cred.prfSupported ? t("deleteConfirmPrf") : t("deleteConfirm")}
                          {cred.prfSupported && prfCount === 1 && (
                            <>
                              <br />
                              <br />
                              <strong>{t("lastPrfDeleteWarning")}</strong>
                            </>
                          )}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => handleDelete(cred.id)}
                        >
                          {t("confirm")}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
