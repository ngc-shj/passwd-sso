"use client";

import { use } from "react";
import { TeamPolicySettings } from "@/components/team/team-policy-settings";

export default function TeamPolicyPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = use(params);
  return <TeamPolicySettings teamId={teamId} />;
}
