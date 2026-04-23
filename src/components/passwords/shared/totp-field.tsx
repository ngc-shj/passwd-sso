"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { TOTP, Secret } from "otpauth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyButton } from "./copy-button";
import { X, ShieldCheck, QrCode } from "lucide-react";
import { TOTP_ALGORITHM } from "@/lib/constants";
import { parseOtpauthUri } from "@/lib/ui/qr-scanner-client";
import { QRCaptureDialog } from "../dialogs/qr-capture-dialog";
import type { EntryTotp } from "@/lib/vault/entry-form-types";

export type TOTPEntry = EntryTotp;

interface TOTPFieldDisplayProps {
  mode: "display";
  totp: TOTPEntry;
  wrapCopyGetter?: (getter: () => string) => () => Promise<string>;
}

interface TOTPFieldInputProps {
  mode: "input";
  totp: TOTPEntry | null;
  onChange: (totp: TOTPEntry | null) => void;
  onRemove?: () => void;
}

type TOTPFieldProps = TOTPFieldDisplayProps | TOTPFieldInputProps;

function createTOTP(entry: TOTPEntry): TOTP {
  return new TOTP({
    secret: Secret.fromBase32(entry.secret),
    algorithm: entry.algorithm ?? TOTP_ALGORITHM.SHA1,
    digits: entry.digits ?? 6,
    period: entry.period ?? 30,
  });
}

function formatCode(code: string): string {
  const mid = Math.ceil(code.length / 2);
  return code.slice(0, mid) + " " + code.slice(mid);
}

function TOTPCodeDisplay({ totp: totpEntry, wrapCopyGetter }: { totp: TOTPEntry; wrapCopyGetter?: (getter: () => string) => () => Promise<string> }) {
  const t = useTranslations("TOTP");
  const [code, setCode] = useState("");
  const [remaining, setRemaining] = useState(0);
  const period = totpEntry.period ?? 30;

  const generateCode = useCallback(() => {
    try {
      const otp = createTOTP(totpEntry);
      setCode(otp.generate());
    } catch {
      setCode("");
    }
  }, [totpEntry]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    generateCode();
    const interval = setInterval(() => {
      const now = Math.floor(Date.now() / 1000);
      const rem = period - (now % period);
      setRemaining(rem);
      if (rem === period) {
        generateCode();
      }
    }, 1000);
    // Set initial remaining
    const now = Math.floor(Date.now() / 1000);
    setRemaining(period - (now % period));
    return () => clearInterval(interval);
  }, [generateCode, period]);

  if (!code) return null;

  const isWarning = remaining <= 5;

  return (
    <div className="space-y-1">
      <label className="text-sm text-muted-foreground flex items-center gap-1">
        <ShieldCheck className="h-3 w-3" />
        {t("authenticator")}
      </label>
      <div className="flex items-center gap-2">
        <span className="font-mono text-lg font-semibold tracking-wider">
          {formatCode(code)}
        </span>
        <span
          className={`text-sm font-mono tabular-nums ${isWarning ? "text-destructive font-semibold" : "text-muted-foreground"}`}
        >
          {remaining}s
        </span>
        <CopyButton getValue={wrapCopyGetter ? wrapCopyGetter(() => code) : () => code} />
      </div>
    </div>
  );
}

export function TOTPField(props: TOTPFieldProps) {
  const t = useTranslations("TOTP");
  const [inputValue, setInputValue] = useState(
    props.mode === "input" ? (props.totp?.secret ?? "") : ""
  );
  const [qrDialogOpen, setQrDialogOpen] = useState(false);

  // Sync input value when switching from display → input or when secret changes
  const secret = props.mode === "input" ? (props.totp?.secret ?? "") : "";
  useEffect(() => {
    if (props.mode === "input") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInputValue(secret);
    }
  }, [props.mode, secret]);

  if (props.mode === "display") {
    return <TOTPCodeDisplay totp={props.totp} wrapCopyGetter={props.wrapCopyGetter} />;
  }

  const { totp, onChange, onRemove } = props;

  const handleInputChange = (value: string) => {
    setInputValue(value);

    // Try parsing as otpauth URI
    const parsed = parseOtpauthUri(value.trim());
    if (parsed) {
      onChange(parsed);
      setInputValue(parsed.secret);
      return;
    }

    // Treat as raw base32 secret — strip spaces, dashes, dots
    const cleaned = value.trim().replace(/[\s\-_.]/g, "").toUpperCase();
    // Accept if it looks like base32 (>= 16 chars)
    if (cleaned.length >= 16) {
      onChange({ secret: cleaned });
    } else if (cleaned.length === 0 && totp) {
      onChange(null);
    }
  };

  const handleRemove = () => {
    setInputValue("");
    onChange(null);
    onRemove?.();
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Input
          value={inputValue}
          onChange={(e) => handleInputChange(e.target.value)}
          placeholder={t("inputPlaceholder")}
          className="font-mono text-sm"
          autoComplete="off"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-primary"
          onClick={() => setQrDialogOpen(true)}
          title={t("qrScan")}
        >
          <QrCode className="h-3.5 w-3.5" />
        </Button>
        {totp && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={handleRemove}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {totp && <TOTPCodeDisplay totp={totp} />}

      <QRCaptureDialog
        open={qrDialogOpen}
        onOpenChange={setQrDialogOpen}
        onTotpDetected={(detected) => {
          onChange(detected);
          setInputValue(detected.secret);
        }}
      />
    </div>
  );
}
