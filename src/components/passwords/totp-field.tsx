"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { TOTP, Secret } from "otpauth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyButton } from "./copy-button";
import { X, ShieldCheck } from "lucide-react";
import { TOTP_ALGORITHM } from "@/lib/constants";
import type { TotpAlgorithm } from "@/lib/constants";

export interface TOTPEntry {
  secret: string;
  algorithm?: TotpAlgorithm;
  digits?: number;
  period?: number;
}

interface TOTPFieldDisplayProps {
  mode: "display";
  totp: TOTPEntry;
}

interface TOTPFieldInputProps {
  mode: "input";
  totp: TOTPEntry | null;
  onChange: (totp: TOTPEntry | null) => void;
  onRemove?: () => void;
}

type TOTPFieldProps = TOTPFieldDisplayProps | TOTPFieldInputProps;

function parseOtpauthUri(input: string): TOTPEntry | null {
  try {
    const url = new URL(input);
    if (url.protocol !== "otpauth:") return null;
    if (url.hostname !== "totp") return null;
    const secret = url.searchParams.get("secret");
    if (!secret) return null;
    return {
      secret,
      algorithm:
        (url.searchParams.get("algorithm")?.toUpperCase() as TOTPEntry["algorithm"]) ??
        undefined,
      digits: url.searchParams.has("digits")
        ? parseInt(url.searchParams.get("digits")!, 10)
        : undefined,
      period: url.searchParams.has("period")
        ? parseInt(url.searchParams.get("period")!, 10)
        : undefined,
    };
  } catch {
    return null;
  }
}

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

function TOTPCodeDisplay({ totp: totpEntry }: { totp: TOTPEntry }) {
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
        <CopyButton getValue={() => code} />
      </div>
    </div>
  );
}

export function TOTPField(props: TOTPFieldProps) {
  const t = useTranslations("TOTP");

  if (props.mode === "display") {
    return <TOTPCodeDisplay totp={props.totp} />;
  }

  const { totp, onChange, onRemove } = props;
  const [inputValue, setInputValue] = useState(totp?.secret ?? "");

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
    </div>
  );
}