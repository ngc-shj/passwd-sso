"use client";

import { useEffect, type ReactNode } from "react";
import { VAULT_STATUS } from "@/lib/constants";
import type { VaultStatus } from "@/lib/constants";
import { API_PATH, apiPath } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import { createKeyEscrow } from "./crypto-emergency";

const EA_CONFIRM_INTERVAL_MS = 2 * 60 * 1000; // check pending EA grants every 2 minutes

export async function confirmPendingEmergencyGrants(secretKey: Uint8Array, ownerId: string, keyVersion: number): Promise<void> {
  const res = await fetchApi(API_PATH.EMERGENCY_PENDING_CONFIRMATIONS);
  if (!res.ok) return;
  const grants: Array<{
    id: string;
    granteeId: string;
    granteePublicKey: string;
  }> = await res.json();

  for (const grant of grants) {
    try {
      const escrow = await createKeyEscrow(secretKey, grant.granteePublicKey, {
        grantId: grant.id,
        ownerId,
        granteeId: grant.granteeId,
        keyVersion,
      });
      await fetchApi(apiPath.emergencyConfirm(grant.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(escrow),
      });
    } catch {
      // Skip individual grant failures
    }
  }
}

interface EmergencyAccessProviderProps {
  vaultStatus: VaultStatus;
  getSecretKey: () => Uint8Array | null;
  keyVersion: number;
  userId: string | undefined;
  children: ReactNode;
}

export function EmergencyAccessProvider({
  vaultStatus,
  getSecretKey,
  keyVersion,
  userId,
  children,
}: EmergencyAccessProviderProps) {
  useEffect(() => {
    if (vaultStatus !== VAULT_STATUS.UNLOCKED || !userId) return;

    let inFlight = false;

    const run = () => {
      if (inFlight) return;
      const sk = getSecretKey();
      if (!sk) return;
      inFlight = true;
      confirmPendingEmergencyGrants(sk, userId, keyVersion)
        .catch(() => {})
        .finally(() => {
          sk.fill(0);
          inFlight = false;
        });
    };

    const intervalId = setInterval(run, EA_CONFIRM_INTERVAL_MS);

    const handleVisible = () => { if (!document.hidden) run(); };
    const handleOnline = () => run();
    document.addEventListener("visibilitychange", handleVisible);
    window.addEventListener("online", handleOnline);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisible);
      window.removeEventListener("online", handleOnline);
    };
  }, [vaultStatus, userId, getSecretKey, keyVersion]);

  return <>{children}</>;
}
