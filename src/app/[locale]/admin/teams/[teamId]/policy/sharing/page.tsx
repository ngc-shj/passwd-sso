"use client";

import { use } from "react";
import { TeamPolicySettings } from "@/components/team/security/team-policy-settings";

export default function TeamPolicySharingPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = use(params);
  return <TeamPolicySettings teamId={teamId} section="sharing" />;
}
