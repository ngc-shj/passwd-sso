"use client";

import { use } from "react";
import { useRouter } from "@/i18n/navigation";
import { useEffect } from "react";

export default function TeamSecurityPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = use(params);
  const router = useRouter();
  useEffect(() => { router.replace(`/admin/teams/${teamId}/security/policy`); }, [router, teamId]);
  return null;
}
