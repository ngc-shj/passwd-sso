"use client";

import { use } from "react";
import { useRouter } from "@/i18n/navigation";
import { useEffect } from "react";

export default function TeamMembersPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = use(params);
  const router = useRouter();
  useEffect(() => { router.replace(`/admin/teams/${teamId}/members/list`); }, [router, teamId]);
  return null;
}
