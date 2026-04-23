import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { getTeamMembership, isTeamAdminRole } from "@/lib/auth/access/team-auth";

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
  if (!membership || !isTeamAdminRole(membership.role)) {
    notFound();
  }

  return <>{children}</>;
}
