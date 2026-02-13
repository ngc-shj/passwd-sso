"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { CONNECT_STATUS, type ConnectStatus } from "@/lib/constants";
import { injectExtensionToken } from "@/lib/inject-extension-token";

export function ConnectExtensionButton() {
  const t = useTranslations("Extension");
  const [status, setStatus] = useState<ConnectStatus>(CONNECT_STATUS.IDLE);

  const handleClick = async () => {
    if (status === CONNECT_STATUS.CONNECTING) return;
    setStatus(CONNECT_STATUS.CONNECTING);
    try {
      const res = await fetch("/api/extension/token", { method: "POST" });
      if (!res.ok) {
        setStatus(CONNECT_STATUS.FAILED);
        setTimeout(() => setStatus(CONNECT_STATUS.IDLE), 3000);
        return;
      }
      const json = await res.json();
      injectExtensionToken(json.token, Date.parse(json.expiresAt));
      setStatus(CONNECT_STATUS.CONNECTED);
      setTimeout(() => setStatus(CONNECT_STATUS.IDLE), 3000);
    } catch {
      setStatus(CONNECT_STATUS.FAILED);
      setTimeout(() => setStatus(CONNECT_STATUS.IDLE), 3000);
    }
  };

  const label =
    status === CONNECT_STATUS.CONNECTING
      ? t("connecting")
      : status === CONNECT_STATUS.CONNECTED
      ? t("connected")
      : status === CONNECT_STATUS.FAILED
      ? t("failed")
      : t("connect");

  return (
    <DropdownMenuItem onClick={handleClick}>
      {label}
    </DropdownMenuItem>
  );
}
