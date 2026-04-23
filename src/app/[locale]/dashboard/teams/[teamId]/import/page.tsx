"use client";

import { useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { TeamImportPagePanel } from "@/components/passwords/import/password-import";
import { notifyVaultDataChanged } from "@/lib/events";

export default function TeamImportPage() {
  const params = useParams<{ teamId: string }>();
  const router = useRouter();

  const handleComplete = useCallback(() => {
    notifyVaultDataChanged();
    router.refresh();
  }, [router]);

  return (
    <TeamImportPagePanel
      teamId={params.teamId}
      onComplete={handleComplete}
    />
  );
}
