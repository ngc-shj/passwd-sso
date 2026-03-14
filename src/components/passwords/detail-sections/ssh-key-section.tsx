"use client";

import { useTranslations } from "next-intl";
import { Eye, EyeOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CopyButton } from "../copy-button";
import { useRevealTimeout } from "@/hooks/use-reveal-timeout";
import type { RequireVerificationFn } from "@/hooks/use-reveal-timeout";
import type { InlineDetailData } from "@/types/entry";
import type { CreateGuardedGetterFn } from "./types";

interface SectionProps {
  data: InlineDetailData;
  requireVerification: RequireVerificationFn;
  createGuardedGetter: CreateGuardedGetterFn;
}

export function SshKeySection({ data, requireVerification, createGuardedGetter }: SectionProps) {
  const t = useTranslations("PasswordDetail");

  const { revealed: showPrivateKey, handleReveal: handleRevealPrivateKey, hide: hidePrivateKey } =
    useRevealTimeout(requireVerification, data.id, data.requireReprompt ?? false);

  const { revealed: showSshPassphrase, handleReveal: handleRevealSshPassphrase, hide: hideSshPassphrase } =
    useRevealTimeout(requireVerification, data.id, data.requireReprompt ?? false);

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      {/* Key Type + Key Size */}
      {data.keyType && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("keyType")}</label>
          <p className="text-sm font-mono">{data.keyType}</p>
        </div>
      )}
      {data.keySize && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("keySize")}</label>
          <p className="text-sm font-mono">{data.keySize}</p>
        </div>
      )}

      {/* Fingerprint */}
      {data.fingerprint && (
        <div className="col-span-2 space-y-1">
          <label className="text-sm text-muted-foreground">{t("fingerprint")}</label>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm break-all">{data.fingerprint}</span>
            <CopyButton getValue={() => data.fingerprint ?? ""} />
          </div>
        </div>
      )}

      {/* Public Key */}
      {data.publicKey && (
        <div className="col-span-2 space-y-1">
          <label className="text-sm text-muted-foreground">{t("publicKey")}</label>
          <div className="flex items-start gap-2">
            <pre className="rounded-lg border bg-muted/30 p-3 text-xs font-mono whitespace-pre-wrap break-all flex-1 overflow-hidden">
              {data.publicKey}
            </pre>
            <CopyButton getValue={() => data.publicKey ?? ""} />
          </div>
        </div>
      )}

      {/* Private Key */}
      {data.privateKey && (
        <div className="col-span-2 space-y-1">
          <label className="text-sm text-muted-foreground">{t("privateKey")}</label>
          <div className="flex items-start gap-2">
            <pre className="rounded-lg border bg-muted/30 p-3 text-xs font-mono whitespace-pre-wrap break-all flex-1 overflow-hidden">
              {showPrivateKey ? data.privateKey : "••••••••"}
            </pre>
            <div className="flex flex-col gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={showPrivateKey ? hidePrivateKey : handleRevealPrivateKey}
              >
                {showPrivateKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
              <CopyButton
                getValue={createGuardedGetter(
                  data.id,
                  data.requireReprompt ?? false,
                  () => data.privateKey ?? "",
                )}
              />
            </div>
          </div>
          {showPrivateKey && (
            <p className="text-xs text-muted-foreground">{t("autoHide")}</p>
          )}
        </div>
      )}

      {/* Passphrase */}
      {data.sshPassphrase && (
        <div className="col-span-2 space-y-1">
          <label className="text-sm text-muted-foreground">{t("passphrase")}</label>
          <div className="flex items-center gap-2">
            <span className="text-sm font-mono">
              {showSshPassphrase ? data.sshPassphrase : "••••••••"}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={showSshPassphrase ? hideSshPassphrase : handleRevealSshPassphrase}
            >
              {showSshPassphrase ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            <CopyButton
              getValue={createGuardedGetter(
                data.id,
                data.requireReprompt ?? false,
                () => data.sshPassphrase ?? "",
              )}
            />
          </div>
          {showSshPassphrase && (
            <p className="text-xs text-muted-foreground">{t("autoHide")}</p>
          )}
        </div>
      )}

      {/* Comment */}
      {data.sshComment && (
        <div className="col-span-2 space-y-1">
          <label className="text-sm text-muted-foreground">{t("comment")}</label>
          <div className="flex items-center gap-2">
            <span className="text-sm">{data.sshComment}</span>
            <CopyButton getValue={() => data.sshComment ?? ""} />
          </div>
        </div>
      )}

      {/* Notes */}
      {data.notes && (
        <div className="col-span-2 space-y-1">
          <label className="text-sm text-muted-foreground">{t("notes")}</label>
          <p className="rounded-lg border bg-muted/30 p-3 text-sm whitespace-pre-wrap">
            {data.notes}
          </p>
        </div>
      )}
    </div>
  );
}
