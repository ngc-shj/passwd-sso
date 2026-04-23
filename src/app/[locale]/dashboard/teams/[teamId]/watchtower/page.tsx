import { auth } from "@/auth";
import { notFound } from "next/navigation";
import { WatchtowerPage } from "@/components/watchtower/watchtower-page";
import { requireTeamPermission, TeamAuthError } from "@/lib/auth/access/team-auth";
import { TEAM_PERMISSION } from "@/lib/constants";

export default async function TeamWatchtowerPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;

  const session = await auth();
  if (!session?.user?.id) {
    notFound();
  }

  try {
    await requireTeamPermission(
      session.user.id,
      teamId,
      TEAM_PERMISSION.PASSWORD_UPDATE,
    );
  } catch (error) {
    if (error instanceof TeamAuthError) {
      notFound();
    }
    throw error;
  }

  return <WatchtowerPage scope={{ type: "team", teamId }} />;
}
