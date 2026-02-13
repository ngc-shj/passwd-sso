"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { injectExtensionToken } from "@/lib/inject-extension-token";

type Status = "idle" | "connecting" | "connected" | "failed";

export function ConnectExtensionButton() {
  const t = useTranslations("Extension");
  const [status, setStatus] = useState<Status>("idle");

  const handleClick = async () => {
    if (status === "connecting") return;
    setStatus("connecting");
    try {
      const res = await fetch("/api/extension/token", { method: "POST" });
      if (!res.ok) {
        setStatus("failed");
        setTimeout(() => setStatus("idle"), 3000);
        return;
      }
      const json = await res.json();
      injectExtensionToken(json.token, Date.parse(json.expiresAt));
      setStatus("connected");
      setTimeout(() => setStatus("idle"), 3000);
    } catch {
      setStatus("failed");
      setTimeout(() => setStatus("idle"), 3000);
    }
  };

  const label =
    status === "connecting"
      ? t("connecting")
      : status === "connected"
      ? t("connected")
      : status === "failed"
      ? t("failed")
      : t("connect");

  return (
    <DropdownMenuItem onClick={handleClick}>
      {label}
    </DropdownMenuItem>
  );
}
