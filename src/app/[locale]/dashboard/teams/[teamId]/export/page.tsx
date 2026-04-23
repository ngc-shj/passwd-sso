import { TeamExportPagePanel } from "@/components/team/management/team-export";

export default async function TeamExportPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  return <TeamExportPagePanel teamId={teamId} />;
}
