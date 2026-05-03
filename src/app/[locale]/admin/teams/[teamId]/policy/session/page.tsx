"use client";

import { use } from "react";
import { TeamPolicySettings } from "@/components/team/security/team-policy-settings";

export default function TeamPolicySessionPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = use(params);
  return <TeamPolicySettings teamId={teamId} section="session" />;
}
