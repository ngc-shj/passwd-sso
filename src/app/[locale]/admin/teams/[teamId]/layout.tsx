import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { getTeamMembership } from "@/lib/team-auth";
import { TEAM_ROLE } from "@/lib/constants";

export default async function TeamAdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  const session = await auth();
  if (!session?.user?.id) notFound();

  // Only ADMIN and OWNER can access team admin pages
  const membership = await getTeamMembership(session.user.id, teamId);
  if (!membership || (membership.role !== TEAM_ROLE.ADMIN && membership.role !== TEAM_ROLE.OWNER)) {
    notFound();
  }

  return <>{children}</>;
}
