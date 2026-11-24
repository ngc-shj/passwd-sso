"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useClientSnapshot } from "@/hooks/use-client-snapshot";
import { API_PATH } from "@/lib/constants";
import { VAULT_CONFIRMATION_PHRASE } from "@/lib/constants/vault";
import { apiErrorToI18nKey } from "@/lib/http/api-error-codes";
import { readApiErrorBody } from "@/lib/http/read-api-error-body";
import { fetchApi, hardNavigate } from "@/lib/url-helpers";

const CONFIRMATION_TOKEN = VAULT_CONFIRMATION_PHRASE.DELETE_VAULT;

function readTokenFromHash(): string | null {
  if (typeof window === "undefined") return null;
  const match = window.location.hash.match(/token=([a-f0-9]{64})(?:$|&)/);
  return match ? match[1] : null;
}

export function useAdminVaultReset() {
  const locale = useLocale();
  const tApi = useTranslations("ApiErrors");

  // Captured once on the client: the effect below strips it from the URL, so
  // it cannot be re-read later. Exposed only after hydration so the first
  // client render matches the server render (which has no URL fragment).
  const [hashToken] = useState(readTokenFromHash);
  const isHydrated = useClientSnapshot(() => true, false);
  const token = isHydrated ? hashToken : null;
  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (hashToken) {
      // Remove token from URL and browser history
      history.replaceState(null, "", window.location.pathname);
    }
  }, [hashToken]);

  const isValid = confirmation === CONFIRMATION_TOKEN;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid || !token) return;

    setLoading(true);
    setError("");

    try {
      const res = await fetchApi(API_PATH.VAULT_ADMIN_RESET, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, confirmation }),
      });

      if (!res.ok) {
        const body = await readApiErrorBody(res);
        if (body?.error) {
          setError(tApi(apiErrorToI18nKey(body.error)));
        } else {
          setError(tApi("unknownError"));
        }
        return;
      }

      // Full reload to re-initialize VaultProvider
      hardNavigate(`/${locale}/dashboard`);
    } catch {
      setError(tApi("unknownError"));
    } finally {
      setLoading(false);
    }
  }

  return { token, confirmation, setConfirmation, loading, error, isValid, handleSubmit };
}
