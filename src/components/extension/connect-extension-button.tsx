"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";

type Status = "idle" | "connecting" | "connected" | "failed";

function injectToken(token: string, expiresAt: number) {
  const existing = document.getElementById("passwd-sso-ext-token");
  if (existing) existing.remove();
  const el = document.createElement("div");
  el.id = "passwd-sso-ext-token";
  el.setAttribute("data-token", token);
  el.setAttribute("data-expires-at", String(expiresAt));
  el.style.display = "none";
  document.body.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 10_000);
}

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
      injectToken(json.token, Date.parse(json.expiresAt));
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
